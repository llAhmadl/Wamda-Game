const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT ?? 3000);

app.get("/api/version", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: "wamda-first-correct-v2", rounds: TOTAL_ROUNDS, questionsPerRound: QUESTIONS_PER_ROUND, duration: DURATION });
});
app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res) { res.set("Cache-Control", "no-store"); }
}));

// -------------------------
// Questions
// -------------------------

const QUESTIONS_PER_ROUND = 5;
const TOTAL_ROUNDS = 3;
const DURATION = 20;
const { createQuestionStore } = require("./lib/question-store");
const { installAdmin } = require("./lib/admin");
const questionStore = createQuestionStore({ required: QUESTIONS_PER_ROUND * TOTAL_ROUNDS });


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

function cleanName(name) {

    if (typeof name !== "string") {
        return "";
    }

    return name.trim().slice(0, 20);
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

    io.to(roomCode).emit("lobbyUpdate", {
        code: roomCode,
        hostId: room.hostId,
        players: getPlayers(room)
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
    room.deadline = Date.now() + DURATION * 1000;
    for (const player of room.players.values()) player.answered = false;
    io.to(roomCode).emit("question", {
        questionId: room.questionIndex,
        number: room.questionIndex % QUESTIONS_PER_ROUND + 1,
        total: QUESTIONS_PER_ROUND,
        round: Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1,
        rounds: TOTAL_ROUNDS,
        question: question.question, choices: question.choices, duration: DURATION
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
        reason: room.winner ? "winner" : Date.now() >= room.deadline ? "timeout" : "answered"
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

    console.log("Player connected:", socket.id);

    socket.on("changeName", (payload, reply) => {
        if (typeof reply !== "function") return;
        const name = cleanName(payload?.name);
        if (!name) return reply({ ok: false, message: "أدخل اسمًا من حرف إلى 20 حرفًا." });
        socket.data.name = name;
        const room = rooms.get(socket.data.roomCode);
        if (room?.players.has(socket.id)) {
            room.players.get(socket.id).name = name;
            sendLobby(socket.data.roomCode);
        }
        reply({ ok: true, name });
    });

    // CREATE ROOM
    socket.on("createRoom", ({ name }, callback) => {

        const playerName = cleanName(name);

        if (!playerName) {

            callback({
                ok: false,
                message: "أدخل اسمك."
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
        ({ name, code }, callback) => {

            const playerName =
                cleanName(name);

            const roomCode =
                String(code || "")
                    .trim()
                    .toUpperCase();

            if (!playerName) {

                callback({
                    ok: false,
                    message: "أدخل اسمك."
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


    // START GAME
    socket.on("startGame", ({ code }) => {

        const room =
            rooms.get(code);

        if (!room) {
            return;
        }

        if (room.hostId !== socket.id || room.started) {
            return;
        }

        room.questions = questionStore.gameQuestions();
        room.started = true;

        room.questionIndex = 0;

        for (const player of room.players.values()) {

            player.score = 0;

            player.answered = false;
        }

        sendQuestion(code);
    });


    // ANSWER
    socket.on(
        "submitAnswer",
        ({ code, answerIndex, questionId }) => {

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

            if (correct) {
                player.score++;
                room.winner = { id: socket.id, name: player.name };
            }

            socket.emit("answerResult", {
                correct, correctIndex: question.correct
            });



            const everyoneAnswered =
                Array.from(
                    room.players.values()
                ).every(
                    player => player.answered
                );

            if (correct || everyoneAnswered) closeQuestion(code);
        }
    );


    socket.on("nextQuestion", ({ code, questionId }) => {
        const room = rooms.get(code);
        if (room?.hostId === socket.id && questionId === room.questionIndex) nextQuestion(code);
    });

    socket.on("nextRound", ({ code, round }) => {
        const room = rooms.get(code);
        if (room?.hostId !== socket.id || room.phase !== "roundResults" || round !== Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1) return;
        room.questionIndex++;
        sendQuestion(code);
    });

    // LEAVE ROOM
    socket.on("leaveRoom", () => {

        removePlayer(socket);
    });


    // DISCONNECT
    socket.on("disconnect", () => {

        console.log(
            "Player disconnected:",
            socket.id
        );

        removePlayer(socket);
    });
});

installAdmin(io, rooms, questionStore);

// Start server

questionStore.init().then(() => {
    server.listen(PORT, () => console.log(`وَمْضة running at http://localhost:${server.address().port}`));
}).catch(error => {
    console.error("تعذر تحميل بنك الأسئلة:", error.code || "storage error");
    process.exitCode = 1;
});
