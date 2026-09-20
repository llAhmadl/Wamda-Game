(() => {
    const el = id => document.getElementById(id);
    const menu = el('site-menu');
    const menuToggle = el('menu-toggle');
    const developer = el('developer-dialog');
    const renameField = createNameField(el('rename-input'), el('rename-label'), el('rename-error'));
    let closingMenu = null;
    let session = false;
    let model = null;
    let editing = null;
    let editingCategory = null;
    let categoryImage = '';
    let categoryPreviewUrl = null;
    let polling = null;
    let busy = false;
    const message = text => { el('developer-message').textContent = text; };
    function request(event, payload = {}) {
        return new Promise((resolve, reject) => {
            if (!socket.connected) return reject(Error('الاتصال غير متاح. حاول بعد عودة الاتصال.'));
            socket.timeout(12000).emit(event, payload, (error, response) => {
                if (error) return reject(Error('تأخر رد الخادم. حدّث القائمة قبل إعادة المحاولة.'));
                if (!response?.ok) {
                    if (response?.unauthorized) resetSession();
                    return reject(Error(response?.message || 'تعذر تنفيذ الطلب.'));
                }
                resolve(response);
            });
        });
    }
    // Keep the native dialog's focus trap and Escape handling during the slide.
    function closeMenu() {
        if (closingMenu) return closingMenu;
        if (!menu.open) return Promise.resolve();
        menu.classList.add('is-closing');
        closingMenu = Promise.all(menu.getAnimations().map(animation => animation.finished.catch(() => {}))).then(() => {
            menu.close();
            menu.classList.remove('is-closing');
            menuToggle.setAttribute('aria-expanded', 'false');
            closingMenu = null;
        });
        return closingMenu;
    }
    menuToggle.addEventListener('click', () => {
        if (menu.open || closingMenu) return;
        menu.showModal();
        menuToggle.setAttribute('aria-expanded', 'true');
    });
    el('menu-close').addEventListener('click', closeMenu);
    menu.addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
    menu.addEventListener('click', event => {
        const bounds = menu.getBoundingClientRect();
        if (event.target === menu && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeMenu();
    });
    async function open(dialog) {
        await closeMenu();
        if (!dialog.open) dialog.showModal();
    }
    document.addEventListener('click', event => {
        const close = event.target.closest('[data-close]');
        if (close) el(close.dataset.close).close();
    });
    el('rules-button').addEventListener('click', () => open(el('rules-dialog')));
    el('rename-button').addEventListener('click', async () => {
        el('rename-input').value = playerName;
        renameField.clear();
        await open(el('rename-dialog'));
        el('rename-input').focus();
    });
    el('rename-form').addEventListener('submit', async event => {
        event.preventDefault();
        const name = cleanPlayerName(el('rename-input').value);
        if (!name) {
            renameField.reject();
            return;
        }
        try {
            const result = await request('changeName', { name });
            playerName = result.name;
            nameInput.value = result.name;
            nameField.clear();
            playerNameText.textContent = result.name;
            el('rename-dialog').close();
            if (!screens.name.classList.contains('hidden')) showScreen('home');
        } catch (error) { el('rename-error').textContent = error.message; }
    });
    function resetSession() {
        session = false; model = null; editing = null;
        clearInterval(polling);
        resetCategoryEditor();
        el('developer-code').value = '';
        el('developer-content').classList.add('hidden');
        el('developer-login').classList.remove('hidden');
        el('bank-questions').textContent = '';
        el('category-list').textContent = '';
        el('online-players').textContent = '';
    }
    function renderStats(stats) {
        el('online-count').textContent = `${stats.players.length} لاعبًا مسمّى · ${stats.connections} اتصالًا · ${stats.rooms} غرفة`;
        el('online-players').textContent = '';
        stats.players.forEach(player => {
            const row = document.createElement('div'); row.className = 'admin-player';
            const name = document.createElement('bdi'); name.textContent = player.name;
            const location = document.createElement('span'); location.textContent = player.room ? `${player.room}${player.host ? ' · المضيف' : ''}` : 'في الرئيسية';
            row.append(name, location); el('online-players').appendChild(row);
        });
    }
    function selectedBank() { return model?.banks.find(bank => bank.id === el('bank-select').value); }
    function resetEditor() {
        editing = null; el('question-form').reset();
        el('question-editor-title').textContent = 'إضافة سؤال';
        el('cancel-edit').classList.add('hidden');
    }
    function previewCategoryImage(source = '') {
        if (categoryPreviewUrl) URL.revokeObjectURL(categoryPreviewUrl);
        categoryPreviewUrl = null;
        const preview = el('category-preview');
        if (source instanceof Blob) {
            categoryPreviewUrl = URL.createObjectURL(source);
            source = categoryPreviewUrl;
        }
        if (source) {
            preview.src = source;
            preview.classList.remove('hidden');
        } else {
            preview.removeAttribute('src');
            preview.classList.add('hidden');
        }
    }
    function resetCategoryEditor() {
        editingCategory = null; categoryImage = '';
        el('category-form').reset();
        el('category-editor-title').textContent = 'إضافة تصنيف';
        el('category-save').textContent = 'حفظ التصنيف';
        el('cancel-category-edit').classList.add('hidden');
        previewCategoryImage();
    }
    function renderCategoryOptions(id, placeholder) {
        const select = el(id), previous = select.value;
        select.textContent = '';
        const empty = document.createElement('option');
        empty.value = ''; empty.textContent = placeholder;
        select.appendChild(empty);
        model.categories.forEach(category => {
            const option = document.createElement('option');
            option.value = category.id; option.textContent = category.name;
            select.appendChild(option);
        });
        select.value = model.categories.some(category => category.id === previous) ? previous : '';
    }
    function renderCategories() {
        renderCategoryOptions('edit-category', 'اختر التصنيف');
        renderCategoryOptions('import-category', 'استخدام تصنيف كل سؤال في الملف');
        el('category-image-storage').textContent = model.imagesWritable ? `حفظ الصور: ${model.imageStorage}` : (model.imageStorage || 'رفع الصور غير متاح حاليًا.');
        el('category-image').disabled = !model.writable || !model.imagesWritable;
        const list = el('category-list'); list.textContent = '';
        model.categories.forEach(category => {
            const row = document.createElement('article'); row.className = 'admin-category';
            const image = document.createElement('img'); image.className = 'admin-category-image';
            image.alt = ''; image.width = 72; image.height = 72; image.loading = 'lazy'; image.decoding = 'async';
            if (category.image) image.src = category.image;
            const details = document.createElement('div');
            const name = document.createElement('p'); name.className = 'admin-category-name'; name.textContent = category.name;
            const linked = model.banks.reduce((count, bank) => count + bank.questions.filter(question => question.categoryId === category.id).length, 0);
            const count = document.createElement('p'); count.className = 'helper-message'; count.textContent = `${linked} سؤالًا مرتبطًا`;
            details.append(name, count);
            const actions = document.createElement('div'); actions.className = 'admin-category-actions';
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary compact-button'; edit.textContent = 'تعديل'; edit.disabled = !model.writable;
            edit.addEventListener('click', () => {
                resetCategoryEditor();
                editingCategory = category.id; categoryImage = category.image;
                el('category-editor-title').textContent = 'تعديل التصنيف';
                el('category-name').value = category.name;
                previewCategoryImage(category.image);
                el('cancel-category-edit').classList.remove('hidden');
                el('category-name').focus();
            });
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'حذف'; remove.disabled = !model.writable;
            remove.addEventListener('click', async () => {
                if (linked) { message(`لا يمكن حذف «${category.name}»: يرتبط به ${linked} سؤالًا. انقل الأسئلة إلى تصنيف آخر أولًا.`); return; }
                if (!window.confirm(`حذف تصنيف «${category.name}»؟`)) return;
                if (await mutate({ action: 'deleteCategory', categoryId: category.id })) {
                    if (editingCategory === category.id) resetCategoryEditor();
                }
            });
            actions.append(edit, remove); row.append(image, details, actions); list.appendChild(row);
        });
        if (!model.categories.length) list.textContent = 'لا توجد تصنيفات بعد. أضف التصنيف الأول من النموذج أعلاه.';
    }
    function renderBank() {
        const bank = selectedBank();
        if (!bank) return;
        const active = bank.id === model.activeBankId;
        el('bank-status').textContent = `${bank.questions.length} سؤالًا${active ? ' · مستخدم للعب' : ''} · يلزم ${model.required} سؤالًا لتفعيل البنك. تُختار ${model.required} سؤالًا عشوائيًا من تصنيفات المضيف داخل البنك المفعّل، بدون تكرار.`;
        el('activate-bank').disabled = !model.writable || active || bank.questions.length < model.required;
        el('rename-bank-name').value = bank.name;
        el('delete-bank').disabled = !model.writable || active;
        el('bank-questions').textContent = '';
        bank.questions.forEach(question => {
            const row = document.createElement('article'); row.className = 'admin-question';
            const text = document.createElement('p'); text.textContent = question.question;
            const category = document.createElement('p'); category.className = 'helper-message'; category.textContent = `التصنيف: ${model.categories.find(item => item.id === question.categoryId)?.name || 'غير محدد'}`;
            const answer = document.createElement('p'); answer.className = 'helper-message'; answer.textContent = `الإجابة: ${question.choices[question.correct]}`;
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary compact-button'; edit.textContent = 'تعديل'; edit.disabled = !model.writable;
            edit.addEventListener('click', () => {
                editing = question.id;
                el('question-editor-title').textContent = 'تعديل السؤال';
                el('edit-question').value = question.question;
                question.choices.forEach((choice, i) => { el(`edit-choice-${i}`).value = choice; });
                el('edit-correct').value = question.correct;
                el('edit-category').value = question.categoryId;
                el('cancel-edit').classList.remove('hidden'); el('edit-question').focus();
            });
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'حذف'; remove.disabled = !model.writable;
            remove.addEventListener('click', () => {
                if (window.confirm('حذف هذا السؤال من البنك؟')) mutate({ action: 'deleteQuestion', bankId: bank.id, questionId: question.id });
            });
            row.append(text, category, answer, edit, remove); el('bank-questions').appendChild(row);
        });
    }
    function render(data, preferredBank) {
        const previous = preferredBank || el('bank-select').value;
        model = { ...data, categories: data.categories || [] };
        el('bank-select').textContent = '';
        data.banks.forEach(bank => {
            const option = document.createElement('option'); option.value = bank.id; option.textContent = bank.name;
            el('bank-select').appendChild(option);
        });
        el('bank-select').value = data.banks.some(bank => bank.id === previous) ? previous : data.activeBankId;
        el('storage-status').textContent = `الحفظ: ${data.storage}`;
        ['bank-form', 'rename-bank-form', 'question-form', 'category-form'].forEach(id => el(id).querySelectorAll('input, button, textarea, select').forEach(input => { input.disabled = !data.writable; }));
        el('import-bank').disabled = !data.writable;
        el('import-category').disabled = !data.writable;
        renderCategories();
        renderBank();
        if (data.stats) renderStats(data.stats);
    }
    async function refresh() {
        try { render(await request('adminRead')); message(''); }
        catch (error) { message(error.message); }
    }
    function startPolling() {
        clearInterval(polling);
        polling = setInterval(async () => {
            if (!session || !developer.open) return;
            try { renderStats((await request('adminStats')).stats); }
            catch (error) { message(error.message); }
        }, 5000);
    }
    el('developer-button').addEventListener('click', async () => {
        await open(developer);
        if (session) { refresh(); startPolling(); } else el('developer-code').focus();
    });
    developer.addEventListener('close', () => { clearInterval(polling); });
    el('developer-login').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        busy = true;
        try {
            const code = el('developer-code').value; el('developer-code').value = '';
            const data = await request('adminLogin', { code });
            session = true;
            el('developer-login').classList.add('hidden'); el('developer-content').classList.remove('hidden');
            render(data); message(''); startPolling();
        } catch (error) { message(error.message); }
        finally { busy = false; }
    });
    async function mutate(payload, imageFile = null) {
        if (busy || !model) return false;
        busy = true; message('جارٍ الحفظ...');
        el('developer-content').inert = true;
        try {
            if (imageFile) {
                message('جارٍ رفع صورة التصنيف...'); el('category-save').textContent = 'جارٍ رفع الصورة...';
                const upload = await request('adminUploadCategoryImage', { data: await imageFile.arrayBuffer(), type: imageFile.type });
                categoryImage = upload.image; payload.image = upload.image;
                el('category-image').value = '';
                previewCategoryImage(upload.image);
            }
            const data = await request('adminMutate', { ...payload, revision: model.revision });
            const preferred = payload.action === 'createBank' ? data.banks.at(-1).id : null;
            render(data, preferred);
            if (!payload.action.endsWith('Category')) resetEditor();
            message('تم الحفظ. إعدادات وأسئلة المباريات الجارية تبقى كما بدأت.');
            return true;
        } catch (error) { message(error.message); return false; }
        finally { busy = false; el('developer-content').inert = false; el('category-save').textContent = 'حفظ التصنيف'; }
    }
    el('admin-refresh').addEventListener('click', refresh);
    el('developer-home').addEventListener('click', () => returnHome());
    el('admin-logout').addEventListener('click', async () => {
        try { await request('adminLogout'); resetSession(); message('تم تسجيل الخروج.'); }
        catch (error) { message(error.message); }
    });
    socket.on('disconnect', () => { resetSession(); message('انقطع الاتصال. سجّل الدخول مجددًا.'); });
    el('bank-select').addEventListener('change', () => { resetEditor(); renderBank(); });
    el('cancel-edit').addEventListener('click', resetEditor);
    el('cancel-category-edit').addEventListener('click', resetCategoryEditor);
    el('category-image').addEventListener('change', event => {
        const file = event.target.files[0];
        if (!file) { previewCategoryImage(categoryImage); return; }
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
            event.target.value = ''; previewCategoryImage(categoryImage);
            message('اختر صورة JPG أو PNG أو WebP لا تتجاوز 2 ميجابايت.');
            return;
        }
        previewCategoryImage(file); message('');
    });
    el('category-form').addEventListener('submit', async event => {
        event.preventDefault();
        const file = el('category-image').files[0];
        if (!file && !categoryImage) { message('أضف صورة للتصنيف قبل الحفظ.'); return; }
        const saved = await mutate({ action: editingCategory ? 'updateCategory' : 'createCategory', categoryId: editingCategory,
            name: el('category-name').value, image: categoryImage }, file);
        if (saved) resetCategoryEditor();
    });
    el('rename-bank-form').addEventListener('submit', event => {
        event.preventDefault();
        mutate({ action: 'renameBank', bankId: el('bank-select').value, name: el('rename-bank-name').value });
    });
    el('delete-bank').addEventListener('click', () => {
        const bank = selectedBank();
        if (bank && window.confirm(`حذف بنك «${bank.name}» وجميع أسئلته؟`)) mutate({ action: 'deleteBank', bankId: bank.id });
    });
    el('bank-form').addEventListener('submit', async event => {
        event.preventDefault(); await mutate({ action: 'createBank', name: el('bank-name').value });
    });
    el('activate-bank').addEventListener('click', () => mutate({ action: 'activateBank', bankId: el('bank-select').value }));
    el('question-form').addEventListener('submit', event => {
        event.preventDefault();
        mutate({ action: 'saveQuestion', bankId: el('bank-select').value, questionId: editing, question: {
            question: el('edit-question').value, choices: [0,1,2,3].map(i => el(`edit-choice-${i}`).value), correct: Number(el('edit-correct').value), categoryId: el('edit-category').value
        } });
    });
    el('import-bank').addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            if (file.size > 500000) throw Error('اختر ملفًا أصغر من 500 كيلوبايت.');
            const data = JSON.parse(await file.text());
            await mutate({ action: 'importQuestions', bankId: el('bank-select').value, questions: Array.isArray(data) ? data : data.questions, categoryId: el('import-category').value });
        } catch { message('تعذر قراءة الملف. استخدم ملف JSON صالحًا، أصغر من 500 كيلوبايت.'); }
        event.target.value = '';
    });
    el('export-bank').addEventListener('click', () => {
        const bank = selectedBank(); if (!bank) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ name: bank.name, questions: bank.questions }, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'wamda-questions.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // The release number has one source: package.json on the server.
    fetch('/api/site').then(response => {
        if (!response.ok) throw Error('Site metadata unavailable');
        return response.json();
    }).then(data => {
        if (typeof data.version === 'string') el('site-version').textContent = ` · v${data.version}`;
    }).catch(() => { /* Keep the footer usable if metadata is temporarily unavailable. */ });
})();
