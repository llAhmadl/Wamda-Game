(() => {
    const el = id => document.getElementById(id);
    const menu = el('site-menu');
    const menuToggle = el('menu-toggle');
    const renameField = createNameField(el('rename-input'), el('rename-label'), el('rename-error'));
    let closingMenu = null;
    function request(event, payload = {}) {
        return new Promise((resolve, reject) => {
            if (!socket.connected || !connectionReady) return reject(Error('الاتصال غير متاح. حاول بعد عودة الاتصال.'));
            socket.timeout(12000).emit(event, payload, (error, response) => {
                if (error) return reject(Error('تأخر رد الخادم. حاول مجددًا.'));
                if (!response?.ok) return reject(Error(response?.message || 'تعذر تنفيذ الطلب.'));
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
    el('developer-button').addEventListener('click', async () => {
        await closeMenu();
        window.WamdaNavigation.openDeveloperPage();
    });
    el('developer-home').addEventListener('click', () => window.WamdaNavigation.closeDeveloperPage());

    // The release number has one source: package.json on the server.
    fetch('/api/site').then(response => {
        if (!response.ok) throw Error('Site metadata unavailable');
        return response.json();
    }).then(data => {
        if (typeof data.version === 'string') el('site-version').textContent = ` · v${data.version}`;
    }).catch(() => { /* Keep the footer usable if metadata is temporarily unavailable. */ });
})();
