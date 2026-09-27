const { randomBytes, randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const { cleanPlayerName: cleanName } = require('../public/name-validation');

const QUESTIONS_PER_ROUND = 10;
const TOTAL_ROUNDS = 2;
const DURATION = 20;
const HOST_GRACE_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest();

// All room mutations are synchronous. A session has exactly one current socket;
// every command checks that binding, including commands queued by a replaced socket.
function installMultiplayer(io, rooms, questionStore, {
    now = Date.now, schedule = setTimeout, cancel = clearTimeout
} = {}) {
    const sessions = new Map();
    const later = (fn, ms) => { const timer = schedule(fn, ms); timer?.unref?.(); return timer; };
    const players = room => [...room.players.values()].map(p => ({
        id: p.id, name: p.name, score: p.score, connected: Boolean(p.socketId)
    }));
    function lobby(code, room) {
        const categories = questionStore.publicCategories();
        if (!room.started) room.selectedCategoryIds = room.selectedCategoryIds.filter(id => categories.some(c => c.id === id));
        return { code, hostId: room.hostId, players: players(room), categories,
            availableQuestionCount: questionStore.availableQuestionCount(room.selectedCategoryIds),
            selectedCategoryIds: room.selectedCategoryIds, scoringMode: room.scoringMode,
            phase: room.phase, started: room.started, gameId: room.gameId };
    }
    function sendLobby(code) {
        const room = rooms.get(code);
        if (room) io.to(code).emit('lobbyUpdate', lobby(code, room));
    }
    function questionData(room) {
        const q = room.questions[room.questionIndex];
        return { gameId: room.gameId, questionId: room.questionIndex,
            number: room.questionIndex % QUESTIONS_PER_ROUND + 1, total: QUESTIONS_PER_ROUND,
            round: Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1, rounds: TOTAL_ROUNDS,
            question: q.question, choices: q.choices, categoryId: q.categoryId,
            scoringMode: room.scoringMode, winners: room.winners, duration: DURATION, deadline: room.deadline,
            serverNow: now(), remainingMs: Math.max(0, room.deadline - now()) };
    }
    function results(room) {
        return { round: Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1,
            rounds: TOTAL_ROUNDS, ranking: players(room).sort((a, b) => b.score - a.score) };
    }
    function closeQuestion(code) {
        const room = rooms.get(code);
        if (!room || room.phase !== 'question') return;
        cancel(room.timer);
        room.timer = null;
        room.phase = 'review';
        room.review = { correctIndex: room.questions[room.questionIndex].correct,
            lastInRound: (room.questionIndex + 1) % QUESTIONS_PER_ROUND === 0,
            winner: room.winners[0] || null, winners: room.winners,
            reason: room.winners.length >= room.scoringMode ? 'winner' : now() >= room.deadline ? 'timeout' : 'answered' };
        io.to(code).emit('questionClosed', room.review);
    }
    function snapshot(session) {
        const room = rooms.get(session.roomCode);
        if (!room) return null;
        if (room.phase === 'question' && now() >= room.deadline) closeQuestion(session.roomCode);
        return { ...lobby(session.roomCode, room),
            question: room.questions ? questionData(room) : null,
            answer: session.answer, review: room.phase === 'review' ? room.review : null,
            results: ['roundResults', 'finished'].includes(room.phase) ? results(room) : null };
    }
    function sendQuestion(code) {
        const room = rooms.get(code);
        room.phase = 'question';
        room.winners = [];
        room.review = null;
        room.deadline = now() + DURATION * 1000;
        for (const player of room.players.values()) player.answer = null;
        io.to(code).emit('question', questionData(room));
        cancel(room.timer);
        room.timer = later(() => closeQuestion(code), DURATION * 1000);
    }
    function nextQuestion(code) {
        const room = rooms.get(code);
        if (room.phase !== 'review') return;
        if ((room.questionIndex + 1) % QUESTIONS_PER_ROUND === 0) {
            const final = room.questionIndex + 1 === QUESTIONS_PER_ROUND * TOTAL_ROUNDS;
            room.phase = final ? 'finished' : 'roundResults';
            room.started = !final;
            io.to(code).emit(final ? 'gameOver' : 'roundOver', results(room));
        } else { room.questionIndex++; sendQuestion(code); }
    }
    function transferHost(code, departedName, notify = true) {
        const room = rooms.get(code);
        // Map insertion order is the original room join order, never reconnect order.
        const next = [...room.players.values()].find(p => p.socketId);
        if (!next) return false;
        cancel(room.hostTimer);
        room.hostTimer = null;
        room.hostDeadline = null;
        const previousHostId = room.hostId;
        room.hostId = next.id;
        sendLobby(code);
        if (notify && next.id !== previousHostId) io.to(next.socketId).emit('hostTransferred', {
            message: `${departedName} للأسف ما عاد يستجيب، والآن أنت صاحب الهوست`
        });
        return true;
    }
    function settleHost(code) {
        const room = rooms.get(code);
        if (!room || room.hostDeadline === null || now() < room.hostDeadline) return;
        transferHost(code, room.departedHostName);
    }
    function expireSession(session) {
        cancel(session.expiryTimer);
        session.expiryTimer = later(() => {
            if (!session.socketId && !session.roomCode) sessions.delete(session.id);
        }, RETENTION_MS);
    }
    function retainRoom(code) {
        const room = rooms.get(code);
        if ([...room.players.values()].some(p => p.socketId)) {
            cancel(room.expiryTimer); room.expiryTimer = null; return;
        }
        if (room.expiryTimer) return;
        room.expiryTimer = later(() => {
            cancel(room.timer); cancel(room.hostTimer);
            for (const p of room.players.values()) { cancel(p.expiryTimer); sessions.delete(p.id); }
            rooms.delete(code);
        }, RETENTION_MS);
    }
    function leave(session, socket) {
        const code = session.roomCode;
        const room = rooms.get(code);
        if (!room) return;
        room.players.delete(session.id);
        socket.leave(code);
        socket.data.roomCode = null;
        session.roomCode = null;
        session.answer = null;
        if (!room.players.size) {
            cancel(room.timer); cancel(room.hostTimer); cancel(room.expiryTimer); rooms.delete(code); return;
        }
        if (room.hostId === session.id) {
            room.departedHostName = session.name;
            room.hostDeadline = now();
            transferHost(code, session.name, false);
        }
        sendLobby(code);
        retainRoom(code);
        if (room.phase === 'question' && [...room.players.values()].every(p => p.answer)) closeQuestion(code);
    }
    function join(session, socket, code, name) {
        const room = rooms.get(code);
        session.name = name; session.score = 0; session.answer = null; session.roomCode = code;
        room.players.set(session.id, session);
        socket.data.roomCode = code; socket.data.name = name;
        socket.join(code);
        retainRoom(code);
        settleHost(code);
    }
    function roomCode() {
        let code;
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        do { code = [...randomBytes(5)].map(n => alphabet[n % alphabet.length]).join(''); } while (rooms.has(code));
        return code;
    }
    io.use((socket, next) => {
        const auth = socket.handshake.auth || {};
        let session, token;
        if (auth.playerId !== undefined || auth.reconnectToken !== undefined) {
            session = typeof auth.playerId === 'string' && sessions.get(auth.playerId);
            token = auth.reconnectToken;
            if (!session || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
                !timingSafeEqual(session.tokenHash, digest(token))) {
                const error = new Error('تعذر استعادة الجلسة.');
                error.data = { code: 'SESSION_INVALID' };
                return next(error);
            }
        } else {
            token = randomBytes(32).toString('base64url');
            session = { id: randomUUID(), tokenHash: digest(token), name: '', score: 0,
                roomCode: null, socketId: null, answer: null, expiryTimer: null };
            sessions.set(session.id, session);
            expireSession(session);
        }
        socket.data.playerId = session.id;
        // Only delivered privately to this socket, never included in room/admin data.
        socket.data.credentials = { playerId: session.id, reconnectToken: token };
        next();
    });
    io.on('connection', socket => {
        const session = sessions.get(socket.data.playerId);
        if (session.roomCode) settleHost(session.roomCode);
        const previous = io.sockets.sockets.get(session.socketId);
        session.socketId = socket.id;
        cancel(session.expiryTimer); session.expiryTimer = null;
        if (previous && previous !== socket) {
            previous.emit('sessionReplaced');
            previous.disconnect(true);
        }
        socket.data.name = session.name;
        const code = session.roomCode;
        const room = rooms.get(code);
        if (room) {
            socket.join(code); socket.data.roomCode = code; socket.data.name = session.name;
            // Resolve an elapsed grace BEFORE considering a returning host restored.
            settleHost(code);
            if (room.hostId === session.id) {
                cancel(room.hostTimer); room.hostTimer = null; room.hostDeadline = null;
            }
            retainRoom(code);
        }
        const credentials = socket.data.credentials;
        delete socket.data.credentials;
        socket.emit('sessionState', { session: credentials, name: session.name, state: snapshot(session) });
        if (room) sendLobby(code);

        const bound = () => session.socketId === socket.id && socket.connected;
        const ownRoom = code => bound() && session.roomCode === code && rooms.get(code);
        const hostRoom = code => { const r = ownRoom(code); return r && r.hostId === session.id ? r : null; };
        const replyTo = fn => typeof fn === 'function' ? fn : () => {};
        const activeMessage = 'لا يمكنك مغادرة الغرفة أثناء المباراة.';
        socket.on('syncState', (_, reply) => {
            if (bound()) replyTo(reply)({ ok: true, state: snapshot(session), name: session.name });
        });
        socket.on('changeName', (payload, reply) => {
            reply = replyTo(reply);
            if (!bound()) return;
            const name = cleanName(payload?.name);
            if (!name) return reply({ ok: false, message: 'ادخل اسمك، مثال: مشعل' });
            session.name = name; socket.data.name = name;
            sendLobby(session.roomCode); reply({ ok: true, name });
        });
        socket.on('createRoom', (payload, reply) => {
            reply = replyTo(reply);
            if (!bound()) return;
            const current = rooms.get(session.roomCode);
            if (current?.started) return reply({ ok: false, message: activeMessage });
            const name = cleanName(payload?.name);
            if (!name) return reply({ ok: false, message: 'ادخل اسمك، مثال: مشعل' });
            if (current?.phase === 'lobby') return reply({ ok: true, code: session.roomCode });
            leave(session, socket);
            const code = roomCode();
            rooms.set(code, { hostId: session.id, players: new Map(), started: false, phase: 'lobby',
                selectedCategoryIds: [], scoringMode: 1, questionIndex: 0, gameId: null,
                timer: null, hostTimer: null, hostDeadline: null, expiryTimer: null });
            join(session, socket, code, name);
            reply({ ok: true, code }); sendLobby(code);
        });
        socket.on('joinRoom', (payload, reply) => {
            reply = replyTo(reply);
            if (!bound()) return;
            const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
            if (rooms.get(session.roomCode)?.started) return reply({ ok: false, message: activeMessage });
            const name = cleanName(payload?.name);
            if (!name) return reply({ ok: false, message: 'ادخل اسمك، مثال: مشعل' });
            if (session.roomCode === code) { reply({ ok: true, code }); sendLobby(code); return; }
            const room = rooms.get(code);
            if (!room) return reply({ ok: false, message: 'الغرفة غير موجودة.' });
            if (room.started) return reply({ ok: false, message: 'بدأت اللعبة بالفعل.' });
            leave(session, socket); join(session, socket, code, name);
            reply({ ok: true, code }); sendLobby(code);
        });
        socket.on('updateRoomSettings', (payload, reply) => {
            reply = replyTo(reply);
            const room = hostRoom(payload?.code);
            if (!room) return reply({ ok: false, message: 'المضيف فقط يستطيع تغيير إعدادات الغرفة.' });
            if (room.started) return reply({ ok: false, message: 'لا يمكن تغيير الإعدادات أثناء المباراة.' });
            const ids = payload?.categoryIds, categories = questionStore.publicCategories();
            if (!Array.isArray(ids) || ids.length > categories.length || ids.some(id => typeof id !== 'string' || !categories.some(c => c.id === id)) ||
                new Set(ids).size !== ids.length || ![1, 3, 5, 7].includes(payload.scoringMode)) return reply({ ok: false, message: 'اختر تصنيفات ونظام نقاط صالحًا.' });
            room.selectedCategoryIds = [...ids]; room.scoringMode = payload.scoringMode;
            sendLobby(payload.code); reply({ ok: true });
        });
        socket.on('startGame', (payload, reply) => {
            reply = replyTo(reply);
            const room = hostRoom(payload?.code);
            if (!room) return reply({ ok: false, message: 'المضيف فقط يستطيع بدء المباراة.' });
            if (room.started || (payload.gameId ?? null) !== room.gameId) return reply({ ok: false, message: 'بدأت اللعبة بالفعل.' });
            if (!room.selectedCategoryIds.length) return reply({ ok: false, message: 'اختر تصنيفًا واحدًا على الأقل.' });
            try { room.questions = questionStore.gameQuestions(room.selectedCategoryIds); }
            catch (error) { return reply({ ok: false, message: error.message }); }
            room.gameId = randomUUID(); room.started = true; room.questionIndex = 0;
            for (const p of room.players.values()) { p.score = 0; p.answer = null; }
            sendQuestion(payload.code); reply({ ok: true });
        });
        socket.on('submitAnswer', (payload, reply) => {
            reply = replyTo(reply);
            const { code, gameId, questionId, answerIndex } = payload || {};
            const room = ownRoom(code);
            if (!room || room.gameId !== gameId || questionId !== room.questionIndex || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return reply({ ok: false });
            if (session.answer) return reply({ ok: true, answer: session.answer });
            if (room.phase !== 'question') return reply({ ok: false });
            if (now() >= room.deadline) { closeQuestion(code); return reply({ ok: false }); }
            const correct = answerIndex === room.questions[questionId].correct;
            let awardedPoints = 0, rank = null;
            if (correct && room.winners.length < room.scoringMode) {
                rank = room.winners.length + 1;
                awardedPoints = 1;
                session.score += awardedPoints;
                room.winners.push({ id: session.id, name: session.name, rank, awardedPoints });
            }
            session.answer = { answerIndex, correct, correctIndex: room.questions[questionId].correct, awardedPoints, rank };
            socket.emit('answerResult', session.answer);
            if (awardedPoints) io.to(code).emit('answerProgress', {
                gameId: room.gameId, questionId: room.questionIndex,
                scoringMode: room.scoringMode, winners: room.winners
            });
            reply({ ok: true, answer: session.answer });
            if (room.winners.length >= room.scoringMode || [...room.players.values()].every(p => p.answer)) closeQuestion(code);
        });
        socket.on('nextQuestion', payload => {
            const room = hostRoom(payload?.code);
            if (room && payload.gameId === room.gameId && payload.questionId === room.questionIndex) nextQuestion(payload.code);
        });
        socket.on('nextRound', payload => {
            const room = hostRoom(payload?.code);
            if (!room || payload.gameId !== room.gameId || room.phase !== 'roundResults' || payload.round !== Math.floor(room.questionIndex / QUESTIONS_PER_ROUND) + 1) return;
            room.questionIndex++; sendQuestion(payload.code);
        });
        socket.on('leaveRoom', (payload, reply) => {
            reply = replyTo(typeof payload === 'function' ? payload : reply);
            if (!bound()) return;
            if (rooms.get(session.roomCode)?.started) return reply({ ok: false, message: activeMessage });
            leave(session, socket); reply({ ok: true });
        });
        // The brand starts over at name entry. Persist the reset so a lost reply
        // or refresh restores the same screen, using the existing private session.
        // During a match the brand only refreshes the client; reject a reset here
        // too, including one that races with startGame before the client sees it.
        socket.on('resetSession', (_, reply) => {
            if (!bound()) return;
            if (rooms.get(session.roomCode)?.started) return replyTo(reply)({ ok: false, code: 'GAME_ACTIVE', message: activeMessage });
            leave(session, socket);
            session.score = 0;
            session.answer = null;
            session.name = '';
            socket.data.name = '';
            replyTo(reply)({ ok: true, name: '', state: null });
        });
        socket.on('disconnect', () => {
            if (session.socketId !== socket.id) return;
            session.socketId = null;
            const room = rooms.get(session.roomCode);
            if (!room) { expireSession(session); return; }
            if (room.hostId === session.id) {
                room.hostDeadline = now() + HOST_GRACE_MS;
                room.departedHostName = session.name;
                cancel(room.hostTimer);
                room.hostTimer = later(() => settleHost(session.roomCode), HOST_GRACE_MS);
            }
            sendLobby(session.roomCode); retainRoom(session.roomCode);
        });
    });
    return { sendLobby };
}
module.exports = { installMultiplayer, QUESTIONS_PER_ROUND, TOTAL_ROUNDS, DURATION, HOST_GRACE_MS, RETENTION_MS };
