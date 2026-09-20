const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { cleanPlayerName: cleanName } = require("./public/name-validation");
const { version: siteVersion } = require("./package.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 + 64 * 1024 });

const PORT = Number(process.env.PORT ?? 3000);

app.get("/api/site", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion });
});

app.get("/api/version", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion, rounds: TOTAL_ROUNDS, questionsPerRound: QUESTIONS_PER_ROUND, duration: DURATION });
});
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "favicon.png")));
app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res, filename) { res.set("Cache-Control", /\.(webp|svg|ttf)$/.test(filename) ? "public, max-age=3600" : "no-store"); }
}));

// -------------------------
// Questions
// -------------------------

const QUESTIONS_PER_ROUND = 10;
const TOTAL_ROUNDS = 2;
const DURATION = 20;
const { createQuestionStore } = require("./lib/question-store");
const { installAdmin } = require("./lib/admin");
const { installCategoryImages } = require("./lib/category-images");
const questionStore = createQuestionStore({ required: QUESTIONS_PER_ROUND * TOTAL_ROUNDS });
installCategoryImages(app, questionStore);


// -------------------------
// Rooms
// -------------------------

const rooms = new Map();

function generateRoomCode() {

    const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    do {

        code = "";

        for (let i = 0; i < 5; i++) {

            code += characters[
                Math.floor(Math.random() * characters.length)
            ];

        }

    } while (rooms.has(code));

    return code;
}

function getPlayers(room) {

    return Array.from(room.players.entries()).map(
        ([id, player]) => ({
            id,
            name: player.name,
            score: player.score
        })
    );
}

function sendLobby(roomCode) {

    const room = rooms.get(roomCode);

    if (!room) {
        return;
    }

    const categories = questionStore.publicCategories();
    if (!room.started) room.selectedCategoryIds = room.selectedCategoryIds.filter(id => categories.some(category => category.id === id));
    io.to(roomCode).emit("lobbyUpdate", {
        code: roomCode,
        hostId: room.hostId,
        players: getPlayers(room),
        categories,
        availableQuestionCount: questionStore.availableQuestionCount(room.selectedCategoryIds),
        selectedCategoryIds: room.selectedCategoryIds,
        scoringMode: room.scoringMode,
        phase: room.phase,
        started: room.started
    });
}

function removePlayer(socket) {

    const roomCode = socket.data.roomCode;

    if (!roomCode) {
        return;
    }

    const room = rooms.get(roomCode);

    if (!room) {
        socket.data.roomCode = null;
        return;
    }

    room.players.delete(socket.id);

    socket.leave(roomCode);

    socket.data.roomCode = null;

    if (room.players.size === 0) {

        if (room.timer) {
            clearTimeout(room.timer);
        }

        rooms.delete(roomCode);

        return;
    }

    // If the host left, pick another player
    if (room.hostId === socket.id) {

        room.hostId =
            room.players.keys().next().value;
    }

    sendLobby(roomCode);
    if (room.phase === "question" && [...room.players.values()].every(player => player.answered)) closeQuestion(roomCode);
}

function sendQuestion(roomCode) {
    const room = rooms.get(roomCode);
    const question = room.questions[room.questionIndex];
    room.phase = "question";
    room.winner = null;
    room.winners = [];
    room.deadline = Date.now() + DURATION * 1000;
    for (const player of room.players.values()) player.answered = false;
    io.to(roomCode).emit("question", {
        questionId: room.questionIndex,
        number: room.questionIndex % QUESTIONS_PER_ROUND + 1,
        total: QUESTIONS_PER_ROUND,
        round: Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1,
        rounds: TOTAL_ROUNDS,
        question: question.question, choices: question.choices, duration: DURATION,
        categoryId: question.categoryId,
        scoringMode: room.scoringMode
    });
    clearTimeout(room.timer);
    room.timer = setTimeout(() => closeQuestion(roomCode), DURATION * 1000);
}

function closeQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== "question") return;
    clearTimeout(room.timer);
    room.timer = null;
    room.phase = "review";
    io.to(roomCode).emit("questionClosed", {
        correctIndex: room.questions[room.questionIndex].correct,
        lastInRound: (room.questionIndex + 1) % QUESTIONS_PER_ROUND === 0,
        winner: room.winner,
        winners: room.winners,
        reason: room.winners.length >= room.scoringMode ? "winner" : Date.now() >= room.deadline ? "timeout" : "answered"
    });
}

function nextQuestion(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.phase !== "review") return;
    if ((room.questionIndex + 1) % QUESTIONS_PER_ROUND === 0) {
        const round = Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1;
        const final = round === TOTAL_ROUNDS;
        room.phase = final ? "finished" : "roundResults";
        room.started = !final;
        io.to(roomCode).emit(final ? "gameOver" : "roundOver", {
            round, rounds: TOTAL_ROUNDS,
            ranking: getPlayers(room).sort((a, b) => b.score - a.score)
        });
        return;
    }
    room.questionIndex++;
    sendQuestion(roomCode);
}

// -------------------------
// Socket.IO
// -------------------------

io.on("connection", (socket) => {
    const replyTo = callback => typeof callback === "function" ? callback : () => {};
    const activeRoom = () => rooms.get(socket.data.roomCode)?.started;
    const activeMessage = "لا يمكنك مغادرة الغرفة أثناء المباراة.";

    socket.on("changeName", (payload, reply) => {
        if (typeof reply !== "function") return;
        const name = cleanName(payload?.name);
        if (!name) return reply({ ok: false, message: "ادخل اسمك، مثال: مشعل" });
        socket.data.name = name;
        const room = rooms.get(socket.data.roomCode);
        if (room?.players.has(socket.id)) {
            room.players.get(socket.id).name = name;
            sendLobby(socket.data.roomCode);
        }
        reply({ ok: true, name });
    });

    // CREATE ROOM
    socket.on("createRoom", (payload, callback) => {
        callback = replyTo(callback);
        if (activeRoom()) return callback({ ok: false, message: activeMessage });
        const playerName = cleanName(payload?.name);

        if (!playerName) {

            callback({
                ok: false,
                message: "ادخل اسمك، مثال: مشعل"
            });

            return;
        }

        removePlayer(socket);

        const roomCode = generateRoomCode();

        const room = {

            hostId: socket.id,

            players: new Map(),

            started: false,
            phase: "lobby",
            selectedCategoryIds: [],
            scoringMode: 1,

            questionIndex: 0,

            timer: null
        };

        room.players.set(socket.id, {
            name: playerName,
            score: 0,
            answered: false
        });

        rooms.set(roomCode, room);

        socket.join(roomCode);

        socket.data.roomCode = roomCode;
        socket.data.name = playerName;

        callback({
            ok: true,
            code: roomCode
        });

        sendLobby(roomCode);
    });


    // JOIN ROOM
    socket.on(
        "joinRoom",
        (payload, callback) => {
            callback = replyTo(callback);
            if (activeRoom()) return callback({ ok: false, message: activeMessage });

            const playerName =
                cleanName(payload?.name);

            const roomCode =
                (typeof payload?.code === "string" ? payload.code : "")
                    .trim()
                    .toUpperCase();

            if (!playerName) {

                callback({
                    ok: false,
                    message: "ادخل اسمك، مثال: مشعل"
                });

                return;
            }

            const room =
                rooms.get(roomCode);

            if (!room) {

                callback({
                    ok: false,
                    message: "الغرفة غير موجودة."
                });

                return;
            }

            if (room.started) {

                callback({
                    ok: false,
                    message: "بدأت اللعبة بالفعل."
                });

                return;
            }

            if (socket.data.roomCode === roomCode) {
                callback({ ok: true, code: roomCode });
                sendLobby(roomCode);
                return;
            }

            removePlayer(socket);

            room.players.set(socket.id, {
                name: playerName,
                score: 0,
                answered: false
            });

            socket.join(roomCode);

            socket.data.roomCode =
                roomCode;
            socket.data.name = playerName;

            callback({
                ok: true,
                code: roomCode
            });

            sendLobby(roomCode);
        }
    );


    socket.on("updateRoomSettings", (payload, callback) => {
        callback = replyTo(callback);
        const room = rooms.get(payload?.code);
        if (!room || room.hostId !== socket.id) return callback({ ok: false, message: "المضيف فقط يستطيع تغيير إعدادات الغرفة." });
        if (room.started) return callback({ ok: false, message: "لا يمكن تغيير الإعدادات أثناء المباراة." });
        const categoryIds = payload?.categoryIds;
        const categories = questionStore.publicCategories();
        if (!Array.isArray(categoryIds) || categoryIds.length > categories.length ||
            categoryIds.some(id => typeof id !== "string" || !categories.some(category => category.id === id)) ||
            new Set(categoryIds).size !== categoryIds.length || ![1, 3, 4].includes(payload.scoringMode)) {
            return callback({ ok: false, message: "اختر تصنيفات ونظام نقاط صالحًا." });
        }
        room.selectedCategoryIds = [...categoryIds];
        room.scoringMode = payload.scoringMode;
        sendLobby(payload.code);
        callback({ ok: true });
    });

    // START GAME
    socket.on("startGame", (payload, callback) => {
        callback = replyTo(callback);
        const code = payload?.code;
        const room = rooms.get(code);
        if (!room || room.hostId !== socket.id) return callback({ ok: false, message: "المضيف فقط يستطيع بدء المباراة." });
        if (room.started) return callback({ ok: false, message: "بدأت اللعبة بالفعل." });
        if (!room.selectedCategoryIds.length) return callback({ ok: false, message: "اختر تصنيفًا واحدًا على الأقل." });
        try {
            room.questions = questionStore.gameQuestions(room.selectedCategoryIds);
        } catch (error) {
            return callback({ ok: false, message: error.message });
        }
        room.started = true;

        room.questionIndex = 0;

        for (const player of room.players.values()) {

            player.score = 0;

            player.answered = false;
        }

        sendQuestion(code);
        callback({ ok: true });
    });


    // ANSWER
    socket.on(
        "submitAnswer",
        (payload) => {
            const { code, answerIndex, questionId } = payload || {};

            const room =
                rooms.get(code);

            if (!room || room.phase !== "question") {
                return;
            }

            if (questionId !== room.questionIndex || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return;
            if (Date.now() >= room.deadline) { closeQuestion(code); return; }
            const player =
                room.players.get(socket.id);

            if (!player || player.answered) {
                return;
            }

            const question =
                room.questions[room.questionIndex];

            player.answered = true;

            const correct =
                answerIndex === question.correct;

            let awardedPoints = 0;
            let rank = null;
            if (correct && room.winners.length < room.scoringMode) {
                rank = room.winners.length + 1;
                awardedPoints = room.scoringMode !== 1 && rank === 1 ? 2 : 1;
                player.score += awardedPoints;
                room.winners.push({ id: socket.id, name: player.name, rank, awardedPoints });
                room.winner = room.winners[0];
            }

            socket.emit("answerResult", {
                correct, correctIndex: question.correct, awardedPoints, rank
            });



            const everyoneAnswered =
                Array.from(
                    room.players.values()
                ).every(
                    player => player.answered
                );

            if (room.winners.length >= room.scoringMode || everyoneAnswered) closeQuestion(code);
        }
    );


    socket.on("nextQuestion", (payload) => {
        const { code, questionId } = payload || {};
        const room = rooms.get(code);
        if (room?.hostId === socket.id && questionId === room.questionIndex) nextQuestion(code);
    });

    socket.on("nextRound", (payload) => {
        const { code, round } = payload || {};
        const room = rooms.get(code);
        if (room?.hostId !== socket.id || room.phase !== "roundResults" || round !== Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1) return;
        room.questionIndex++;
        sendQuestion(code);
    });

    // LEAVE ROOM
    socket.on("leaveRoom", (payload, callback) => {
        callback = replyTo(typeof payload === "function" ? payload : callback);
        if (activeRoom()) return callback({ ok: false, message: activeMessage });
        removePlayer(socket);
        callback({ ok: true });
    });


    // DISCONNECT
    socket.on("disconnect", () => {

        removePlayer(socket);
    });
});

installAdmin(io, rooms, questionStore, {
    onChanged() {
        for (const [code, room] of rooms) if (!room.started) sendLobby(code);
    }
});

// Start server

questionStore.init().then(() => {
    server.listen(PORT, () => console.log(`وَمْضة running at http://localhost:${server.address().port}`));
}).catch(error => {
    console.error("تعذر تحميل بنك الأسئلة:", error.code || "storage error");
    process.exitCode = 1;
});
