const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

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
    const server = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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

    for (const file of ["/", "/style.css", "/theme.js", "/app.js", "/socket.io/socket.io.js"]) {
        const response = await fetch(baseUrl + file);
        assert.equal(response.status, 200, file);
    }

    const versionResponse = await fetch(baseUrl + "/api/version");
    assert.equal(versionResponse.headers.get("cache-control"), "no-store");
    assert.deepEqual(await versionResponse.json(), { version: "wamda-rounds-v1", rounds: 3, questionsPerRound: 5, duration: 20 });

    async function connect() {
        const socket = io(baseUrl, { transports: ["websocket"], autoConnect: false, reconnection: false });
        clients.push(socket);
        const ready = nextEvent(socket, "connect");
        socket.connect();
        await ready;
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

    let questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
    host.emit("startGame", { code: created.code });
    const answers = [1,2,0,1,0,1,2,0,3,1,2,0,3,1,2,0,3,1,2,0,1,2,0,3,1,2,0,3,1,2];
    let finish;
    for (let round = 0; round < 15; round++) {
        const [a, b] = await questions;
        assert.deepEqual(a, b, "Both clients receive the same question");
        assert.equal(a.number, round % 5 + 1);
        assert.equal(a.duration, 20);
        assert.equal(a.round, Math.floor(round / 5) + 1);
        assert.equal(a.rounds, 3);
        assert.equal(a.total, 5);
        assert.match(a.question, /[\u0600-\u06ff]/);
        assert.equal(a.choices.length, 4);
        if (round === 0) {
            const rejected = await request(outsider, "joinRoom", { name: "Late", code: created.code });
            assert.equal(rejected.ok, false);
            assert.equal(rejected.message, "بدأت اللعبة بالفعل.");
        }

        const closed = nextEvent(host, "questionClosed");
        const answerResults = Promise.all([nextEvent(host, "answerResult"), nextEvent(guest, "answerResult")]);
        host.emit("submitAnswer", { code: created.code, questionId: round, answerIndex: answers[round] });
        // A repeated click must not score twice.
        host.emit("submitAnswer", { code: created.code, questionId: round, answerIndex: answers[round] });
        guest.emit("submitAnswer", { code: created.code, questionId: round, answerIndex: round < 2 ? answers[round] : (answers[round] + 1) % 4 });
        const [hostResult, guestResult] = await answerResults;
        assert.equal(hostResult.correct, true);
        assert.equal(guestResult.correct, round < 2);
        assert.equal(hostResult.correctIndex, answers[round]);
        await closed;
        let autoAdvanced = false;
        const onQuestion = () => { autoAdvanced = true; };
        host.on("question", onQuestion);
        guest.emit("nextQuestion", { code: created.code, questionId: round });
        await new Promise(resolve => setTimeout(resolve, round === 0 ? 1100 : 10));
        host.off("question", onQuestion);
        assert.equal(autoAdvanced, false, "No automatic or guest-controlled advancement");
        if (round === 14) {
            finish = Promise.all([nextEvent(host, "gameOver"), nextEvent(guest, "gameOver")]);
        } else if ((round + 1) % 5 === 0) {
            const results = nextEvent(host, "roundOver");
            host.emit("nextQuestion", { code: created.code, questionId: round });
            const scores = await results;
            assert.equal(scores.round, (round + 1) / 5);
            assert.equal(scores.ranking[0].score, round + 1);
            questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
            host.emit("nextRound", { code: created.code, round: scores.round });
            continue;
        } else {
            questions = Promise.all([nextEvent(host, "question"), nextEvent(guest, "question")]);
        }
        host.emit("nextQuestion", { code: created.code, questionId: round });

    }

    const [hostEnd, guestEnd] = await finish;
    assert.deepEqual(hostEnd, guestEnd);
    assert.deepEqual(hostEnd.ranking.map(player => player.score), [15, 2]);
    const promoted = nextEvent(guest, "lobbyUpdate", data => data.hostId === guest.id);
    host.disconnect();
    assert.equal((await promoted).players.length, 1);

    // The real 20-second deadline closes answers and waits for the host.
    const fresh = await request(guest, "createRoom", { name: "Timeout test" });
    const first = nextEvent(guest, "question");
    guest.emit("startGame", { code: fresh.code });
    assert.equal((await first).number, 1);
    const closed = await nextEvent(guest, "questionClosed", () => true, 23000);
    assert.equal(closed.correctIndex, 1);
    let lateResult = false;
    guest.on("answerResult", () => { lateResult = true; });
    guest.emit("submitAnswer", { code: fresh.code, questionId: 0, answerIndex: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lateResult, false);
    const second = nextEvent(guest, "question");
    guest.emit("nextQuestion", { code: fresh.code, questionId: 0 });
    assert.equal((await second).number, 2);
    guest.emit("leaveRoom");
});
