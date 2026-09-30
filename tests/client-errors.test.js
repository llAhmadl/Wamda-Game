const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { installMultiplayer } = require('../lib/multiplayer');
const { installAdmin } = require('../lib/admin');
const { clientError, httpErrorHandler, GENERIC_ERROR } = require('../lib/client-errors');
const ask = (s, e, data = {}) => new Promise((resolve, reject) => s.timeout(2000).emit(e, data, (error, reply) => error ? reject(error) : resolve(reply)));

test('unexpected HTTP and socket errors hide details while expected validation remains useful', async t => {
    const app = express();
    app.get('/failure', () => { throw Error('private database diagnostic'); });
    app.get('/path/:value', (_, res) => res.send('ok'));
    app.use(httpErrorHandler);
    const server = http.createServer(app), io = new Server(server), clients = [];
    const store = {
        snapshot: () => ({}),
        refresh: async () => { throw Error('private database diagnostic'); },
        mutate: async () => { throw clientError('اختر بنكًا صالحًا.'); },
        publicCategories: () => [{ id: 'test' }], availableQuestionCount: () => 20,
        gameQuestions: () => { throw Error('private database diagnostic'); }
    };
    installMultiplayer(io, new Map(), store);
    installAdmin(io, new Map(), store, { env: { ADMIN_CODE: 'test-only-credential' } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const [route, status] of [['/failure', 500], ['/path/%E0%A4%A', 400]]) {
        const response = await fetch(url + route);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { ok: false, message: GENERIC_ERROR });
    }
    const s = client(url, { transports: ['websocket'], reconnection: false }); clients.push(s);
    await new Promise(r => s.once('sessionState', r));
    assert.equal((await ask(s, 'adminLogin', { code: 'test-only-credential' })).ok, true);
    assert.deepEqual(await ask(s, 'adminRead'), { ok: false, message: GENERIC_ERROR });
    assert.equal((await ask(s, 'adminMutate')).message, 'اختر بنكًا صالحًا.');
    const { code } = await ask(s, 'createRoom', { name: 'المضيف' });
    await ask(s, 'updateRoomSettings', { code, categoryIds: ['test'], scoringMode: 1 });
    assert.deepEqual(await ask(s, 'startGame', { code }), { ok: false, message: GENERIC_ERROR });
    // Unexpected synchronous failures in any socket handler also stay private.
    store.publicCategories = () => { throw Error('private database diagnostic'); };
    assert.deepEqual(await ask(s, 'syncState'), { ok: false, message: GENERIC_ERROR });
    s.disconnect();
});
