const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { installAdmin } = require('../lib/admin');
const ask = (s, event, payload = {}) => new Promise((resolve, reject) => s.timeout(2000).emit(event, payload, (e, r) => e ? reject(e) : resolve(r)));

test('every administrative action rejects forged, expired, logged-out and reconnected sessions', async t => {
    const server = http.createServer(), io = new Server(server), clients = [];
    let writes = 0;
    const store = { snapshot: () => ({}), refresh: async () => ({}),
        mutate: async () => { writes++; return {}; }, uploadCategoryImage: async () => { writes++; return {}; } };
    installAdmin(io, new Map(), store, { env: { ADMIN_CODE: 'test-only-admin-code' } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    async function connect() {
        const s = client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], reconnection: false }); clients.push(s);
        await new Promise((r, reject) => { s.once('connect', r); s.once('connect_error', reject); }); return s;
    }
    const protectedEvents = ['adminRead', 'adminStats', 'adminMutate', 'adminUploadCategoryImage', 'adminLogout'];
    async function assertDenied(s) {
        for (const event of protectedEvents) {
            assert.equal((await ask(s, event, { admin: true, adminUntil: Date.now() + 99999999, code: 'test-only-admin-code' })).unauthorized, true);
        }
    }
    const s = await connect(); await assertDenied(s);
    assert.equal((await ask(s, 'adminLogin', { code: 'test-only-admin-code' })).ok, true);
    const ss = io.sockets.sockets.get(s.id);
    assert.ok(ss.data.adminUntil > Date.now() + 3590000 && ss.data.adminUntil <= Date.now() + 3600000);
    assert.equal((await ask(s, 'adminRead')).ok, true);
    assert.equal((await ask(s, 'adminLogout')).ok, true); await assertDenied(s);
    await ask(s, 'adminLogin', { code: 'test-only-admin-code' });
    ss.data.adminUntil = Date.now() - 1; await assertDenied(s);
    await ask(s, 'adminLogin', { code: 'test-only-admin-code' });
    s.disconnect(); await assertDenied(await connect());
    assert.equal(writes, 0);
});
