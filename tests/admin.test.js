const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { io } = require('../node_modules/socket.io/client-dist/socket.io.js');

function request(socket, name, data = {}) {
    return new Promise((resolve, reject) => socket.timeout(4000).emit(name, data, (error, result) => error ? reject(error) : resolve(result)));
}

test('admin authentication, logout, connection stats, rename, validation and rate limiting', { timeout: 15000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wamda-admin-'));
    const code = 'test-only-developer-code';
    const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0', ADMIN_CODE: code, DATABASE_URL: '', RENDER: '', BANKS_FILE: path.join(dir, 'banks.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const clients = [];
    t.after(async () => { clients.forEach(s => s.disconnect()); server.kill(); await rm(dir, { recursive: true, force: true }); });
    const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Server did not start')), 5000);
        server.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/localhost:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
        server.once('error', reject);
    });
    async function connect() {
        const s = io(url, { transports: ['websocket'], reconnection: false }); clients.push(s);
        await new Promise(resolve => s.once('connect', resolve)); return s;
    }
    const admin = await connect(); const player = await connect();
    assert.equal((await request(player, 'adminRead')).unauthorized, true);
    assert.equal((await request(player, 'adminMutate', { action: 'createBank', name: 'bad' })).unauthorized, true);
    assert.equal((await request(admin, 'adminLogin', { code: 'wrong' })).ok, false);
    let state = await request(admin, 'adminLogin', { code });
    assert.equal(state.ok, true); assert.equal(state.banks.length, 1);
    assert.equal((await request(player, 'changeName', { name: 'أحمد' })).ok, true);
    const room = await request(player, 'createRoom', { name: 'أحمد' });
    assert.equal((await request(player, 'changeName', { name: 'علي' })).name, 'علي');
    const stats = (await request(admin, 'adminStats')).stats;
    assert.equal(stats.connections, 2); assert.equal(stats.rooms, 1);
    assert.deepEqual(stats.players, [{ name: 'علي', room: room.code, host: true }]);
    const invalid = await request(admin, 'adminMutate', { action: 'saveQuestion', bankId: 'default', revision: state.revision, question: {} });
    assert.equal(invalid.ok, false);
    state = await request(admin, 'adminMutate', { action: 'createBank', name: 'العائلة', revision: state.revision });
    assert.equal(state.ok, true); assert.equal(state.banks.length, 2);
    const bankId = state.banks.at(-1).id;
    for (const action of ['saveQuestion', 'deleteQuestion', 'renameBank', 'deleteBank', 'activateBank', 'importQuestions']) {
        assert.equal((await request(player, 'adminMutate', { action, bankId, revision: state.revision })).unauthorized, true);
    }
    state = await request(admin, 'adminMutate', { action: 'renameBank', bankId, name: 'بنك جديد', revision: state.revision });
    assert.equal(state.banks.at(-1).name, 'بنك جديد');
    state = await request(admin, 'adminMutate', { action: 'importQuestions', bankId, revision: state.revision,
        questions: Array.from({ length: 15 }, (_, i) => ({ question: `سؤال من البنك المفعّل ${i}`, choices: ['أ', 'ب', 'ج', 'د'], correct: 0 })) });
    state = await request(admin, 'adminMutate', { action: 'activateBank', bankId, revision: state.revision });
    assert.equal(state.activeBankId, bankId);
    const firstQuestion = new Promise(resolve => player.once('question', resolve));
    player.emit('startGame', { code: room.code });
    assert.equal((await firstQuestion).question, 'سؤال من البنك المفعّل 0');
    const protectedBank = await request(admin, 'adminMutate', { action: 'deleteBank', bankId, revision: state.revision });
    assert.equal(protectedBank.ok, false);
    state = await request(admin, 'adminMutate', { action: 'deleteBank', bankId: 'default', revision: state.revision });
    assert.equal(state.banks.length, 1);
    assert.equal((await request(admin, 'adminRead')).banks.length, 1);
    assert.equal((await request(admin, 'adminLogout')).ok, true);
    assert.equal((await request(admin, 'adminRead')).unauthorized, true);
    for (let i = 0; i < 5; i++) assert.equal((await request(player, 'adminLogin', { code: 'wrong' })).ok, false);
    assert.match((await request(player, 'adminLogin', { code })).message, /محاولات كثيرة/);
});
