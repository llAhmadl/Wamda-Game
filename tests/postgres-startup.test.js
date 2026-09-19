const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('real pg connection failure logs safely while HTTP and Socket.IO still start', { timeout: 15000 }, async t => {
    // Closed loopback port: this does not contact any real database.
    const connection = 'postgresql://127.0.0.1:1/postgres';
    const server = spawn(process.execPath, ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', RENDER: 'true', DATABASE_URL: connection, BANKS_FILE: '', ADMIN_CODE: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(() => server.kill());
    let logs = '';
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Server did not start')), 12000);
        server.stderr.on('data', chunk => { logs += String(chunk); });
        server.stdout.on('data', chunk => {
            logs += String(chunk);
            const match = String(chunk).match(/http:\/\/localhost:\d+/);
            if (match) { clearTimeout(timer); resolve(match[0]); }
        });
        server.once('error', error => { clearTimeout(timer); reject(error); });
        server.once('exit', () => { clearTimeout(timer); reject(Error('Server exited before startup')); });
    });
    assert.match(logs, /\[PostgreSQL\] Connection failed/);
    assert.ok(!logs.includes(connection));
    assert.ok(!logs.includes('127.0.0.1:1'));
    for (const route of ['/', '/api/version', '/socket.io/socket.io.js']) {
        assert.equal((await fetch(url + route)).status, 200);
    }
});
