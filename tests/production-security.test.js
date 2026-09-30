const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { once } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { io } = require('socket.io-client');
const sharp = require('sharp');
const ask = (s, event, payload = {}) => new Promise((resolve, reject) => s.timeout(2000).emit(event, payload, (e, r) => e ? reject(e) : resolve(r)));

test('production entry point composes security headers, origins, sessions and image upload', { timeout: 10000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wamda-production-')), clients = [];
    const proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'production', PORT: '0', ADMIN_CODE: 'test-code-12',
            ALLOWED_ORIGINS: 'https://wamda.test', TRUST_PROXY: 'false', DATABASE_URL: '', RENDER: '', BANKS_FILE: path.join(dir, 'banks.json') },
        stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        clients.forEach(s => s.disconnect());
        if (proc.exitCode === null && proc.signalCode === null) { const closed = once(proc, 'exit'); proc.kill(); await closed; }
        await rm(dir, { recursive: true, force: true });
    });
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Production test startup timed out')), 5000);
        proc.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/localhost:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
        proc.once('error', error => { clearTimeout(timer); reject(error); });
        proc.once('exit', () => { clearTimeout(timer); reject(Error('Production server exited before startup')); });
    });
    const response = await fetch(url + '/');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'self' wss:\/\/localhost:/);
    for (const pathname of ['/developer', '/theme.js', '/socket.io/socket.io.js', '/fonts/Tajawal-Regular.ttf']) assert.equal((await fetch(url + pathname)).status, 200);
    async function connect(origin, expected) {
        const s = io(url, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: origin } }); clients.push(s);
        const result = await new Promise(resolve => { s.once('sessionState', data => resolve(data)); s.once('connect_error', () => resolve(null)); });
        assert.equal(Boolean(result), expected); return s;
    }
    await connect('https://evil.test', false);
    const s = await connect('https://wamda.test', true);
    assert.equal((await ask(s, 'changeName', { name: 'أحمد\u202e' })).name, 'أحمد');
    assert.equal((await ask(s, 'createRoom', { name: 'أحمد' })).ok, true);
    assert.equal((await ask(s, 'adminLogin', { code: 'test-code-12' })).ok, true);
    const data = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#fff' } }).png().toBuffer();
    const uploaded = await ask(s, 'adminUploadCategoryImage', { data, type: 'image/png' });
    assert.equal(uploaded.ok, true);
    const image = await fetch(url + uploaded.image);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp');
});
