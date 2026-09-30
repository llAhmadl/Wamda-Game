const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: client } = require('../node_modules/socket.io/client-dist/socket.io.js');
const { installMultiplayer, HOST_GRACE_MS, RETENTION_MS } = require('../lib/multiplayer');

function event(socket, name) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(name, handler); reject(Error(`Timeout: ${name}`)); }, 3000);
        function handler(data) { clearTimeout(timer); resolve(data); }
        socket.once(name, handler);
    });
}
const request = (socket, name, data = {}) => new Promise((resolve, reject) =>
    socket.timeout(3000).emit(name, data, (error, response) => error ? reject(error) : resolve(response)));

async function setup(t, options = {}) {
    let clock = 100000, sequence = 0;
    const timers = new Map(), rooms = new Map(), clients = [];
    const httpServer = http.createServer();
    const io = new Server(httpServer);
    const store = {
        publicCategories: () => [{ id: 'test', name: 'اختبار', count: 20 }],
        availableQuestionCount: () => 20,
        gameQuestions: () => Array.from({ length: 20 }, (_, i) => ({ question: `سؤال ${i}`, choices: ['أ', 'ب', 'ج', 'د'], correct: 0, categoryId: 'test' }))
    };
    installMultiplayer(io, rooms, store, {
        ...options,
        now: () => clock,
        schedule: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: clock + ms }); return id; },
        cancel: id => timers.delete(id)
    });
    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(resolve => io.close(resolve)); });
    const url = `http://127.0.0.1:${httpServer.address().port}`;
    function raw(auth = {}) {
        const s = client(url, { transports: ['websocket'], autoConnect: false, reconnection: false, auth });
        clients.push(s); return s;
    }
    async function connect(auth) {
        const s = raw(auth), ready = event(s, 'sessionState');
        s.connect(); const data = await ready; s.session = data.session; s.state = data.state;
        return s;
    }
    async function disconnect(s) {
        const serverSocket = io.sockets.sockets.get(s.id);
        if (!serverSocket) { s.disconnect(); return; }
        const done = new Promise(resolve => serverSocket.once('disconnect', resolve));
        s.disconnect(); await done;
    }
    function advance(ms, run = true) {
        const end = clock + ms;
        if (run) {
            while (true) {
                const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                clock = next[1].at; timers.delete(next[0]); next[1].fn();
            }
        }
        clock = end;
    }
    async function room(count = 3, mode = 3) {
        const group = [];
        for (let i = 0; i < count; i++) group.push(await connect());
        const created = await request(group[0], 'createRoom', { name: 'المضيف' });
        for (let i = 1; i < count; i++) await request(group[i], 'joinRoom', { code: created.code, name: `لاعب ${i}` });
        await request(group[0], 'updateRoomSettings', { code: created.code, categoryIds: ['test'], scoringMode: mode });
        return { group, code: created.code, model: rooms.get(created.code) };
    }
    async function start(host, code) {
        const q = event(host, 'question');
        assert.equal((await request(host, 'startGame', { code })).ok, true);
        return q;
    }
    return { io, rooms, timers, raw, connect, disconnect, advance, room, start };
}

const snapshot = async s => (await request(s, 'syncState')).state;
const answer = (s, code, q, index = 0, extra = {}) => request(s, 'submitAnswer', { code, gameId: q.gameId, questionId: q.questionId, answerIndex: index, ...extra });

test('refresh restores identity, points, accepted answer and live deadline; retries never score twice', async t => {
    const f = await setup(t), { group: [host, guest], code, model } = await f.room(2);
    const q = await f.start(host, code);
    const accepted = await answer(guest, code, q, 0, { points: 999, playerId: host.session.playerId, hostId: guest.session.playerId });
    assert.equal(accepted.answer.awardedPoints, 1);
    await f.disconnect(guest); f.advance(7000);
    const restored = await f.connect(guest.session);
    assert.equal(restored.session.playerId, guest.session.playerId);
    assert.equal(restored.state.players.length, 2);
    assert.equal(restored.state.players.find(p => p.id === guest.session.playerId).score, 1);
    assert.equal(restored.state.question.remainingMs, 13000);
    assert.equal(restored.state.answer.answerIndex, 0);
    assert.equal(restored.state.hostId, host.session.playerId);
    assert.deepEqual(restored.state.question.winners, model.winners);
    const retry = await answer(restored, code, q, 1);
    assert.deepEqual(retry, accepted);
    assert.equal(model.winners.length, 1);
    assert.equal(model.players.get(guest.session.playerId).score, 1);
    await f.disconnect(restored); f.advance(13000);
    const review = await f.connect(guest.session);
    assert.equal(review.state.phase, 'review');
    assert.equal(review.state.review.reason, 'timeout');
    assert.equal(review.state.question.remainingMs, 0);
    assert.deepEqual(review.state.question.winners, model.winners);
    assert.deepEqual(review.state.review.winners, model.winners);
});

test('host keeps ownership within 30 seconds; repeated failovers choose original join order and notify only successor', async t => {
    const f = await setup(t), { group: [host, first, second], code, model } = await f.room();
    const notices = [[], [], []];
    [host, first, second].forEach((s, i) => s.on('hostTransferred', d => notices[i].push(d)));
    await f.disconnect(host); f.advance(HOST_GRACE_MS - 1);
    assert.equal(model.hostId, host.session.playerId);
    let restored = await f.connect(host.session);
    assert.equal(restored.state.hostId, host.session.playerId);
    f.advance(1);
    assert.equal(model.hostId, host.session.playerId);
    await f.disconnect(restored);
    // Reconnecting the oldest guest does not send it to the back of the queue.
    await f.disconnect(first);
    const oldest = await f.connect(first.session);
    oldest.on('hostTransferred', d => notices[1].push(d));
    f.advance(HOST_GRACE_MS - 1);
    assert.equal(model.hostId, host.session.playerId);
    const promoted = event(oldest, 'hostTransferred'); f.advance(1);
    assert.equal((await promoted).message, 'المضيف للأسف ما عاد يستجيب، والآن أنت صاحب الهوست');
    assert.equal(model.hostId, first.session.playerId);
    await snapshot(second);
    assert.equal(notices[0].length, 0); assert.equal(notices[2].length, 0); assert.equal(notices[1].length, 1);
    restored = await f.connect(host.session);
    assert.equal(restored.state.hostId, first.session.playerId);
    assert.equal((await request(restored, 'startGame', { code })).ok, false);
    assert.equal((await request(restored, 'updateRoomSettings', { code, categoryIds: ['test'], scoringMode: 5 })).ok, false);
    await f.disconnect(restored); await f.disconnect(oldest);
    const promotedAgain = event(second, 'hostTransferred'); f.advance(HOST_GRACE_MS);
    await promotedAgain;
    assert.equal(model.hostId, second.session.playerId);
    assert.equal((await f.connect(first.session)).state.hostId, second.session.playerId);
});

test('elapsed grace is enforced even if timer callback is delayed; no connected candidate waits until someone returns', async t => {
    const f = await setup(t), { group: [host, guest], model } = await f.room(2);
    await f.disconnect(host); f.advance(HOST_GRACE_MS, false);
    const resumed = await f.connect(host.session);
    assert.equal(resumed.state.hostId, guest.session.playerId, 'Late host cannot beat a delayed timeout callback');
    await f.disconnect(resumed); await f.disconnect(guest);
    f.advance(HOST_GRACE_MS);
    assert.equal(model.hostId, guest.session.playerId);
    const only = await f.connect(host.session);
    assert.equal(only.state.hostId, host.session.playerId);
    assert.equal((await f.connect(guest.session)).state.hostId, host.session.playerId);
});

test('simultaneous session takeovers revoke old socket commands and cannot duplicate membership or scoring', async t => {
    const f = await setup(t), { group: [host, guest], code, model } = await f.room(2);
    const q = await f.start(host, code);
    const oldServerSocket = f.io.sockets.sockets.get(guest.id);
    const revoked = event(guest, 'sessionReplaced');
    const [one, two] = await Promise.all([f.connect(guest.session), f.connect(guest.session)]);
    await revoked;
    const currentId = model.players.get(guest.session.playerId).socketId;
    const current = [one, two].find(s => s.id === currentId);
    assert.ok(current);
    assert.equal(model.players.size, 2);
    // Simulate an already-queued event on the revoked transport.
    oldServerSocket.listeners('submitAnswer')[0]({ code, gameId: q.gameId, questionId: 0, answerIndex: 0 });
    assert.equal(model.players.get(guest.session.playerId).score, 0);
    const replies = await Promise.all(Array.from({ length: 8 }, () => answer(current, code, q)));
    assert.ok(replies.every(r => r.ok));
    assert.equal(model.players.get(guest.session.playerId).score, 1);
    assert.equal(model.winners.length, 1);
    assert.equal(model.hostId, host.session.playerId);
    const oldHost = f.io.sockets.sockets.get(host.id);
    const newHost = await f.connect(host.session);
    oldHost.listeners('nextQuestion')[0]({ code, gameId: q.gameId, questionId: 0 });
    assert.equal(model.phase, 'question');
    assert.equal(newHost.state.hostId, host.session.playerId);
    assert.equal(model.hostDeadline, null);
});

test('forged or missing credentials fail without displacing a player; snapshots keep secrets and answers private', async t => {
    const f = await setup(t), { group: [host, guest], code, model } = await f.room(2);
    assert.match(host.session.reconnectToken, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(host.session.reconnectToken, guest.session.reconnectToken);
    for (const auth of [
        { playerId: host.session.playerId },
        { playerId: host.session.playerId, reconnectToken: guest.session.reconnectToken },
        { playerId: 'unknown', reconnectToken: host.session.reconnectToken },
        { playerId: host.session.playerId, reconnectToken: {} }
    ]) {
        const attacker = f.raw(auth), rejected = event(attacker, 'connect_error');
        attacker.connect(); assert.equal((await rejected).data.code, 'SESSION_INVALID'); attacker.disconnect();
    }
    assert.equal(model.players.get(host.session.playerId).socketId, host.id);
    const q = await f.start(host, code);
    await answer(host, code, q, 1);
    const state = await snapshot(guest);
    assert.equal(state.answer, null);
    assert.equal(state.review, null);
    const json = JSON.stringify(state);
    for (const secret of ['reconnectToken', 'tokenHash', 'correctIndex', '"correct"', host.session.reconnectToken]) assert.equal(json.includes(secret), false);
    const outsider = await f.connect();
    assert.equal((await answer(outsider, code, q, 0, { playerId: host.session.playerId })).ok, false);
    outsider.emit('nextQuestion', { code, gameId: q.gameId, questionId: 0, hostId: outsider.session.playerId });
    await snapshot(outsider);
    assert.equal(model.phase, 'question');
    assert.equal(model.players.size, 2);
});

test('absence across questions, rounds and match end restores actual state; old match commands and late answers cannot score', async t => {
    const f = await setup(t), { group: [host, guest], code, model } = await f.room(2, 1);
    const initial = await f.start(host, code);
    await f.disconnect(guest);
    for (let i = 0; i < 20; i++) {
        const state = await snapshot(host), q = state.question;
        assert.equal(q.questionId, i);
        await answer(host, code, q);
        host.emit('nextQuestion', { code, gameId: q.gameId, questionId: i });
        const after = await snapshot(host);
        if (i === 4 || i === 9 || i === 19) {
            const returning = await f.connect(guest.session);
            assert.equal(returning.state.phase, after.phase);
            assert.equal(returning.state.question.questionId, after.question.questionId);
            assert.deepEqual(returning.state.results, (await snapshot(host)).results);
            assert.equal(returning.state.players.find(p => p.id === host.session.playerId).score, i + 1);
            await f.disconnect(returning);
        }
        if (i === 9) { host.emit('nextRound', { code, gameId: q.gameId, round: 1 }); await snapshot(host); }
    }
    assert.equal(model.phase, 'finished');
    const next = event(host, 'question');
    assert.equal((await request(host, 'startGame', { code, gameId: initial.gameId })).ok, true);
    const fresh = await next;
    assert.notEqual(fresh.gameId, initial.gameId);
    assert.equal((await answer(host, code, initial)).ok, false);
    host.emit('nextRound', { code, gameId: initial.gameId, round: 1 });
    host.emit('nextQuestion', { code, gameId: initial.gameId, questionId: 0 });
    await snapshot(host); assert.equal(model.questionIndex, 0);
    f.advance(20000, false);
    assert.equal((await answer(host, code, fresh)).ok, false);
    assert.equal(model.phase, 'review');
    assert.equal(model.players.get(host.session.playerId).score, 0);
});

test('all-offline rooms survive refresh/closed browsers, expire after retention, and explicit leave removes membership', async t => {
    const f = await setup(t), { group: [host, guest], code, model } = await f.room(2);
    const same = await request(host, 'createRoom', { name: 'المضيف' });
    assert.equal(same.code, code); assert.equal(f.rooms.size, 1);
    await f.disconnect(host); await f.disconnect(guest); f.advance(RETENTION_MS - 1);
    assert.ok(f.rooms.has(code));
    const returning = await f.connect(guest.session);
    f.advance(1); assert.ok(f.rooms.has(code));
    assert.equal(model.players.size, 2);
    await request(returning, 'leaveRoom');
    assert.equal(model.players.size, 1);
    const left = await f.connect(guest.session); assert.equal(left.state, null);
    f.advance(RETENTION_MS);
    assert.equal(f.rooms.has(code), false);
    const expired = f.raw(host.session), rejected = event(expired, 'connect_error');
    expired.connect(); assert.equal((await rejected).data.code, 'SESSION_INVALID');
});

test('failover during a live match and round break gives advancement only to the new host', async t => {
    const f = await setup(t), { group: [host, guest, other], code, model } = await f.room(3, 1);
    const first = await f.start(host, code);
    await f.disconnect(host); f.advance(HOST_GRACE_MS);
    assert.equal(model.phase, 'review');
    assert.equal(model.hostId, guest.session.playerId);
    const oldHost = await f.connect(host.session);
    oldHost.emit('nextQuestion', { code, gameId: first.gameId, questionId: 0 });
    await snapshot(oldHost); assert.equal(model.questionIndex, 0);
    guest.emit('nextQuestion', { code, gameId: first.gameId, questionId: 0 });
    await snapshot(guest); assert.equal(model.questionIndex, 1);
    for (let i = 1; i < 10; i++) {
        const q = (await snapshot(guest)).question;
        await answer(guest, code, q);
        guest.emit('nextQuestion', { code, gameId: q.gameId, questionId: i });
        await snapshot(guest);
    }
    assert.equal(model.phase, 'roundResults');
    await f.disconnect(oldHost); await f.disconnect(guest); f.advance(HOST_GRACE_MS);
    assert.equal(model.hostId, other.session.playerId);
    const late = await f.connect(guest.session);
    late.emit('nextRound', { code, gameId: first.gameId, round: 1 });
    await snapshot(late); assert.equal(model.phase, 'roundResults');
    other.emit('nextRound', { code, gameId: first.gameId, round: 1 });
    await snapshot(other);
    assert.equal(model.phase, 'question'); assert.equal(model.questionIndex, 10);
    assert.equal(model.players.get(guest.session.playerId).score, 9);
});

test('brand reset in lobby clears name, transfers host and survives a lost reply/refresh', async t => {
    const f = await setup(t), { group: [host, guest, other], code, model } = await f.room(3, 3);
    const notices = [];
    guest.on('hostTransferred', data => notices.push(data));
    assert.equal((await request(host, 'resetSession', { playerId: guest.session.playerId })).ok, true);
    assert.equal(model.players.size, 2);
    assert.equal(model.players.has(host.session.playerId), false);
    assert.equal(model.hostId, guest.session.playerId);
    assert.equal(model.hostDeadline, null);
    const reset = await request(host, 'syncState');
    assert.equal(reset.name, ''); assert.equal(reset.state, null);
    await f.disconnect(host);
    const refreshed = await f.connect(host.session);
    assert.equal(refreshed.state, null);
    assert.equal((await request(refreshed, 'syncState')).name, '');
    assert.equal((await request(refreshed, 'resetSession')).ok, true, 'Departure retries are harmless');
    await snapshot(guest); assert.equal(notices.length, 0, 'An explicit exit is not a host outage');
    // No acknowledgement requested: the departure still becomes the restored truth.
    other.emit('resetSession');
    const lostReply = await request(other, 'syncState');
    assert.equal(lostReply.name, ''); assert.equal(lostReply.state, null);
    assert.equal(model.players.size, 1);
    const created = await request(refreshed, 'createRoom', { name: 'بداية جديدة' });
    assert.notEqual(created.code, code);
    assert.equal(f.rooms.get(created.code).players.get(host.session.playerId).score, 0);
});

test('brand reset cannot be issued by a replaced socket; last-player departure cleans up the room and timers', async t => {
    const f = await setup(t), { group: [host], code } = await f.room(1);
    const previous = f.io.sockets.sockets.get(host.id);
    const current = await f.connect(host.session);
    previous.listeners('resetSession')[0]({}, () => assert.fail('Revoked socket must not reset'));
    assert.ok(f.rooms.has(code));
    assert.equal((await request(current, 'resetSession')).ok, true);
    assert.equal(f.rooms.has(code), false);
    assert.equal(f.timers.size, 0);
    assert.equal((await request(current, 'syncState')).name, '');
});

test('active match reset is rejected in every phase; host refresh keeps identity, score, answer and winners', async t => {
    const f = await setup(t), { group: [originalHost, guest], code, model } = await f.room(2, 3);
    const q = await f.start(originalHost, code);
    const accepted = await answer(originalHost, code, q);
    assert.equal(accepted.answer.awardedPoints, 1);
    for (const player of [originalHost, guest]) {
        const rejected = await request(player, 'resetSession', { playerId: guest.session.playerId });
        assert.deepEqual(rejected, { ok: false, code: 'GAME_ACTIVE', message: 'لا يمكنك مغادرة الغرفة أثناء المباراة.' });
    }
    const before = await request(originalHost, 'syncState');
    await f.disconnect(originalHost); f.advance(1200);
    const host = await f.connect(originalHost.session);
    assert.equal((await request(host, 'syncState')).name, 'المضيف');
    assert.equal(host.state.hostId, originalHost.session.playerId);
    assert.equal(host.state.players.length, 2);
    assert.equal(host.state.players.find(p => p.id === host.session.playerId).score, 1);
    assert.deepEqual(host.state.answer, before.state.answer);
    assert.deepEqual(host.state.question.winners, before.state.question.winners);
    assert.equal(host.state.question.remainingMs, 18800);
    assert.equal(model.hostDeadline, null);
    assert.deepEqual(await answer(host, code, q), accepted);
    for (let index = 0; index < 20; index++) {
        const current = (await snapshot(host)).question;
        if (index !== 0) await answer(host, code, current);
        await answer(guest, code, current, 1);
        assert.equal(model.phase, 'review');
        assert.equal((await request(host, 'resetSession')).code, 'GAME_ACTIVE');
        host.emit('nextQuestion', { code, gameId: current.gameId, questionId: index });
        await snapshot(host);
        if (index === 9) {
            assert.equal(model.phase, 'roundResults');
            assert.equal((await request(guest, 'resetSession')).code, 'GAME_ACTIVE');
            assert.equal(model.players.size, 2);
            host.emit('nextRound', { code, gameId: current.gameId, round: 1 });
            await snapshot(host);
        }
    }
    assert.equal(model.phase, 'finished');
    assert.equal(model.players.get(host.session.playerId).score, 20);
    assert.deepEqual((await snapshot(guest)).question.winners, model.winners);
    assert.equal((await request(host, 'resetSession')).ok, true);
    assert.equal(model.players.size, 1);
    assert.equal(model.hostId, guest.session.playerId);
    assert.equal((await request(host, 'syncState')).name, '');
    assert.equal((await request(guest, 'resetSession')).ok, true);
    assert.equal(f.rooms.has(code), false);
    assert.equal(f.timers.size, 0);
});

test('start/reset races are serialized without removing an active player or creating a ghost host', async t => {
    const f = await setup(t);
    for (const startFirst of [true, false]) {
        const { group: [host, guest], code, model } = await f.room(2, 1);
        const commands = startFirst ? ['startGame', 'resetSession'] : ['resetSession', 'startGame'];
        const responses = await Promise.all(commands.map(command => request(host, command, { code })));
        if (startFirst) {
            assert.equal(responses[0].ok, true);
            assert.equal(responses[1].code, 'GAME_ACTIVE');
            assert.equal(model.started, true);
            assert.equal(model.players.size, 2);
            assert.equal(model.hostId, host.session.playerId);
            assert.equal((await snapshot(host)).code, code);
        } else {
            assert.equal(responses[0].ok, true);
            assert.equal(responses[1].ok, false);
            assert.equal(model.started, false);
            assert.equal(model.players.size, 1);
            assert.equal(model.hostId, guest.session.playerId);
            assert.equal((await snapshot(host)), null);
        }
    }
});

test('progress broadcasts only new winners, excludes outsiders and secrets, survives refresh, and respects the deadline', async t => {
    const f = await setup(t), { group: [host, wrong, first, late], code, model } = await f.room(4, 7);
    const outsider = await f.connect(), updates = [], outsideUpdates = [];
    host.on('answerProgress', update => updates.push(update));
    outsider.on('answerProgress', update => outsideUpdates.push(update));
    const q = await f.start(host, code);
    assert.deepEqual(q.winners, []);
    await answer(wrong, code, q, 1);
    assert.deepEqual(await answer(wrong, code, q), { ok: true, answer: model.players.get(wrong.session.playerId).answer });
    await snapshot(host);
    assert.equal(updates.length, 0, 'Wrong answers and retries never fill a dashboard slot');
    assert.equal((await answer(outsider, code, q)).ok, false);
    const accepted = await Promise.all(Array.from({ length: 10 }, () => answer(first, code, q, 0, { points: 999 })));
    assert.ok(accepted.every(result => result.answer.awardedPoints === 1));
    await snapshot(host);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { gameId: q.gameId, questionId: q.questionId, scoringMode: 7,
        winners: [{ id: first.session.playerId, name: 'لاعب 2', rank: 1, awardedPoints: 1 }] });
    for (const secret of ['answerIndex', 'correctIndex', 'reconnectToken', 'tokenHash', first.session.reconnectToken]) {
        assert.equal(JSON.stringify(updates).includes(secret), false);
    }
    await f.disconnect(first);
    const restored = await f.connect(first.session);
    assert.deepEqual(restored.state.question.winners, updates[0].winners);
    assert.equal(model.players.size, 4);
    await answer(restored, code, q);
    f.advance(19999, false);
    assert.equal((await answer(host, code, q)).answer.awardedPoints, 1);
    f.advance(1, false);
    assert.equal((await answer(late, code, q)).ok, false);
    await snapshot(host); await snapshot(outsider);
    assert.equal(updates.length, 2, 'No duplicate progress from retries/reconnect or a late answer');
    assert.equal(outsideUpdates.length, 0);
    assert.equal(model.phase, 'review');
    assert.equal(model.review.reason, 'timeout');
    assert.equal(model.winners.length, 2, 'A small room does not need seven winners to finish on timeout');
    assert.equal([...model.players.values()].reduce((sum, player) => sum + player.score, 0), 2);
    assert.deepEqual((await snapshot(late)).question.winners, updates[1].winners);
});


test('room, player and retained-session capacity cannot be bypassed; reconnect still works at capacity', async t => {
    const { readLimits } = require('../lib/limits');
    const f = await setup(t, { limits: { ...readLimits({}), rooms: 1, playersPerRoom: 2, sessions: 3 } });
    const { group: [host, guest], code, model } = await f.room(2);
    const third = await f.connect();
    assert.match((await request(third, 'createRoom', { name: 'لاعب' })).message, /الغرف/);
    assert.match((await request(third, 'joinRoom', { code, name: 'لاعب' })).message, /مكتملة/);
    assert.equal(model.players.size, 2);
    assert.equal((await request(host, 'createRoom', { name: 'المضيف' })).code, code);
    await f.disconnect(guest);
    const restored = await f.connect(guest.session);
    assert.equal(restored.state.players.length, 2);
    const extra = f.raw(), denied = event(extra, 'connect_error');
    extra.connect(); assert.match((await denied).message, /مشغول/); extra.disconnect();
    assert.equal((await request(restored, 'leaveRoom')).ok, true);
    assert.equal((await request(third, 'joinRoom', { code, name: 'لاعب' })).ok, true);
});


test('all player name entry points sanitize before storing and broadcasting', async t => {
    const f = await setup(t), host = await f.connect(), guest = await f.connect();
    const created = await request(host, 'createRoom', { name: '\u202eأحمد\u200b  علي\u2069' });
    assert.equal(created.ok, true);
    assert.equal((await snapshot(host)).players[0].name, 'أحمد علي');
    assert.equal((await request(guest, 'joinRoom', { code: created.code, name: '  خالد\n\t حسن\u200f ' })).ok, true);
    assert.equal((await snapshot(host)).players[1].name, 'خالد حسن');
    assert.equal((await request(guest, 'changeName', { name: 'مشعل\u0000\u2066' })).name, 'مشعل');
    for (const event of ['createRoom', 'joinRoom', 'changeName']) {
        assert.equal((await request(guest, event, { code: created.code, name: '\u200b١٢٣\u202e' })).ok, false);
        assert.equal((await snapshot(host)).players[1].name, 'مشعل');
    }
});
