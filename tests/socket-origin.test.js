const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { createOriginCheck, socketOriginOptions } = require('../lib/socket-origin');

test('origins require explicit production HTTPS origins and allow only loopback in development', () => {
    const dev = createOriginCheck({}, () => 1234);
    assert.equal(dev('http://localhost:1234'), true);
    assert.equal(dev('https://evil.example'), false);
    assert.equal(dev('null'), false);
    assert.equal(dev(undefined), true);
    for (const origin of ['', '*', 'https://*.example', 'http://site.example', 'https://site.example/path', 'https://user:pass@site.example']) {
        assert.throws(() => createOriginCheck({ NODE_ENV: 'production', ALLOWED_ORIGINS: origin }), /ALLOWED_ORIGINS/);
    }
    const prod = createOriginCheck({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://site.example,https://www.site.example/' });
    assert.equal(prod('https://www.site.example'), true);
    assert.equal(prod('https://site.example.evil.test'), false);
});

test('polling and websocket both reject an unapproved browser origin and accept the configured origin', async t => {
    const server = http.createServer();
    const io = new Server(server, socketOriginOptions(createOriginCheck({ ALLOWED_ORIGINS: 'https://site.example' })));
    const clients = [];
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const transport of ['polling', 'websocket']) {
        for (const origin of ['https://site.example', 'https://evil.example', 'null']) {
            const s = client(url, { transports: [transport], reconnection: false, extraHeaders: { Origin: origin }, timeout: 1500 });
            clients.push(s);
            const accepted = await new Promise(resolve => { s.once('connect', () => resolve(true)); s.once('connect_error', () => resolve(false)); });
            assert.equal(accepted, origin === 'https://site.example');
            s.disconnect();
        }
    }
    const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://site.example' } });
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://site.example');
    await response.text();
});
