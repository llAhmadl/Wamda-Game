const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");

// Use Socket.IO's bundled client, so no new application dependency is needed.
// Native WebSocket is available in Node 22+.
const { io } = require("../node_modules/socket.io/client-dist/socket.io.js");
const root = path.resolve(__dirname, "..");

function nextEvent(socket, event, predicate = () => true, timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off(event, handler); reject(new Error("Timed out: " + event)); }, timeout);
        function handler(data) {
            if (!predicate(data)) return;
            clearTimeout(timer); socket.off(event, handler); resolve(data);
        }
        socket.on(event, handler);
    });
}

function request(socket, event, payload) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No acknowledgement: " + event)), 5000);
        socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
    });
}

test("two real clients: all questions, scores, host transfer and question timeout", { timeout: 35000 }, async t => {
    assert.ok(typeof WebSocket !== "undefined", "Run these tests with Node.js 22 or newer.");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "wamda-game-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const server = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: "0", DATABASE_URL: "", RENDER: "", BANKS_FILE: path.join(dataDir, "banks.json") }, stdio: ["ignore", "pipe", "pipe"] });
    let baseUrl;
    const clients = [];
    t.after(() => { for (const client of clients) client.disconnect(); server.kill(); });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Server did not start")), 5000);
        let errors = "";
        server.stderr.on("data", chunk => { errors += chunk; });
        server.once("error", error => { clearTimeout(timer); reject(error); });
        server.once("exit", code => { clearTimeout(timer); if (code) reject(new Error(errors || "Server exited")); });
        server.stdout.on("data", chunk => {
            if (String(chunk).includes("وَمْضة running")) { baseUrl = String(chunk).match(/http:\/\/localhost:\d+/)[0]; clearTimeout(timer); resolve(); }
        });
    });

    for (const file of ["/", "/style.css", "/theme.js", "/name-validation.js", "/app.js", "/settings.js", "/favicon.png", "/categories.css", "/images/categories/islamic.webp", "/socket.io/socket.io.js"]) {
        const response = await fetch(baseUrl + file);
        assert.equal(response.status, 200, file);
    }

    const versionResponse = await fetch(baseUrl + "/api/version");
    assert.equal(versionResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await versionResponse.json(), { version: require("../package.json").version, rounds: 2, questionsPerRound: 10, duration: 20 });
    const siteResponse = await fetch(baseUrl + "/api/site");
    assert.equal(siteResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await siteResponse.json(), { version: require("../package.json").version });

    async function connect() {
        const socket = io(baseUrl, { transports: ["websocket"], autoConnect: false, reconnection: false });
        clients.push(socket);
        const ready = nextEvent(socket, "sessionState");
        socket.connect();
        socket.playerId = (await ready).session.playerId;
        return socket;
    }

    const host = await connect();
    const guest = await connect();
    const outsider = await connect();
    assert.equal((await request(outsider, "joinRoom", { name: "Guest", code: "NOPE!" })).ok, false);
    const created = await request(host, "createRoom", { name: "أحمد" });
    assert.equal(created.ok, true);
    assert.match(created.code, /^[A-Z2-9]{5}$/);
    const lobby = nextEvent(host, "lobbyUpdate", data => data.players.length === 2);
    assert.equal((await request(guest, "joinRoom", { name: "Player two", code: created.code.toLowerCase() })).ok, true);
    assert.equal((await lobby).players.length, 2);

    assert.equal((await request(host,'startGame',{code:created.code})).ok,false);
    assert.equal((await request(guest,'updateRoomSettings',{code:created.code,categoryIds:['legacy'],scoringMode:4})).ok,false);
    assert.equal((await request(host,'updateRoomSettings',{code:created.code,categoryIds:['islamic'],scoringMode:1})).ok,true);
    assert.equal((await request(host,'startGame',{code:created.code})).ok,false);
    await request(host,'updateRoomSettings',{code:created.code,categoryIds:['legacy'],scoringMode:1});
    const seen=new Set();
    let questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
    host.emit("startGame", { code: created.code });
    const defaults=require('../lib/default-questions.json');
    let finish;
    const scoresExpected = new Map([[host.playerId, 0], [guest.playerId, 0]]);
    for (let round = 0; round < 20; round++) {
        const [a, b] = await questions;
        const correct=defaults.find(q=>q.question===a.question).correct;
        assert.ok(!seen.has(a.question));seen.add(a.question);
        assert.deepEqual(a, b, "Both clients receive the same question");
        assert.equal(a.number, round % 10 + 1);
        assert.equal(a.duration, 20);
        assert.equal(a.round, Math.floor(round / 10) + 1);
        assert.equal(a.rounds, 2);
        assert.equal(a.total, 10);
        assert.match(a.question, /[\u0600-\u06ff]/);
        assert.equal(a.choices.length, 4);
        if (round === 0) {
            const rejected = await request(outsider, "joinRoom", { name: "Late", code: created.code });
            assert.equal(rejected.ok, false);
            assert.equal(rejected.message, "بدأت اللعبة بالفعل.");
        }

        const closed = Promise.all([nextEvent(host, "questionClosed"), nextEvent(guest, "questionClosed")]);
        if (round === 0) {
            const wrong = nextEvent(guest, "answerResult");
            guest.emit("submitAnswer", { code: created.code, gameId: a.gameId, questionId: round, answerIndex: (correct + 1) % 4 });
            assert.equal((await wrong).correct, false, "A wrong answer must not award a point or end the question");
        }
        // Both clients race with a correct answer. The server must choose exactly one.
        const first = round === 1 ? guest : host;
        const second = round === 1 ? host : guest;
        first.emit("submitAnswer", { code: created.code, gameId: a.gameId, questionId: round, answerIndex: correct });
        second.emit("submitAnswer", { code: created.code, gameId: a.gameId, questionId: round, answerIndex: correct });
        first.emit("submitAnswer", { code: created.code, gameId: a.gameId, questionId: round, answerIndex: correct });
        const [hostClosed, guestClosed] = await closed;
        assert.deepEqual(hostClosed, guestClosed);
        assert.equal(hostClosed.reason, "winner");
        assert.equal(hostClosed.correctIndex, correct);
        assert.ok(scoresExpected.has(hostClosed.winner.id));
        scoresExpected.set(hostClosed.winner.id, scoresExpected.get(hostClosed.winner.id) + 1);
        let autoAdvanced = false;
        const onQuestion = () => { autoAdvanced = true; };
        host.on("question", onQuestion);
        guest.emit("nextQuestion", { code: created.code, gameId: a.gameId, questionId: round });
        await new Promise(resolve => setTimeout(resolve, round === 0 ? 1100 : 10));
        host.off("question", onQuestion);
        assert.equal(autoAdvanced, false, "No automatic or guest-controlled advancement");
        if (round === 19) {
            finish = Promise.all([nextEvent(host, "gameOver"), nextEvent(guest, "gameOver")]);
        } else if ((round + 1) % 10 === 0) {
            const results = nextEvent(host, "roundOver");
            host.emit("nextQuestion", { code: created.code, gameId: a.gameId, questionId: round });
            const scores = await results;
            assert.equal(scores.round, (round + 1) / 10);
            assert.equal(scores.ranking.reduce((sum, p) => sum + p.score, 0), round + 1);
            scores.ranking.forEach(p => assert.equal(p.score, scoresExpected.get(p.id)));
            questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
            host.emit("nextRound", { code: created.code, gameId: a.gameId, round: scores.round });
            continue;
        } else {
            questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
        }
        host.emit("nextQuestion", { code: created.code, gameId: a.gameId, questionId: round });

    }

    const [hostEnd, guestEnd] = await finish;
    assert.deepEqual(hostEnd, guestEnd);
    assert.equal(hostEnd.ranking.reduce((sum, player) => sum + player.score, 0), 20);
    hostEnd.ranking.forEach(player => assert.equal(player.score, scoresExpected.get(player.id)));
    const promoted = nextEvent(guest, "lobbyUpdate", data => data.hostId === guest.playerId);
    await request(host, "leaveRoom", {});
    host.disconnect();
    assert.equal((await promoted).players.length, 1);

    // The real 20-second deadline closes answers and waits for the host.
    const fresh = await request(guest, "createRoom", { name: "Timeout test" });
    await request(guest,'updateRoomSettings',{code:fresh.code,categoryIds:['legacy'],scoringMode:1});
    const first = nextEvent(guest, "question");
    guest.emit("startGame", { code: fresh.code });
    const firstData=await first;
    assert.equal(firstData.number, 1);
    const closed = await nextEvent(guest, "questionClosed", () => true, 23000);
    assert.equal(closed.correctIndex, defaults.find(q=>q.question===firstData.question).correct);
    let lateResult = false;
    guest.on("answerResult", () => { lateResult = true; });
    guest.emit("submitAnswer", { code: fresh.code, gameId: firstData.gameId, questionId: 0, answerIndex: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lateResult, false);
    const second = nextEvent(guest, "question");
    guest.emit("nextQuestion", { code: fresh.code, gameId: firstData.gameId, questionId: 0 });
    assert.equal((await second).number, 2);
    guest.emit("leaveRoom");
});
