const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { configureClientIp } = require('../lib/client-ip');
const { installAdmin } = require('../lib/admin');
const request = (ip, forwarded) => ({ socket: { remoteAddress: ip }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('proxy trust ignores spoofing by default and walks only the configured proxy chain', () => {
    let resolve = configureClientIp(express(), {});
    assert.equal(resolve(request('203.0.113.8', '1.2.3.4')), '203.0.113.8');
    resolve = configureClientIp(express(), { TRUST_PROXY: '10.0.0.0/8' });
    assert.equal(resolve(request('10.0.0.4', '1.2.3.4, 203.0.113.8')), '203.0.113.8');
    assert.equal(resolve(request('203.0.113.8', '1.2.3.4')), '203.0.113.8');
    assert.equal(resolve(request('10.0.0.4', 'invalid')), '10.0.0.4');
    assert.equal(resolve(request('::ffff:203.0.113.8')), '203.0.113.8');
    const hops = configureClientIp(express(), { TRUST_PROXY: '1' });
    assert.equal(hops(request('10.0.0.4', '1.2.3.4, 203.0.113.8')), '203.0.113.8');
    assert.throws(() => configureClientIp(express(), { TRUST_PROXY: 'true' }), /TRUST_PROXY/);
    assert.throws(() => configureClientIp(express(), { TRUST_PROXY: 'invalid' }), /TRUST_PROXY/);
});

test('admin lockout uses the verified client behind a trusted proxy, not a spoofed leftmost address', async t => {
    const app = express(), resolve = configureClientIp(app, { TRUST_PROXY: 'loopback' });
    const server = http.createServer(app), io = new Server(server), clients = [];
    io.use((socket, next) => { socket.data.clientIp = resolve(socket.request); next(); });
    installAdmin(io, new Map(), { snapshot: () => ({}) }, { env: { ADMIN_CODE: 'test-admin-credential' } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    async function connect(forwarded) {
        const s = client(`http://127.0.0.1:${server.address().port}`, { transports: ['websocket'], reconnection: false,
            extraHeaders: { 'X-Forwarded-For': forwarded } });
        clients.push(s);
        await new Promise((r, reject) => { s.once('connect', r); s.once('connect_error', reject); });
        return s;
    }
    const login = (s, code) => new Promise((resolve, reject) => s.timeout(2000).emit('adminLogin', { code }, (e, r) => e ? reject(e) : resolve(r)));
    const a = await connect('1.2.3.4, 203.0.113.8');
    for (let i = 0; i < 5; i++) assert.equal((await login(a, 'wrong')).ok, false);
    const spoof = await connect('5.6.7.8, 203.0.113.8');
    assert.match((await login(spoof, 'test-admin-credential')).message, /محاولات كثيرة/);
    const b = await connect('203.0.113.9');
    assert.equal((await login(b, 'test-admin-credential')).ok, true);
});
