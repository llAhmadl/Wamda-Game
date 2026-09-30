const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { readLimits } = require('../lib/limits');
const { installSocketProtection } = require('../lib/socket-protection');
const ask = (s, event, payload = {}) => new Promise((resolve, reject) => s.timeout(2000).emit(event, payload, (e, r) => e ? reject(e) : resolve(r)));

async function fixture(t, config = {}, transport = 'websocket') {
    let clock = 0;
    const limits = { ...readLimits({}), ...config }, server = http.createServer();
    const io = new Server(server, { maxHttpBufferSize: limits.socketBufferBytes });
    installSocketProtection(io, limits, { now: () => clock });
    io.on('connection', socket => {
        for (const name of ['createRoom', 'joinRoom', 'submitAnswer', 'changeName', 'syncState', 'adminMutate', 'adminUploadCategoryImage']) {
            socket.on(name, (_, reply) => reply({ ok: true }));
        }
    });
    const clients = [];
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    async function connect() {
        const s = client(`http://127.0.0.1:${server.address().port}`, { transports: [transport], reconnection: false });
        clients.push(s);
        await new Promise((r, reject) => { s.once('connect', r); s.once('connect_error', reject); });
        return s;
    }
    return { connect, io, limits, advance: ms => { clock += ms; } };
}

test('per-event and aggregate flood limits reject excess calls, refill, and isolate sockets', async t => {
    const f = await fixture(t, { rateRooms: 2, rateAnswers: 2, rateTotal: 12 });
    const a = await f.connect(), b = await f.connect();
    for (const event of ['createRoom', 'joinRoom', 'submitAnswer']) {
        assert.equal((await ask(a, event)).ok, true);
        assert.equal((await ask(a, event)).ok, true);
        assert.match((await ask(a, event)).message, /طلبات كثيرة/);
        assert.equal((await ask(b, event)).ok, true);
    }
    for (let i = 0; i < 3; i++) assert.equal((await ask(a, 'syncState')).ok, true);
    assert.match((await ask(a, 'changeName')).message, /طلبات كثيرة/);
    f.advance(f.limits.rateWindowMs);
    assert.equal((await ask(a, 'createRoom')).ok, true);
});

test('oversized normal events and binary abuse are rejected without mutating handlers', async t => {
    const f = await fixture(t), s = await f.connect();
    assert.equal((await ask(s, 'changeName', { name: 'a'.repeat(9000) })).ok, false);
    assert.equal((await ask(s, 'changeName', { name: Buffer.alloc(20) })).ok, false);
    assert.equal((await ask(s, 'adminUploadCategoryImage', { data: Buffer.alloc(10) })).unauthorized, true);
    assert.equal((await ask(s, 'syncState')).ok, true);
});

for (const transport of ['polling', 'websocket']) test(`full-size authorized binary upload fits ${transport} transport`, async t => {
    const f = await fixture(t, {}, transport), s = await f.connect();
    f.io.sockets.sockets.get(s.id).data.adminUntil = Date.now() + 60000;
    assert.equal((await ask(s, 'adminUploadCategoryImage', { data: Buffer.alloc(f.limits.imageUploadBytes), type: 'image/png' })).ok, true);
    assert.equal((await ask(s, 'adminMutate', { action: 'importQuestions', questions: [{ question: 'a'.repeat(501100) }] })).ok, false);
});
