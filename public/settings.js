(() => {
    const el = id => document.getElementById(id);
    const menu = el('site-menu');
    const developer = el('developer-dialog');
    let session = false;
    let model = null;
    let editing = null;
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
    function open(dialog) { menu.open = false; if (!dialog.open) dialog.showModal(); }
    document.addEventListener('click', event => {
        if (!menu.contains(event.target)) menu.open = false;
        const close = event.target.closest('[data-close]');
        if (close) el(close.dataset.close).close();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') menu.open = false; });
    el('rename-button').addEventListener('click', () => {
        el('rename-input').value = playerName;
        el('rename-error').textContent = '';
        open(el('rename-dialog'));
        el('rename-input').focus();
    });
    el('rename-form').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const result = await request('changeName', { name: el('rename-input').value });
            playerName = result.name;
            nameInput.value = result.name;
            playerNameText.textContent = result.name;
            el('rename-dialog').close();
            if (!screens.name.classList.contains('hidden')) showScreen('home');
        } catch (error) { el('rename-error').textContent = error.message; }
    });
    function resetSession() {
        session = false; model = null; editing = null;
        clearInterval(polling);
        el('developer-code').value = '';
        el('developer-content').classList.add('hidden');
        el('developer-login').classList.remove('hidden');
        el('bank-questions').textContent = '';
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
    function renderBank() {
        const bank = selectedBank();
        if (!bank) return;
        const active = bank.id === model.activeBankId;
        el('bank-status').textContent = `${bank.questions.length} سؤالًا${active ? ' · مستخدم للعب' : ''} · يلزم ${model.required} سؤالًا لتفعيل البنك. تُستخدم أول ${model.required} أسئلة، وتضاف الأسئلة الجديدة في البداية.`;
        el('activate-bank').disabled = !model.writable || active || bank.questions.length < model.required;
        el('rename-bank-name').value = bank.name;
        el('delete-bank').disabled = !model.writable || active;
        el('bank-questions').textContent = '';
        bank.questions.forEach(question => {
            const row = document.createElement('article'); row.className = 'admin-question';
            const text = document.createElement('p'); text.textContent = question.question;
            const answer = document.createElement('p'); answer.className = 'helper-message'; answer.textContent = `الإجابة: ${question.choices[question.correct]}`;
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary compact-button'; edit.textContent = 'تعديل'; edit.disabled = !model.writable;
            edit.addEventListener('click', () => {
                editing = question.id;
                el('question-editor-title').textContent = 'تعديل السؤال';
                el('edit-question').value = question.question;
                question.choices.forEach((choice, i) => { el(`edit-choice-${i}`).value = choice; });
                el('edit-correct').value = question.correct;
                el('cancel-edit').classList.remove('hidden'); el('edit-question').focus();
            });
            const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'حذف'; remove.disabled = !model.writable;
            remove.addEventListener('click', () => {
                if (window.confirm('حذف هذا السؤال من البنك؟')) mutate({ action: 'deleteQuestion', bankId: bank.id, questionId: question.id });
            });
            row.append(text, answer, edit, remove); el('bank-questions').appendChild(row);
        });
    }
    function render(data, preferredBank) {
        const previous = preferredBank || el('bank-select').value;
        model = data;
        el('bank-select').textContent = '';
        data.banks.forEach(bank => {
            const option = document.createElement('option'); option.value = bank.id; option.textContent = bank.name;
            el('bank-select').appendChild(option);
        });
        el('bank-select').value = data.banks.some(bank => bank.id === previous) ? previous : data.activeBankId;
        el('storage-status').textContent = `الحفظ: ${data.storage}`;
        ['bank-form', 'rename-bank-form', 'question-form'].forEach(id => el(id).querySelectorAll('input, button, textarea, select').forEach(input => { input.disabled = !data.writable; }));
        el('import-bank').disabled = !data.writable;
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
    el('developer-button').addEventListener('click', () => {
        open(developer);
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
    async function mutate(payload) {
        if (busy || !model) return;
        busy = true; message('جارٍ الحفظ...');
        el('developer-content').inert = true;
        try {
            const data = await request('adminMutate', { ...payload, revision: model.revision });
            const preferred = payload.action === 'createBank' ? data.banks.at(-1).id : null;
            render(data, preferred); resetEditor(); message('تم الحفظ. التغييرات تطبّق على المباريات الجديدة.');
        } catch (error) { message(error.message); }
        finally { busy = false; el('developer-content').inert = false; }
    }
    el('admin-refresh').addEventListener('click', refresh);
    el('admin-logout').addEventListener('click', async () => {
        try { await request('adminLogout'); resetSession(); message('تم تسجيل الخروج.'); }
        catch (error) { message(error.message); }
    });
    socket.on('disconnect', () => { resetSession(); message('انقطع الاتصال. سجّل الدخول مجددًا.'); });
    el('bank-select').addEventListener('change', () => { resetEditor(); renderBank(); });
    el('cancel-edit').addEventListener('click', resetEditor);
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
            question: el('edit-question').value, choices: [0,1,2,3].map(i => el(`edit-choice-${i}`).value), correct: Number(el('edit-correct').value)
        } });
    });
    el('import-bank').addEventListener('change', async event => {
        const file = event.target.files[0];
        if (!file) return;
        try {
            if (file.size > 500000) throw Error('اختر ملفًا أصغر من 500 كيلوبايت.');
            const data = JSON.parse(await file.text());
            await mutate({ action: 'importQuestions', bankId: el('bank-select').value, questions: Array.isArray(data) ? data : data.questions });
        } catch { message('تعذر قراءة الملف. استخدم ملف JSON صالحًا، أصغر من 500 كيلوبايت.'); }
        event.target.value = '';
    });
    el('export-bank').addEventListener('click', () => {
        const bank = selectedBank(); if (!bank) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ name: bank.name, questions: bank.questions }, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'wamda-questions.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
})();
