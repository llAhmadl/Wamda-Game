const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { io: client } = require('socket.io-client');
const { readLimits } = require('../lib/limits');
const { configureClientIp } = require('../lib/client-ip');
const { createConnectionGate } = require('../lib/connection-limits');

test('connection limits count pending/active transports by trusted IP and release disconnected slots', async t => {
    const server = http.createServer(), clients = [];
    const gate = createConnectionGate({ ...readLimits({}), connections: 2, connectionsPerIp: 1 }, configureClientIp(express(), { TRUST_PROXY: 'loopback' }));
    const io = new Server(server, { allowRequest: gate.allowRequest });
    gate.install(io.engine);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { clients.forEach(s => s.disconnect()); await new Promise(r => io.close(r)); });
    async function connect(ip, transport = 'websocket') {
        const s = client(`http://127.0.0.1:${server.address().port}`, { transports: [transport], reconnection: false, timeout: 1000, extraHeaders: { 'X-Forwarded-For': ip } });
        clients.push(s);
        const ok = await new Promise(r => { s.once('connect', () => r(true)); s.once('connect_error', () => r(false)); });
        return { s, ok };
    }
    const first = await connect('203.0.113.1'); assert.equal(first.ok, true);
    assert.equal((await connect('1.2.3.4, 203.0.113.1')).ok, false);
    const second = await connect('203.0.113.2', 'polling'); assert.equal(second.ok, true);
    assert.equal((await connect('203.0.113.3')).ok, false);
    const closed = new Promise(r => io.sockets.sockets.get(first.s.id).conn.once('close', r));
    first.s.disconnect(); await closed;
    assert.equal((await connect('203.0.113.1')).ok, true);
});

test('security limits reject malformed, zero and excessive values instead of disabling protection', () => {
    for (const value of ['0', '-1', 'NaN', '1.5', '100001']) assert.throws(() => readLimits({ MAX_ROOMS: value }), /MAX_ROOMS/);
    assert.equal(readLimits({ MAX_ROOMS: '2' }).rooms, 2);
});
