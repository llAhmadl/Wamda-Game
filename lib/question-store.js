const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const defaults = require('./default-questions.json');
const { connectPostgres } = require('./postgres');

function questionValue(value) {
    if (!value || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 300 ||
        !Array.isArray(value.choices) || value.choices.length !== 4 ||
        value.choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 160) ||
        new Set(value.choices.map(choice => choice.trim())).size !== 4 ||
        !Number.isInteger(value.correct) || value.correct < 0 || value.correct > 3) {
        throw Error('أدخل سؤالًا وأربعة خيارات مختلفة، وحدّد الإجابة الصحيحة.');
    }
    return { question: value.question.trim(), choices: value.choices.map(choice => choice.trim()), correct: value.correct };
}

function createQuestionStore({ required, env = process.env, connect = connectPostgres, logger = console }) {
    let state;
    let pool;
    let queue = Promise.resolve();
    const filename = env.BANKS_FILE || path.join(__dirname, '../data/banks.json');
    let writable = !env.DATABASE_URL && Boolean(env.BANKS_FILE || !env.RENDER);
    let storage = env.DATABASE_URL ? 'قاعدة بيانات' : env.BANKS_FILE ? 'ملف على القرص المحدد' : env.RENDER ? 'القراءة فقط — اربط قاعدة بيانات لحفظ التعديلات' : 'ملف محلي';
    function validate(data) {
        if (!data || !Array.isArray(data.banks) || !data.banks.length || data.banks.length > 50) throw Error('بنك أسئلة غير صالح.');
        const ids = new Set();
        for (const bank of data.banks) {
            if (typeof bank.id !== 'string' || ids.has(bank.id) || typeof bank.name !== 'string' || !bank.name.trim() || bank.name.length > 60 || !Array.isArray(bank.questions) || bank.questions.length > 1000) throw Error('بنك أسئلة غير صالح.');
            ids.add(bank.id);
            const questionIds = new Set();
            for (const question of bank.questions) {
                questionValue(question);
                if (typeof question.id !== 'string' || questionIds.has(question.id)) throw Error('معرّف سؤال غير صالح.');
                questionIds.add(question.id);
            }
        }
        if (!data.banks.some(bank => bank.id === data.activeBankId && bank.questions.length >= required)) throw Error(`البنك المستخدم للعب يحتاج ${required} سؤالًا على الأقل.`);
    }
    async function save(data) {
        if (pool) {
            await pool.query('INSERT INTO wamda_banks (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data', [JSON.stringify(data)]);
        } else {
            await fs.mkdir(path.dirname(filename), { recursive: true });
            const temp = `${filename}.${randomUUID()}.tmp`;
            try { await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(temp, filename); }
            finally { await fs.rm(temp, { force: true }); }
        }
    }
    return {
        async init() {
            if (env.DATABASE_URL) {
                pool = await connect({ env, logger });
                if (pool) {
                    try {
                        // Read an existing bank only. Schema creation is a separate, explicit step.
                        const result = await pool.query('SELECT data FROM wamda_banks WHERE id = 1');
                        state = result.rows[0]?.data;
                        writable = true;
                    } catch (error) {
                        if (error.code === '42P01') {
                            logger.info('[PostgreSQL] Question-bank table is absent. No tables were created; using default questions.');
                        } else {
                            logger.error('[PostgreSQL] Question-bank read failed. Using default questions in read-only mode.');
                        }
                        storage = 'القراءة فقط — مخزن الأسئلة غير جاهز';
                    }
                } else {
                    storage = 'القراءة فقط — تعذر الاتصال بقاعدة البيانات';
                }
            } else if (writable) {
                try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (!state) {
                state = { revision: 0, activeBankId: 'default', banks: [{ id: 'default', name: 'بنك وَمْضة', questions: defaults.map((q, i) => ({ ...q, id: `default-${i}` })) }] };
                if (writable && !env.DATABASE_URL) await save(state);
            }
            validate(state);
        },
        snapshot() { return { ...structuredClone(state), writable, storage, required }; },
        gameQuestions() {
            return structuredClone(state.banks.find(bank => bank.id === state.activeBankId).questions.slice(0, required));
        },
        mutate(payload) {
            const operation = queue.then(async () => {
                if (!writable) throw Error('حفظ الأسئلة غير جاهز. تحقق من DATABASE_URL وتجهيز مخزن الأسئلة، أو استخدم قرصًا دائمًا عبر BANKS_FILE.');
                if (payload.revision !== state.revision) throw Error('تغير البنك في جلسة أخرى. حدّث القائمة وأعد المحاولة.');
                const draft = structuredClone(state);
                const bank = draft.banks.find(item => item.id === payload.bankId);
                switch (payload.action) {
                    case 'createBank': {
                        if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) throw Error('أدخل اسم البنك، بحد أقصى 60 حرفًا.');
                        draft.banks.push({ id: randomUUID(), name: payload.name.trim(), questions: [] });
                        break;
                    }
                    case 'activateBank':
                        if (!bank || bank.questions.length < required) throw Error(`أضف ${required} سؤالًا على الأقل قبل تفعيل البنك.`);
                        draft.activeBankId = bank.id;
                        break;
                    case 'saveQuestion': {
                        if (!bank) throw Error('البنك غير موجود.');
                        const question = questionValue(payload.question);
                        const index = bank.questions.findIndex(q => q.id === payload.questionId);
                        if (payload.questionId && index < 0) throw Error('السؤال غير موجود.');
                        if (index >= 0) bank.questions[index] = { ...question, id: payload.questionId };
                        else bank.questions.unshift({ ...question, id: randomUUID() });
                        break;
                    }
                    case 'deleteQuestion':
                        if (!bank) throw Error('البنك غير موجود.');
                        bank.questions = bank.questions.filter(q => q.id !== payload.questionId);
                        break;
                    case 'importQuestions':
                        if (!bank || !Array.isArray(payload.questions) || !payload.questions.length || payload.questions.length > 500) throw Error('اختر ملفًا يحتوي من سؤال واحد إلى 500 سؤال.');
                        bank.questions.unshift(...payload.questions.map(q => ({ ...questionValue(q), id: randomUUID() })));
                        break;
                    default: throw Error('طلب غير صالح.');
                }
                validate(draft);
                draft.revision++;
                try { await save(draft); } catch { throw Error('تعذر حفظ التعديلات. لم يتم تغيير البنك؛ حاول مجددًا.'); }
                state = draft;
                return this.snapshot();
            });
            queue = operation.catch(() => {});
            return operation;
        },
        async close() { await queue; if (pool) await pool.end(); }
    };
}
module.exports = { createQuestionStore };
