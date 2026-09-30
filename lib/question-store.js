const { readLimits } = require('./limits');
const { clientError } = require('./client-errors');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const defaults = require('./default-questions.json');
const { connectPostgres } = require('./postgres');
const { createCategoryImageStore } = require('./category-images');

const defaultCategories = () => [
    { id: 'islamic', name: 'إسلاميات', image: '/images/categories/islamic.webp' },
    ...[['science', 'علوم'], ['biology', 'أحياء'], ['plants', 'نباتات'], ['history', 'تاريخ'], ['legacy', 'أسئلة عامة']]
        .map(([id, name]) => ({ id, name, image: '/images/categories/placeholder.svg' }))
];

// Data migration, not a reseed: deleted categories/questions never return in v2.
function upgrade(data) {
    if (!data || data.schemaVersion === 2) return data;
    if (data.schemaVersion != null) throw clientError('إصدار مخزن الأسئلة غير مدعوم.');
    const draft = structuredClone(data);
    draft.schemaVersion = 2;
    draft.categories = defaultCategories();
    for (const bank of draft.banks || []) for (const question of bank.questions || []) question.categoryId = 'legacy';
    return draft;
}

function uniqueQuestions(questions) {
    const seen = new Set();
    return questions.filter(q => {
        const key = q.question.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ar');
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}

function questionValue(value) {
    if (!value || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 300 ||
        !Array.isArray(value.choices) || value.choices.length !== 4 ||
        value.choices.some(choice => typeof choice !== 'string' || !choice.trim() || choice.length > 160) ||
        new Set(value.choices.map(choice => choice.trim())).size !== 4 ||
        !Number.isInteger(value.correct) || value.correct < 0 || value.correct > 3) {
        throw clientError('أدخل سؤالًا وأربعة خيارات مختلفة، وحدّد الإجابة الصحيحة.');
    }
    return { question: value.question.trim(), choices: value.choices.map(choice => choice.trim()), correct: value.correct, categoryId: value.categoryId };
}

function createQuestionStore({ required, env = process.env, connect = connectPostgres, logger = console }) {
    const limits = readLimits(env);
    let state;
    const initialState = () => upgrade({ revision: 0, activeBankId: 'default', banks: [{ id: 'default', name: 'بنك وَمْضة', questions: defaults.map((q, i) => ({ ...q, id: `default-${i}` })) }] });
    let pool;
    let queue = Promise.resolve();
    const filename = env.BANKS_FILE || path.join(__dirname, '../data/banks.json');
    let writable = !env.DATABASE_URL && Boolean(env.BANKS_FILE || !env.RENDER);
    let storage = env.DATABASE_URL ? 'قاعدة بيانات' : env.BANKS_FILE ? 'ملف على القرص المحدد' : env.RENDER ? 'القراءة فقط — اربط قاعدة بيانات لحفظ التعديلات' : 'ملف محلي';
    const images = createCategoryImageStore({ filename, env, getPool: () => pool, canWrite: () => writable });
    function validate(data) {
        if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.banks) || !data.banks.length || data.banks.length > 50) throw clientError('بنك أسئلة غير صالح.');
        if (data.schemaVersion !== 2 || !Array.isArray(data.categories) || data.categories.length > 100) throw clientError('التصنيفات غير صالحة.');
        const categoryIds = new Set();
        for (const category of data.categories) {
            if (!category || typeof category.id !== 'string' || !category.id || categoryIds.has(category.id) ||
                typeof category.name !== 'string' || !category.name.trim() || category.name.length > 60 ||
                typeof category.image !== 'string' || !/^\/(?:images\/categories\/(?:islamic\.webp|placeholder\.svg)|category-images\/[a-f0-9-]+\.webp)$/.test(category.image)) throw clientError('تصنيف غير صالح.');
            categoryIds.add(category.id);
        }
        const ids = new Set();
        for (const bank of data.banks) {
            if (typeof bank.id !== 'string' || ids.has(bank.id) || typeof bank.name !== 'string' || !bank.name.trim() || bank.name.length > 60 || !Array.isArray(bank.questions) || bank.questions.length > 1000) throw clientError('بنك أسئلة غير صالح.');
            ids.add(bank.id);
            const questionIds = new Set();
            for (const question of bank.questions) {
                questionValue(question);
                if (!categoryIds.has(question.categoryId)) throw clientError('اختر تصنيفًا موجودًا لكل سؤال.');
                if (typeof question.id !== 'string' || questionIds.has(question.id)) throw clientError('معرّف سؤال غير صالح.');
                questionIds.add(question.id);
            }
        }
        if (!data.banks.some(bank => bank.id === data.activeBankId)) throw clientError('البنك المستخدم للعب غير موجود.');
    }
    async function save(data) {
        if (pool) {
            const result = await pool.query(
                "UPDATE public.wamda_banks SET data = $1::jsonb WHERE id = 1 AND data ->> 'revision' = $2 RETURNING id",
                [JSON.stringify(data), String(data.revision - 1)]
            );
            if (result.rows.length !== 1) {
                const latest = await pool.query('SELECT data FROM public.wamda_banks WHERE id = 1');
                if (latest.rows[0]) { const data = upgrade(latest.rows[0].data); validate(data); state = data; }
                throw Object.assign(clientError('تغير البنك في جلسة أخرى. حدّث القائمة وأعد المحاولة.'), { code: 'BANK_CONFLICT', migrated: latest.rows[0]?.data.schemaVersion === 2 });
            }
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
                        let result = await pool.query('SELECT data FROM public.wamda_banks WHERE id = 1');
                        if (!result.rows.length) {
                            // Seed only after the manually-created table has been verified.
                            await pool.query('INSERT INTO public.wamda_banks (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(initialState())]);
                            result = await pool.query('SELECT data FROM public.wamda_banks WHERE id = 1');
                        }
                        const original = result.rows[0]?.data;
                        const loaded = upgrade(original);
                        validate(loaded);
                        if (original.schemaVersion !== 2) {
                            loaded.revision++;
                            await save(loaded);
                        }
                        state = loaded;
                        writable = true;
                        logger.info('[PostgreSQL] Question-bank storage ready.');
                    } catch (error) {
                        if (error.code === 'BANK_CONFLICT' && error.migrated && state?.schemaVersion === 2) {
                            // Another process completed the same migration first.
                            writable = true;
                            logger.info('[PostgreSQL] Concurrent category migration already completed.');
                        } else {
                            if (error.code === '42P01') {
                                logger.info('[PostgreSQL] Question-bank table is absent. No tables were created; using default questions.');
                            } else {
                                logger.error('[PostgreSQL] Question-bank read failed. Using default questions in read-only mode.');
                            }
                            storage = error.code === '42P01' ? 'القراءة فقط — نفّذ ملف migrations/001_wamda_banks.sql في Supabase ثم أعد تشغيل الخادم' : 'القراءة فقط — تعذر تحميل مخزن الأسئلة';
                        }
                    }
                } else {
                    storage = 'القراءة فقط — تعذر الاتصال بقاعدة البيانات';
                }
            } else if (writable) {
                try {
                    const original = JSON.parse(await fs.readFile(filename, 'utf8'));
                    const loaded = upgrade(original);
                    validate(loaded);
                    if (original.schemaVersion !== 2) { loaded.revision++; await save(loaded); }
                    state = loaded;
                }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            if (!state) {
                state = initialState();
                if (writable && !env.DATABASE_URL) await save(state);
            }
            validate(state);
            await images.init();
        },
        refresh() {
            const operation = queue.then(async () => {
                if (pool && writable) {
                    try {
                        const result = await pool.query('SELECT data FROM public.wamda_banks WHERE id = 1');
                        validate(result.rows[0]?.data);
                        state = result.rows[0].data;
                    } catch { throw clientError('تعذر تحديث البنك من قاعدة البيانات. حاول مجددًا.'); }
                }
                return this.snapshot();
            });
            queue = operation.catch(() => {});
            return operation;
        },
        snapshot() { return { ...structuredClone(state), writable, storage, required, ...images.status() }; },
        publicCategories() {
            const questions = state.banks.find(bank => bank.id === state.activeBankId).questions;
            return state.categories.map(category => ({ ...category, count: uniqueQuestions(questions.filter(q => q.categoryId === category.id)).length }));
        },
        availableQuestionCount(categoryIds) { return uniqueQuestions(state.banks.find(b => b.id === state.activeBankId).questions.filter(q => categoryIds.includes(q.categoryId))).length; },
        uploadCategoryImage(payload) { return images.upload(payload); },
        readCategoryImage(id) { return images.read(id); },
        gameQuestions(categoryIds) {
            if (!Array.isArray(categoryIds) || !categoryIds.length || categoryIds.some(id => !state.categories.some(c => c.id === id))) throw clientError('اختر تصنيفًا واحدًا على الأقل.');
            const questions = structuredClone(uniqueQuestions(state.banks.find(bank => bank.id === state.activeBankId).questions.filter(q => categoryIds.includes(q.categoryId))));
            if (questions.length < required) throw clientError('لا توجد أسئلة كافية في التصنيفات المختارة.');
            for (let i = questions.length - 1; i > 0; i--) { const j = randomInt(i + 1); [questions[i], questions[j]] = [questions[j], questions[i]]; }
            return questions.slice(0, required);
        },
        mutate(payload) {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.reject(clientError('طلب غير صالح.'));
            if (payload.action === 'importQuestions') {
                try {
                    if (!Array.isArray(payload.questions) || !payload.questions.length || payload.questions.length > 500) throw clientError('اختر ملفًا يحتوي من سؤال واحد إلى 500 سؤال.');
                    if (Buffer.byteLength(JSON.stringify(payload.questions)) > limits.importBytes) throw clientError('حجم بيانات الاستيراد يتجاوز الحد المسموح.');
                } catch (error) {
                    return Promise.reject(error instanceof TypeError ? clientError('بيانات الاستيراد غير صالحة.') : error);
                }
            }
            const operation = queue.then(async () => {
                if (!writable) throw clientError('حفظ الأسئلة غير جاهز. تحقق من DATABASE_URL وتجهيز مخزن الأسئلة، أو استخدم قرصًا دائمًا عبر BANKS_FILE.');
                if (payload.revision !== state.revision) throw clientError('تغير البنك في جلسة أخرى. حدّث القائمة وأعد المحاولة.');
                const draft = structuredClone(state);
                const bank = draft.banks.find(item => item.id === payload.bankId);
                switch (payload.action) {
                    case 'createCategory':
                    case 'updateCategory': {
                        if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) throw clientError('أدخل اسم التصنيف، بحد أقصى 60 حرفًا.');
                        if (draft.categories.some(c => c.id !== payload.categoryId && c.name === payload.name.trim())) throw clientError('يوجد تصنيف بهذا الاسم.');
                        const image = await images.validate(payload.image || '/images/categories/placeholder.svg');
                        if (payload.action === 'createCategory') draft.categories.push({ id: randomUUID(), name: payload.name.trim(), image });
                        else {
                            const category = draft.categories.find(c => c.id === payload.categoryId);
                            if (!category) throw clientError('التصنيف غير موجود.');
                            Object.assign(category, { name: payload.name.trim(), image });
                        }
                        break;
                    }
                    case 'deleteCategory': {
                        if (!draft.categories.some(c => c.id === payload.categoryId)) throw clientError('التصنيف غير موجود.');
                        const count = draft.banks.reduce((n, b) => n + b.questions.filter(q => q.categoryId === payload.categoryId).length, 0);
                        if (count) throw clientError(`التصنيف مرتبط بـ ${count} سؤالًا. انقل الأسئلة إلى تصنيف آخر قبل حذفه.`);
                        draft.categories = draft.categories.filter(c => c.id !== payload.categoryId);
                        break;
                    }
                    case 'createBank': {
                        if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) throw clientError('أدخل اسم البنك، بحد أقصى 60 حرفًا.');
                        draft.banks.push({ id: randomUUID(), name: payload.name.trim(), questions: [] });
                        break;
                    }
                    case 'renameBank':
                        if (!bank) throw clientError('البنك غير موجود.');
                        if (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 60) throw clientError('أدخل اسم البنك، بحد أقصى 60 حرفًا.');
                        bank.name = payload.name.trim();
                        break;
                    case 'deleteBank':
                        if (!bank) throw clientError('البنك غير موجود.');
                        if (bank.id === draft.activeBankId) throw clientError('فعّل بنكًا آخر قبل حذف البنك المستخدم للعب.');
                        draft.banks = draft.banks.filter(item => item.id !== bank.id);
                        break;
                    case 'activateBank':
                        if (!bank) throw clientError('البنك غير موجود.');
                        if (uniqueQuestions(bank.questions).length < required) throw clientError(`أضف ${required} سؤالًا مختلفًا على الأقل قبل تفعيل البنك.`);
                        draft.activeBankId = bank.id;
                        break;
                    case 'saveQuestion': {
                        if (!bank) throw clientError('البنك غير موجود.');
                        const question = questionValue(payload.question);
                        const index = bank.questions.findIndex(q => q.id === payload.questionId);
                        if (payload.questionId && index < 0) throw clientError('السؤال غير موجود.');
                        if (index >= 0) bank.questions[index] = { ...question, id: payload.questionId };
                        else bank.questions.unshift({ ...question, id: randomUUID() });
                        break;
                    }
                    case 'deleteQuestion':
                        if (!bank) throw clientError('البنك غير موجود.');
                        if (!bank.questions.some(q => q.id === payload.questionId)) throw clientError('السؤال غير موجود.');
                        bank.questions = bank.questions.filter(q => q.id !== payload.questionId);
                        break;
                    case 'importQuestions':
                        if (!bank || !Array.isArray(payload.questions) || !payload.questions.length || payload.questions.length > 500) throw clientError('اختر ملفًا يحتوي من سؤال واحد إلى 500 سؤال.');
                        bank.questions.unshift(...payload.questions.map(q => ({ ...questionValue(q), categoryId: q.categoryId || payload.categoryId, id: randomUUID() })));
                        break;
                    default: throw clientError('طلب غير صالح.');
                }
                validate(draft);
                draft.revision++;
                try { await save(draft); } catch (error) {
                    if (error.code === 'BANK_CONFLICT') throw error;
                    throw clientError('تعذر تأكيد الحفظ. حدّث القائمة للتحقق من آخر نسخة محفوظة قبل إعادة المحاولة.');
                }
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
