(() => {
    const el = id => document.getElementById(id);
    const tabs = ['overview', 'questions', 'categories', 'banks'];
    const pageSize = 12;
    let session = false, model = null, generation = 0;
    let editing = null, editingCategory = null, categoryImage = '', categoryPreviewUrl = null;
    let polling = null, statsPending = false, busy = false, refreshing = false, page = 0;
    let renameDirty = false;
    const visible = () => window.WamdaNavigation.isDeveloperPage() && document.visibilityState !== 'hidden';
    const message = value => { el('developer-message').textContent = value; };
    const stale = () => Object.assign(Error('انتهت جلسة الإدارة.'), { stale: true });
    const current = version => { if (version !== generation) throw stale(); };
    const report = error => { if (!error.stale) message(error.message); };
    const node = (tag, text = '', className = '') => {
        const element = document.createElement(tag);
        element.textContent = text; element.className = className;
        return element;
    };
    function request(event, payload = {}) {
        const version = generation;
        return new Promise((resolve, reject) => {
            if (!socket.connected || !connectionReady) return reject(Error('الاتصال غير متاح. حاول بعد عودة الاتصال.'));
            socket.timeout(12000).emit(event, payload, (error, response) => {
                if (version !== generation) return reject(stale());
                if (error) return reject(Error('تأخر رد الخادم. حدّث البيانات قبل إعادة المحاولة.'));
                if (!response?.ok) {
                    if (response?.unauthorized) resetSession();
                    return reject(Error(response?.message || 'تعذر تنفيذ الطلب.'));
                }
                resolve(response);
            });
        });
    }
    function selectTab(name, focus = false) {
        if (!tabs.includes(name)) return;
        tabs.forEach(tab => {
            const active = tab === name;
            el(`admin-tab-${tab}`).setAttribute('aria-selected', String(active));
            el(`admin-tab-${tab}`).tabIndex = active ? 0 : -1;
            el(`admin-${tab}`).classList.toggle('hidden', !active);
        });
        el('admin-bank-context').classList.toggle('hidden', !['questions', 'banks'].includes(name));
        if (focus) el(`admin-tab-${name}`).focus();
    }
    tabs.forEach((name, index) => {
        el(`admin-tab-${name}`).addEventListener('click', () => selectTab(name));
        el(`admin-tab-${name}`).addEventListener('keydown', event => {
            const next = event.key === 'ArrowLeft' ? (index + 1) % tabs.length : event.key === 'ArrowRight' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next !== null) { event.preventDefault(); selectTab(tabs[next], true); }
        });
    });
    function stopPolling() { clearInterval(polling); polling = null; }
    function resetEditor() {
        editing = null; el('question-form').reset();
        el('question-editor-title').textContent = 'إضافة سؤال';
        el('cancel-edit').classList.add('hidden');
    }
    function previewCategoryImage(source = '') {
        if (categoryPreviewUrl) URL.revokeObjectURL(categoryPreviewUrl);
        categoryPreviewUrl = null;
        const preview = el('category-preview');
        if (source instanceof Blob) { categoryPreviewUrl = URL.createObjectURL(source); source = categoryPreviewUrl; }
        if (source) { preview.src = source; preview.classList.remove('hidden'); }
        else { preview.removeAttribute('src'); preview.classList.add('hidden'); }
    }
    function resetCategoryEditor() {
        editingCategory = null; categoryImage = '';
        el('category-form').reset();
        el('category-editor-title').textContent = 'إضافة تصنيف';
        el('category-save').textContent = 'حفظ التصنيف';
        el('cancel-category-edit').classList.add('hidden');
        previewCategoryImage();
    }
    function resetSession() {
        generation++; session = false; model = null; busy = false; refreshing = false; statsPending = false;
        stopPolling(); resetEditor(); resetCategoryEditor(); renameDirty = false; page = 0;
        el('developer-content').inert = false;
        el('developer-code').value = '';
        el('developer-login-submit').disabled = false;
        el('admin-refresh').disabled = false;
        el('import-bank').value = '';
        el('developer-content').classList.add('hidden');
        el('developer-login').classList.remove('hidden');
        ['bank-questions', 'category-list', 'online-players', 'bank-select', 'bank-status', 'online-count', 'admin-active-bank', 'admin-content-summary', 'storage-status'].forEach(id => { el(id).textContent = ''; });
        ['bank-form', 'rename-bank-form'].forEach(id => el(id).reset());
        ['edit-category', 'import-category', 'question-category-filter'].forEach(id => { el(id).textContent = ''; });
        el('question-search').value = '';
        ['admin-players-count', 'admin-rooms-count', 'admin-questions-count', 'admin-categories-count'].forEach(id => { el(id).textContent = '0'; });
        selectTab('overview');
    }
    function renderStats(stats) {
        el('admin-players-count').textContent = stats.players.length;
        el('admin-rooms-count').textContent = stats.rooms;
        el('online-count').textContent = `${stats.connections} اتصالًا · ${stats.players.length} لاعبًا مسجّلًا`;
        const list = el('online-players'); list.textContent = '';
        stats.players.forEach(player => {
            const row = node('div', '', 'admin-player');
            row.append(node('bdi', player.name), node('span', player.room ? `${player.room}${player.host ? ' · المضيف' : ''}` : 'في الرئيسية'));
            list.appendChild(row);
        });
        if (!stats.players.length) list.appendChild(node('p', 'لا يوجد لاعبون مسجّلون متصلون حاليًا.', 'admin-empty'));
    }
    async function pollStats() {
        if (!session || !visible() || !socket.connected || !connectionReady || statsPending) return;
        const version = generation; statsPending = true;
        try {
            const data = await request('adminStats'); current(version);
            if (session && visible()) renderStats(data.stats);
        } catch (error) { report(error); }
        finally { if (version === generation) statsPending = false; }
    }
    function startPolling() {
        stopPolling();
        // Resuming the tab can start game-state synchronization first. Keep the timer
        // alive; pollStats waits for connectionReady without losing future updates.
        if (session && visible() && socket.connected) polling = setInterval(pollStats, 5000);
    }
    function selectedBank() { return model?.banks.find(bank => bank.id === el('bank-select').value); }
    function renderCategoryOptions(id, placeholder) {
        const select = el(id), previous = select.value;
        select.textContent = '';
        const empty = node('option', placeholder); empty.value = ''; select.appendChild(empty);
        model.categories.forEach(category => {
            const option = node('option', category.name); option.value = category.id; select.appendChild(option);
        });
        select.value = model.categories.some(category => category.id === previous) ? previous : '';
    }
    function renderCategories() {
        renderCategoryOptions('edit-category', 'اختر التصنيف');
        renderCategoryOptions('import-category', 'استخدام تصنيف كل سؤال في الملف');
        renderCategoryOptions('question-category-filter', 'كل التصنيفات');
        el('category-image-storage').textContent = model.imagesWritable ? `حفظ الصور: ${model.imageStorage}` : (model.imageStorage || 'رفع الصور غير متاح حاليًا.');
        el('category-image').disabled = !model.writable || !model.imagesWritable;
        const list = el('category-list'); list.textContent = '';
        model.categories.forEach(category => {
            const row = node('article', '', 'admin-category');
            const image = node('img', '', 'admin-category-image');
            image.alt = ''; image.width = 64; image.height = 64; image.loading = 'lazy'; image.decoding = 'async';
            if (category.image) image.src = category.image;
            const details = node('div');
            const linked = model.banks.reduce((count, bank) => count + bank.questions.filter(question => question.categoryId === category.id).length, 0);
            details.append(node('p', category.name, 'admin-category-name'), node('p', `${linked} سؤالًا مرتبطًا`, 'helper-message'));
            const actions = node('div', '', 'admin-row-actions');
            const edit = node('button', 'تعديل', 'secondary compact-button'); edit.type = 'button'; edit.disabled = !model.writable;
            edit.addEventListener('click', () => {
                resetCategoryEditor(); editingCategory = category.id; categoryImage = category.image;
                el('category-editor-title').textContent = 'تعديل التصنيف'; el('category-name').value = category.name;
                previewCategoryImage(category.image); el('cancel-category-edit').classList.remove('hidden'); el('category-name').focus();
            });
            const remove = node('button', 'حذف', 'text-button admin-delete'); remove.type = 'button'; remove.disabled = !model.writable;
            remove.addEventListener('click', async () => {
                if (linked) { message(`لا يمكن حذف «${category.name}»: يرتبط به ${linked} سؤالًا. انقل الأسئلة إلى تصنيف آخر أولًا.`); return; }
                if (!window.confirm(`حذف تصنيف «${category.name}»؟`)) return;
                if (await mutate({ action: 'deleteCategory', categoryId: category.id })) if (editingCategory === category.id) resetCategoryEditor();
            });
            actions.append(edit, remove); row.append(image, details, actions); list.appendChild(row);
        });
        if (!model.categories.length) list.appendChild(node('p', 'لا توجد تصنيفات بعد. أضف التصنيف الأول من النموذج.', 'admin-empty'));
    }
    const searchable = text => String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
    function renderQuestions() {
        const bank = selectedBank(); if (!bank) return;
        const search = searchable(el('question-search').value), categoryId = el('question-category-filter').value;
        const questions = bank.questions.filter(question => (!categoryId || question.categoryId === categoryId) && (!search || searchable([question.question, ...question.choices].join(' ')).includes(search)));
        const pages = Math.max(1, Math.ceil(questions.length / pageSize)); page = Math.min(page, pages - 1);
        el('question-results-count').textContent = `${questions.length} من ${bank.questions.length} سؤالًا`;
        el('question-page').textContent = `${page + 1} / ${pages}`;
        el('question-prev').disabled = page === 0; el('question-next').disabled = page === pages - 1;
        const list = el('bank-questions'); list.textContent = '';
        questions.slice(page * pageSize, (page + 1) * pageSize).forEach(question => {
            const row = node('article', '', 'admin-question');
            row.append(node('p', model.categories.find(item => item.id === question.categoryId)?.name || 'غير محدد', 'admin-question-category'), node('p', question.question, 'admin-question-text'), node('p', `الإجابة: ${question.choices[question.correct]}`, 'helper-message'));
            const actions = node('div', '', 'admin-row-actions');
            const edit = node('button', 'تعديل', 'secondary compact-button'); edit.type = 'button'; edit.disabled = !model.writable;
            edit.addEventListener('click', () => {
                editing = question.id; el('question-editor-title').textContent = 'تعديل السؤال';
                el('edit-question').value = question.question;
                question.choices.forEach((choice, i) => { el(`edit-choice-${i}`).value = choice; });
                el('edit-correct').value = question.correct; el('edit-category').value = question.categoryId;
                el('cancel-edit').classList.remove('hidden'); el('edit-question').focus();
            });
            const remove = node('button', 'حذف', 'text-button admin-delete'); remove.type = 'button'; remove.disabled = !model.writable;
            remove.addEventListener('click', () => {
                if (window.confirm('حذف هذا السؤال من البنك؟')) mutate({ action: 'deleteQuestion', bankId: bank.id, questionId: question.id });
            });
            actions.append(edit, remove); row.appendChild(actions); list.appendChild(row);
        });
        if (!questions.length) list.appendChild(node('p', bank.questions.length ? 'لا توجد أسئلة تطابق البحث. جرّب كلمة أو تصنيفًا آخر.' : 'هذا البنك فارغ. أضف أول سؤال ليبدأ التحدي.', 'admin-empty'));
    }
    function renderBank() {
        const bank = selectedBank(); if (!bank) return;
        const active = bank.id === model.activeBankId;
        el('bank-status').textContent = `${bank.questions.length} سؤالًا · ${active ? 'البنك المفعّل للعب' : `يلزم ${model.required} سؤالًا على الأقل للتفعيل`}`;
        el('activate-bank').disabled = !model.writable || active || bank.questions.length < model.required;
        el('activate-bank').textContent = active ? 'هذا البنك مفعّل للعب' : 'استخدام هذا البنك للعب';
        if (!renameDirty) el('rename-bank-name').value = bank.name;
        el('delete-bank').disabled = !model.writable || active;
        renderQuestions();
    }
    function render(data, preferredBank) {
        const previousSelection = el('bank-select').value;
        const previous = preferredBank || previousSelection;
        model = { ...data, categories: data.categories || [] };
        el('bank-select').textContent = '';
        model.banks.forEach(bank => { const option = node('option', bank.name); option.value = bank.id; el('bank-select').appendChild(option); });
        el('bank-select').value = model.banks.some(bank => bank.id === previous) ? previous : model.activeBankId;
        if (previousSelection && previousSelection !== el('bank-select').value) { resetEditor(); renameDirty = false; page = 0; }
        el('storage-status').textContent = `${model.writable ? 'الحفظ متاح' : 'للقراءة فقط'} · ${model.storage}`;
        el('admin-questions-count').textContent = model.banks.reduce((count, bank) => count + bank.questions.length, 0);
        el('admin-categories-count').textContent = model.categories.length;
        const active = model.banks.find(bank => bank.id === model.activeBankId);
        el('admin-active-bank').textContent = active?.name || 'لا يوجد بنك مفعّل';
        el('admin-content-summary').textContent = `${active?.questions.length || 0} سؤالًا في البنك المفعّل · ${model.banks.length} بنكًا إجمالًا`;
        ['bank-form', 'rename-bank-form', 'question-form', 'category-form'].forEach(id => el(id).querySelectorAll('input, button, textarea, select').forEach(input => { input.disabled = !model.writable; }));
        el('import-bank').disabled = !model.writable; el('import-category').disabled = !model.writable;
        renderCategories(); renderBank();
        if (data.stats) renderStats(data.stats);
    }
    async function refresh() {
        if (!session || busy || refreshing) return;
        const version = generation; refreshing = true; el('admin-refresh').disabled = true;
        try { const data = await request('adminRead'); current(version); render(data); message('تم تحديث البيانات.'); }
        catch (error) { report(error); }
        finally { if (version === generation) { refreshing = false; el('admin-refresh').disabled = false; } }
    }
    async function mutate(payload, imageFile = null, revision = model?.revision) {
        if (busy || !session || !model || !model.writable) return false;
        if (refreshing) { message('انتظر اكتمال تحديث البيانات ثم احفظ التعديل.'); return false; }
        const version = generation; busy = true; message('جارٍ الحفظ…'); el('developer-content').inert = true;
        try {
            if (imageFile) {
                message('جارٍ رفع صورة التصنيف…'); el('category-save').textContent = 'جارٍ رفع الصورة…';
                const data = await imageFile.arrayBuffer(); current(version);
                const upload = await request('adminUploadCategoryImage', { data, type: imageFile.type }); current(version);
                categoryImage = upload.image; payload.image = upload.image; el('category-image').value = ''; previewCategoryImage(upload.image);
            }
            const data = await request('adminMutate', { ...payload, revision }); current(version);
            const preferred = payload.action === 'createBank' ? data.banks.at(-1).id : null;
            if (payload.action === 'renameBank') renameDirty = false;
            render(data, preferred);
            if (payload.action === 'saveQuestion' || (payload.action === 'deleteQuestion' && payload.questionId === editing)) resetEditor();
            if (payload.action === 'createBank') { el('bank-form').reset(); resetEditor(); page = 0; renderBank(); }
            message('تم الحفظ. المباريات الجارية تتابع كما بدأت.'); return true;
        } catch (error) { report(error); return false; }
        finally { if (version === generation) { busy = false; el('developer-content').inert = false; el('category-save').textContent = 'حفظ التصنيف'; } }
    }
    el('developer-login').addEventListener('submit', async event => {
        event.preventDefault(); if (busy) return;
        const version = generation; busy = true; el('developer-login-submit').disabled = true;
        try {
            const code = el('developer-code').value; el('developer-code').value = '';
            const data = await request('adminLogin', { code }); current(version);
            session = true; el('developer-login').classList.add('hidden'); el('developer-content').classList.remove('hidden');
            render(data); message(''); startPolling();
            if (visible()) el('admin-tab-overview').focus();
        } catch (error) { report(error); }
        finally { if (version === generation) { busy = false; el('developer-login-submit').disabled = false; } }
    });
    el('admin-refresh').addEventListener('click', refresh);
    el('admin-logout').addEventListener('click', async () => {
        resetSession(); message('تم تسجيل الخروج.');
        try { await request('adminLogout'); }
        catch (error) { report(error); }
    });
    socket.on('disconnect', () => { resetSession(); message('انقطع الاتصال. سجّل الدخول مجددًا بعد عودته.'); });
    function updateVisibility() {
        if (!visible()) { stopPolling(); return; }
        if (session) { pollStats(); startPolling(); }
    }
    document.addEventListener('wamda:pagechange', updateVisibility);
    document.addEventListener('visibilitychange', updateVisibility);
    el('bank-select').addEventListener('change', () => { resetEditor(); renameDirty = false; page = 0; renderBank(); });
    el('rename-bank-name').addEventListener('input', () => { renameDirty = true; });
    el('question-search').addEventListener('input', () => { page = 0; renderQuestions(); });
    el('question-category-filter').addEventListener('change', () => { page = 0; renderQuestions(); });
    el('question-prev').addEventListener('click', () => { page = Math.max(0, page - 1); renderQuestions(); });
    el('question-next').addEventListener('click', () => { page++; renderQuestions(); });
    el('cancel-edit').addEventListener('click', resetEditor);
    el('cancel-category-edit').addEventListener('click', resetCategoryEditor);
    el('category-image').addEventListener('change', event => {
        const file = event.target.files[0];
        if (!file) { previewCategoryImage(categoryImage); return; }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
            event.target.value = ''; previewCategoryImage(categoryImage); message('اختر صورة JPG أو PNG أو WebP لا تتجاوز 2 ميجابايت.'); return;
        }
        previewCategoryImage(file); message('');
    });
    el('category-form').addEventListener('submit', async event => {
        event.preventDefault(); const file = el('category-image').files[0];
        if (!file && !categoryImage) { message('أضف صورة للتصنيف قبل الحفظ.'); return; }
        const saved = await mutate({ action: editingCategory ? 'updateCategory' : 'createCategory', categoryId: editingCategory, name: el('category-name').value, image: categoryImage }, file);
        if (saved) resetCategoryEditor();
    });
    el('rename-bank-form').addEventListener('submit', event => { event.preventDefault(); mutate({ action: 'renameBank', bankId: el('bank-select').value, name: el('rename-bank-name').value }); });
    el('delete-bank').addEventListener('click', () => {
        const bank = selectedBank();
        if (bank && window.confirm(`حذف بنك «${bank.name}» وجميع أسئلته؟`)) mutate({ action: 'deleteBank', bankId: bank.id });
    });
    el('bank-form').addEventListener('submit', event => { event.preventDefault(); mutate({ action: 'createBank', name: el('bank-name').value }); });
    el('activate-bank').addEventListener('click', () => mutate({ action: 'activateBank', bankId: el('bank-select').value }));
    el('question-form').addEventListener('submit', event => {
        event.preventDefault(); mutate({ action: 'saveQuestion', bankId: el('bank-select').value, questionId: editing, question: { question: el('edit-question').value, choices: [0,1,2,3].map(i => el(`edit-choice-${i}`).value), correct: Number(el('edit-correct').value), categoryId: el('edit-category').value } });
    });
    el('import-bank').addEventListener('change', async event => {
        const file = event.target.files[0], bank = selectedBank(); if (!file || !bank) return;
        const version = generation, revision = model.revision, categoryId = el('import-category').value;
        try {
            if (file.size > 500000) throw Error('اختر ملفًا أصغر من 500 كيلوبايت.');
            const text = await file.text(); current(version);
            let data;
            try { data = JSON.parse(text); } catch { throw Error('تعذر قراءة الملف. استخدم ملف JSON صالحًا.'); }
            await mutate({ action: 'importQuestions', bankId: bank.id, questions: Array.isArray(data) ? data : data.questions, categoryId }, null, revision);
        } catch (error) { report(error); }
        finally { if (version === generation) event.target.value = ''; }
    });
    el('export-bank').addEventListener('click', () => {
        const bank = selectedBank(); if (!bank) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ name: bank.name, questions: bank.questions }, null, 2)], { type: 'application/json' }));
        const link = node('a'); link.href = url; link.download = 'wamda-questions.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
})();
