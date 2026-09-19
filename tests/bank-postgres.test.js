const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PGlite } = require('@electric-sql/pglite');
const { createQuestionStore } = require('../lib/question-store');

// PGlite runs real PostgreSQL SQL locally; it never connects to Supabase.
test('PostgreSQL migration, CRUD, permissions, conflict protection and restart persistence', { timeout: 30000 }, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wamda-postgres-'));
    let db = new PGlite(path.join(dir, 'database'));
    t.after(async () => { await db.close(); await rm(dir, { recursive: true, force: true }); });
    const migration = await readFile(path.join(__dirname, '../migrations/001_wamda_banks.sql'), 'utf8');
    function newStore() {
        return createQuestionStore({ required: 15, env: { DATABASE_URL: 'local-test-adapter', RENDER: 'true' },
            logger: { info() {}, error() {} },
            connect: async () => ({ query: (sql, values) => db.query(sql, values), end: async () => {} }) });
    }
    const missing = newStore(); await missing.init();
    assert.equal(missing.snapshot().writable, false);
    assert.equal((await db.query("SELECT to_regclass('public.wamda_banks') AS name")).rows[0].name, null);
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    await db.exec(migration);
    const store = newStore(); await store.init();
    let state = store.snapshot();
    assert.equal(state.writable, true);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM public.wamda_banks')).rows[0].count, 1);
    const originalGame = store.gameQuestions();
    async function mutate(payload) { state = await store.mutate({ ...payload, revision: state.revision }); return state; }
    // Deleting a bundled default question must survive refresh and a new store.
    await mutate({ action: 'deleteQuestion', bankId: 'default', questionId: 'default-0' });
    state = await store.refresh();
    assert.equal(state.banks[0].questions.some(q => q.id === 'default-0'), false);
    const afterDelete = newStore(); await afterDelete.init();
    assert.equal(afterDelete.snapshot().banks[0].questions.some(q => q.id === 'default-0'), false);
    await mutate({ action: 'createBank', name: 'العائلة' });
    const bankId = state.banks.at(-1).id;
    await mutate({ action: 'renameBank', bankId, name: 'تحدي العائلة' });
    await assert.rejects(mutate({ action: 'activateBank', bankId }), /15/);
    const questions = Array.from({ length: 15 }, (_, i) => ({ question: `سؤال جديد ${i}`, choices: ['الأول', 'الثاني', 'الثالث', 'الرابع'], correct: 0 }));
    await mutate({ action: 'importQuestions', bankId, questions });
    await mutate({ action: 'saveQuestion', bankId, question: { ...questions[0], question: 'سؤال إضافي' } });
    const added = state.banks.find(b => b.id === bankId).questions[0];
    await mutate({ action: 'saveQuestion', bankId, questionId: added.id, question: { ...added, question: 'سؤال معدّل', correct: 2 } });
    await mutate({ action: 'activateBank', bankId });
    assert.equal(store.gameQuestions()[0].question, 'سؤال معدّل');
    assert.equal(store.gameQuestions()[0].correct, 2);
    assert.notEqual(originalGame[0].question, store.gameQuestions()[0].question);
    await assert.rejects(mutate({ action: 'deleteBank', bankId }), /فعّل بنكًا آخر/);
    await mutate({ action: 'deleteQuestion', bankId, questionId: added.id });
    await assert.rejects(mutate({ action: 'deleteQuestion', bankId, questionId: state.banks.at(-1).questions[0].id }), /15/);
    // All remaining defaults may be deleted once another bank is active.
    for (const question of state.banks.find(b => b.id === 'default').questions) {
        await mutate({ action: 'deleteQuestion', bankId: 'default', questionId: question.id });
    }
    await db.close();
    db = new PGlite(path.join(dir, 'database'));
    const afterRestart = newStore(); await afterRestart.init();
    assert.equal(afterRestart.snapshot().banks.find(b => b.id === 'default').questions.length, 0);
    assert.equal(afterRestart.snapshot().activeBankId, bankId);
    await mutate({ action: 'deleteBank', bankId: 'default' });
    // An independently-running store cannot overwrite a newer database revision.
    const staleStore = newStore(); await staleStore.init();
    const staleRevision = staleStore.snapshot().revision;
    await mutate({ action: 'renameBank', bankId, name: 'اسم أحدث' });
    await assert.rejects(staleStore.mutate({ action: 'renameBank', bankId, name: 'اسم قديم', revision: staleRevision }), /جلسة أخرى/);
    assert.equal((await staleStore.refresh()).banks[0].name, 'اسم أحدث');
    // Real SQL write failure must not update the in-memory or persisted bank.
    await db.exec("CREATE FUNCTION reject_test_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_write BEFORE UPDATE ON public.wamda_banks FOR EACH ROW EXECUTE FUNCTION reject_test_write();");
    const before = store.snapshot();
    await assert.rejects(mutate({ action: 'renameBank', bankId, name: 'لن يُحفظ' }), /تعذر تأكيد الحفظ/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal((await db.query('SELECT data FROM public.wamda_banks WHERE id = 1')).rows[0].data.banks[0].name, 'اسم أحدث');
    await db.exec('DROP TRIGGER reject_write ON public.wamda_banks; DROP FUNCTION reject_test_write();');
    // Re-running migration is safe and public Supabase roles remain blocked.
    await db.exec(migration);
    for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(db.query('SELECT data FROM public.wamda_banks'), error => error.code === '42501');
        await assert.rejects(db.query("UPDATE public.wamda_banks SET data = '{}'::jsonb"), error => error.code === '42501');
        await db.exec('RESET ROLE');
    }
    await db.close();
    db = new PGlite(path.join(dir, 'database'));
    const restarted = newStore(); await restarted.init();
    assert.equal(restarted.snapshot().activeBankId, bankId);
    assert.equal(restarted.snapshot().banks[0].name, 'اسم أحدث');
    assert.equal(restarted.gameQuestions()[0].question, 'سؤال جديد 0');
    assert.equal(restarted.snapshot().revision, before.revision);
});
