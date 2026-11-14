const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { createQuestionStore } = require('../lib/question-store');
const { createCategoryImageStore } = require('../lib/category-images');

const question = i => ({ question: `سؤال ${i}`, choices: ['أ', 'ب', 'ج', 'د'], correct: 0, categoryId: 'legacy' });
test('server rejects oversized or invalid imports atomically before adding them to the storage queue', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wamda-import-'));
    const store = createQuestionStore({ required: 20, env: { BANKS_FILE: path.join(dir, 'banks.json') } });
    t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
    await store.init();
    const before = store.snapshot();
    const payload = { action: 'importQuestions', bankId: 'default', revision: before.revision };
    for (const questions of [[], Array.from({ length: 501 }, (_, i) => question(i)), [{ ...question(1), padding: 'x'.repeat(500001) }],
        [{ ...question(1), correct: 4 }], [{ ...question(1), choices: ['أ', 'أ', 'ج', 'د'] }], [{ ...question(1), categoryId: 'missing' }]]) {
        await assert.rejects(store.mutate({ ...payload, questions }));
        assert.deepEqual(store.snapshot(), before);
    }
    for (const invalid of [null, [], 'import']) await assert.rejects(store.mutate(invalid));
    const after = await store.mutate({ ...payload, questions: [question(1)] });
    assert.equal(after.revision, before.revision + 1);
});

test('image concurrency is bounded across admin sockets and capacity is released after success or failure', async () => {
    let finishWrite;
    const write = new Promise(resolve => { finishWrite = resolve; });
    const imageStore = createCategoryImageStore({ filename: '/tmp/unused-wamda-images/banks.json',
        env: { DATABASE_URL: 'test-only', MAX_CONCURRENT_IMAGE_UPLOADS: '1', IMAGE_UPLOAD_MAX_BYTES: '10000' },
        canWrite: () => true, getPool: () => ({ query: async sql => { if (sql.startsWith('INSERT')) await write; return { rows: [] }; } }) });
    await imageStore.init();
    const data = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#fff' } }).png().toBuffer();
    const first = imageStore.upload({ data, type: 'image/png' });
    await assert.rejects(imageStore.upload({ data, type: 'image/png' }), /مشغول/);
    finishWrite(); await first;
    await assert.rejects(imageStore.upload({ data: Buffer.alloc(10001), type: 'image/png' }));
    await assert.rejects(imageStore.upload(null));
    assert.match((await imageStore.upload({ data, type: 'image/png' })).image, /^\/category-images\//);
});
