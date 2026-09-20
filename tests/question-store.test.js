const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQuestionStore } = require('../lib/question-store');
const question = { question: 'ما عاصمة السعودية؟', choices: ['الرياض', 'جدة', 'أبها', 'الدمام'], correct: 0, categoryId: 'legacy' };

test('banks persist, validate, activate and preserve running game snapshots', async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wamda-bank-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const options = { required: 20, env: { BANKS_FILE: path.join(dir, 'banks.json') } };
    const store = createQuestionStore(options); await store.init();
    const game = store.gameQuestions(['legacy']);
    let snapshot = store.snapshot();
    const mutate = async payload => { snapshot = await store.mutate({ ...payload, revision: snapshot.revision }); return snapshot; };
    await assert.rejects(mutate({ action: 'saveQuestion', bankId: 'default', question: { ...question, correct: 4 } }));
    await mutate({ action: 'saveQuestion', bankId: 'default', questionId: 'default-0', question });
    assert.notEqual(game.find(q=>q.id==='default-0')?.question, question.question, 'Existing match is immutable');
    assert.equal(store.snapshot().banks[0].questions.find(q=>q.id==='default-0').question, question.question);
    await assert.rejects(store.mutate({ action: 'createBank', name: 'قديم', revision: 0 }), /جلسة أخرى/);
    await mutate({ action: 'createBank', name: 'بنك العائلة' });
    const bankId = snapshot.banks.at(-1).id;
    await assert.rejects(mutate({action:'activateBank',bankId}),/20/);
    await mutate({ action: 'importQuestions', bankId, questions: Array.from({ length: 20 }, (_, i) => ({ ...question, question: `سؤال ${i}` })) });
    await mutate({ action: 'activateBank', bankId });
    await mutate({ action: 'saveQuestion', bankId, question: {...question, question:'سؤال إضافي'} });
    await mutate({ action: 'deleteQuestion', bankId, questionId: snapshot.banks.at(-1).questions[0].id });
    const reloaded = createQuestionStore(options); await reloaded.init();
    assert.deepEqual(reloaded.snapshot(), store.snapshot());
    assert.equal(reloaded.gameQuestions(['legacy']).length, 20);
    assert.equal(new Set(reloaded.gameQuestions(['legacy']).map(q=>q.id)).size,20);
});

test('Render without persistent storage is read-only', async () => {
    const store = createQuestionStore({ required: 20, env: { RENDER: 'true' } });
    await store.init();
    assert.equal(store.snapshot().writable, false);
    await assert.rejects(store.mutate({ action: 'createBank', name: 'لن يضيع', revision: 0 }), /DATABASE_URL/);
    assert.equal(store.gameQuestions(['legacy']).length, 20);
});

test('an empty PostgreSQL database needs no tables for gameplay and is never seeded', async () => {
    const queries = [];
    const store = createQuestionStore({
        required: 20, env: { DATABASE_URL: 'test-only-connection', RENDER: 'true' },
        logger: { info() {}, error() {} },
        connect: async () => ({
            async query(sql) { queries.push(sql); throw Object.assign(Error('missing table'), { code: '42P01' }); },
            async end() {}
        })
    });
    await store.init();
    assert.equal(store.gameQuestions(['legacy']).length, 20);
    assert.equal(store.snapshot().writable, false);
    await assert.rejects(store.mutate({ action: 'createBank', name: 'بنك', revision: 0 }));
    assert.deepEqual(queries, ['SELECT data FROM public.wamda_banks WHERE id = 1']);
    await store.close();
});

test('existing PostgreSQL question data stays available without schema changes', async () => {
    const seed = createQuestionStore({ required: 20, env: { RENDER: 'true' } });
    await seed.init();
    const data = seed.snapshot();
    data.banks[0].questions[0].question = 'سؤال محفوظ سابقًا';
    const queries = [];
    const store = createQuestionStore({
        required: 20, env: { DATABASE_URL: 'test-only-connection' },
        connect: async () => ({ async query(sql) { queries.push(sql); return { rows: [{ data }] }; }, async end() {} })
    });
    await store.init();
    assert.equal(store.snapshot().banks[0].questions[0].question, 'سؤال محفوظ سابقًا');
    assert.equal(store.snapshot().writable, true);
    assert.deepEqual(queries, ['SELECT data FROM public.wamda_banks WHERE id = 1', 'SELECT id FROM public.wamda_category_images LIMIT 0']);
    await store.close();
});

test('unavailable PostgreSQL does not stop gameplay or write to temporary storage', async () => {
    const store = createQuestionStore({ required: 20, env: { DATABASE_URL: 'test-only-connection', RENDER: 'true' }, connect: async () => null });
    await store.init();
    assert.equal(store.gameQuestions(['legacy']).length, 20);
    assert.equal(store.snapshot().writable, false);
    await assert.rejects(store.mutate({ action: 'createBank', name: 'بنك', revision: 0 }));
});
