const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const code = fs.readFileSync(path.join(__dirname, '../public/developer.js'), 'utf8');

// Logic-only DOM. Real layout/navigation is also exercised in a browser.
class Element {
    constructor(tag = 'div') {
        this.tagName = tag; this.children = []; this.events = {}; this.attributes = {};
        this.className = ''; this.value = ''; this.files = []; this.disabled = false; this._text = '';
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].filter(Boolean).join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); }
        };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    fire(type, event = {}) { return Promise.all((this.events[type] || []).map(callback => callback({ target: this, preventDefault() {}, ...event }))); }
    click() { return this.disabled ? Promise.resolve() : this.fire('click'); }
    focus() { this.focused = true; }
    querySelectorAll(selector) {
        const tags = selector.split(',').map(value => value.trim());
        return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    reset() { this.querySelectorAll('input, textarea, select').forEach(element => { element.value = element.defaultValue || ''; element.files = []; }); }
}
function snapshot(revision = 7) {
    return { ok: true, revision, writable: true, storage: 'local', imagesWritable: true, imageStorage: 'local', required: 20, activeBankId: 'first',
        categories: [{ id: 'general', name: 'عام', image: '/general.webp' }, { id: 'science', name: 'علوم', image: '/science.webp' }],
        banks: [{ id: 'first', name: 'البنك الأول', questions: Array.from({ length: 26 }, (_, i) => ({ id: `q-${i}`, question: i === 0 ? 'مَا اسمُ كوكب المريخ؟ <script>bad()</script>' : `سؤال ${i}`, choices: ['صحيح', 'غير صحيح', 'ثالث', 'رابع'], correct: 0, categoryId: i % 2 ? 'science' : 'general' })) }, { id: 'second', name: 'البنك الثاني', questions: [] }],
        stats: { connections: 3, rooms: 1, players: [{ name: '<img onerror=bad()>', room: 'ABCDE', host: true }] } };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup() {
    const document = new Element('document'), elements = new Map(), stack = [document];
    for (const match of html.matchAll(/<(\/?)([\w-]+)\b([^>]*)>/g)) {
        const [, close, tag, attributes] = match;
        if (close) { if (stack.at(-1).tagName === tag) stack.pop(); continue; }
        const element = new Element(tag); stack.at(-1).appendChild(element);
        for (const attribute of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
        element.className = element.attributes.class || ''; element.value = element.attributes.value || ''; element.defaultValue = element.value;
        if (element.attributes.id) elements.set(element.attributes.id, element);
        if (!['input', 'img', 'meta', 'link', 'path', 'circle', 'rect', 'br'].includes(tag)) stack.push(element);
    }
    document.getElementById = id => { assert.ok(elements.has(id), `Missing ${id}`); return elements.get(id); };
    document.createElement = tag => new Element(tag);
    let currentPage = 'developer', intervalId = 0;
    const intervals = new Map(), timeoutCalls = [];
    const socket = { connected: true, events: {}, sent: [], deferred: new Set(), pending: [], replies: { adminLogin: snapshot(), adminRead: snapshot(), adminStats: { ok: true, stats: snapshot().stats } },
        on(event, callback) { (this.events[event] ||= []).push(callback); },
        receive(event) { return Promise.all((this.events[event] || []).map(callback => callback())); },
        timeout() { return { emit: (event, payload, callback) => {
            this.sent.push({ event, payload });
            if (this.deferred.has(event)) this.pending.push({ event, callback });
            else callback(null, this.replies[event] || { ok: true });
        } }; },
        reply(event, data, error = null) { const index = this.pending.findIndex(item => item.event === event); assert.notEqual(index, -1); this.pending.splice(index, 1)[0].callback(error, data); }
    };
    const window = { WamdaNavigation: { isDeveloperPage: () => currentPage === 'developer' }, confirm: () => true };
    const context = vm.createContext({ document, window, socket, connectionReady: true, Blob, URL, console,
        setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; }, clearInterval: id => intervals.delete(id),
        setTimeout: callback => { timeoutCalls.push(callback); } });
    vm.runInContext(code, context);
    const el = id => document.getElementById(id);
    return { el, document, window, context, socket, intervals,
        async login() { el('developer-code').value = 'private-code'; await el('developer-login').fire('submit'); await flush(); },
        async visit(page) { currentPage = page; await document.fire('wamda:pagechange'); await flush(); },
        async tick() { await Promise.all([...intervals.values()].map(callback => callback())); await flush(); }
    };
}

test('developer login opens a dedicated workspace, clears code and safely renders untrusted names', async () => {
    const ui = setup(); assert.equal(ui.intervals.size, 0);
    await ui.login();
    assert.equal(ui.el('developer-code').value, '');
    assert.equal(ui.el('developer-login').classList.contains('hidden'), true);
    assert.equal(ui.el('developer-content').classList.contains('hidden'), false);
    assert.equal(ui.el('admin-questions-count').textContent, '26');
    assert.equal(ui.el('admin-rooms-count').textContent, '1');
    assert.equal(ui.el('online-players').children[0].children[0].tagName, 'bdi');
    assert.match(ui.el('online-players').textContent, /<img onerror=bad\(\)>/);
    assert.equal(ui.el('online-players').querySelectorAll('img').length, 0);
    assert.equal(ui.intervals.size, 1);
});

test('developer tabs are keyboard accessible and preserve editing drafts', async () => {
    const ui = setup(); await ui.login();
    await ui.el('admin-tab-questions').click();
    ui.el('edit-question').value = 'مسودة السؤال'; ui.el('category-name').value = 'مسودة التصنيف';
    await ui.el('admin-tab-questions').fire('keydown', { key: 'ArrowLeft' });
    assert.equal(ui.el('admin-tab-categories').getAttribute('aria-selected'), 'true');
    assert.equal(ui.el('admin-tab-categories').focused, true);
    assert.equal(ui.el('admin-bank-context').classList.contains('hidden'), true);
    await ui.el('admin-tab-banks').click();
    assert.equal(ui.el('admin-bank-context').classList.contains('hidden'), false);
    await ui.el('admin-tab-questions').click();
    assert.equal(ui.el('edit-question').value, 'مسودة السؤال');
    assert.equal(ui.el('category-name').value, 'مسودة التصنيف');
});

test('question search combines Arabic normalization, category filter and pagination safely', async () => {
    const ui = setup(); await ui.login();
    assert.equal(ui.el('bank-questions').children.length, 12);
    await ui.el('question-next').click(); assert.equal(ui.el('question-page').textContent, '2 / 3');
    await ui.el('question-next').click(); assert.equal(ui.el('bank-questions').children.length, 2);
    assert.equal(ui.el('question-next').disabled, true);
    ui.el('question-search').value = 'ما اسم'; await ui.el('question-search').fire('input');
    assert.equal(ui.el('question-page').textContent, '1 / 1');
    assert.equal(ui.el('bank-questions').children.length, 1);
    assert.match(ui.el('bank-questions').textContent, /<script>bad\(\)<\/script>/);
    assert.equal(ui.el('bank-questions').querySelectorAll('script').length, 0);
    ui.el('question-category-filter').value = 'science'; await ui.el('question-category-filter').fire('change');
    assert.match(ui.el('bank-questions').textContent, /لا توجد أسئلة تطابق/);
    ui.el('question-search').value = ''; await ui.el('question-search').fire('input');
    assert.match(ui.el('question-results-count').textContent, /13 من 26/);
});

test('stats polling only runs in the authorized visible workspace and leaves all drafts intact', async () => {
    const ui = setup(); await ui.login();
    ui.el('edit-question').value = 'سؤال غير محفوظ'; ui.el('category-name').value = 'تصنيف غير محفوظ'; ui.el('rename-bank-name').value = 'اسم جديد';
    await ui.el('rename-bank-name').fire('input');
    await ui.tick();
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 1);
    assert.equal(ui.el('edit-question').value, 'سؤال غير محفوظ');
    await ui.visit('game'); assert.equal(ui.intervals.size, 0); await ui.tick();
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 1);
    await ui.visit('developer'); assert.equal(ui.intervals.size, 1);
    assert.equal(ui.el('category-name').value, 'تصنيف غير محفوظ');
    await ui.el('admin-refresh').click();
    assert.equal(ui.el('rename-bank-name').value, 'اسم جديد');
    assert.equal(ui.el('edit-question').value, 'سؤال غير محفوظ');
    assert.equal(ui.el('category-name').value, 'تصنيف غير محفوظ');
});

test('slow stats requests never overlap and responses after logout cannot expose data', async () => {
    const ui = setup(); await ui.login(); ui.socket.deferred.add('adminStats');
    const first = [...ui.intervals.values()][0](); await flush();
    await [...ui.intervals.values()][0]();
    assert.equal(ui.socket.pending.length, 1);
    await ui.el('admin-logout').click();
    ui.socket.reply('adminStats', { ok: true, stats: snapshot().stats }); await first; await flush();
    assert.equal(ui.intervals.size, 0);
    assert.equal(ui.el('online-players').textContent, '');
    assert.equal(ui.el('developer-content').classList.contains('hidden'), true);
    assert.equal(ui.el('developer-message').textContent, 'تم تسجيل الخروج.');
});

test('late login/read replies after disconnect cannot restore developer authorization', async () => {
    const ui = setup(); ui.socket.deferred.add('adminLogin');
    const login = ui.login(); await flush();
    ui.socket.connected = false; await ui.socket.receive('disconnect');
    ui.socket.reply('adminLogin', snapshot()); await login;
    assert.equal(ui.el('developer-content').classList.contains('hidden'), true);
    assert.equal(ui.el('bank-questions').textContent, '');
    assert.equal(ui.el('developer-login-submit').disabled, false);
    ui.socket.connected = true; ui.socket.deferred.clear(); await ui.login();
    ui.socket.deferred.add('adminRead'); const read = ui.el('admin-refresh').click(); await flush();
    ui.socket.connected = false; await ui.socket.receive('disconnect');
    ui.socket.reply('adminRead', snapshot(8)); await read; await flush();
    assert.equal(ui.el('developer-content').classList.contains('hidden'), true);
    assert.equal(ui.el('admin-refresh').disabled, false);
    assert.equal(ui.el('bank-select').children.length, 0);
});

test('authorization expiry clears sensitive content and polling', async () => {
    const ui = setup(); await ui.login();
    ui.socket.replies.adminStats = { ok: false, unauthorized: true, message: 'سجّل الدخول مجددًا.' };
    await ui.tick();
    assert.equal(ui.intervals.size, 0);
    assert.equal(ui.el('developer-login').classList.contains('hidden'), false);
    assert.equal(ui.el('bank-questions').textContent, '');
    assert.equal(ui.el('developer-message').textContent, 'سجّل الدخول مجددًا.');
});

test('question mutations prevent duplicate submissions, preserve conflict drafts and use refreshed revisions', async () => {
    const ui = setup(); await ui.login(); ui.socket.deferred.add('adminMutate');
    ui.el('edit-question').value = 'مسودة مهمة';
    await ui.el('question-form').fire('submit'); await ui.el('question-form').fire('submit');
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminMutate').length, 1);
    assert.equal(ui.socket.sent.at(-1).payload.revision, 7);
    assert.equal(ui.el('developer-content').inert, true);
    ui.socket.reply('adminMutate', { ok: false, message: 'تغير البنك في جلسة أخرى. حدّث القائمة وأعد المحاولة.' }); await flush();
    assert.equal(ui.el('edit-question').value, 'مسودة مهمة');
    assert.equal(ui.el('developer-content').inert, false);
    ui.socket.replies.adminRead = snapshot(8); await ui.el('admin-refresh').click();
    assert.equal(ui.el('edit-question').value, 'مسودة مهمة');
    await ui.el('question-form').fire('submit'); assert.equal(ui.socket.sent.at(-1).payload.revision, 8);
    ui.socket.reply('adminMutate', snapshot(9)); await flush();
    assert.equal(ui.el('edit-question').value, '');
});

test('a mutation reply from a previous session cannot refill forms after reconnect', async () => {
    const ui = setup(); await ui.login(); ui.socket.deferred.add('adminMutate');
    await ui.el('question-form').fire('submit');
    ui.socket.connected = false; await ui.socket.receive('disconnect');
    ui.socket.reply('adminMutate', snapshot(8)); await flush();
    assert.equal(ui.el('bank-questions').textContent, '');
    assert.equal(ui.el('developer-content').classList.contains('hidden'), true);
    assert.equal(ui.el('developer-content').inert, false);
});

test('image reading interrupted by disconnect never uploads or mutates in a new session', async () => {
    const ui = setup(); await ui.login(); let finishRead;
    ui.el('category-image').files = [{ type: 'image/png', arrayBuffer: () => new Promise(resolve => { finishRead = resolve; }) }];
    const save = ui.el('category-form').fire('submit'); await flush();
    ui.socket.connected = false; await ui.socket.receive('disconnect');
    finishRead(new ArrayBuffer(4)); await save; await flush();
    assert.equal(ui.socket.sent.some(item => item.event === 'adminUploadCategoryImage' || item.event === 'adminMutate'), false);
    assert.equal(ui.el('developer-content').classList.contains('hidden'), true);
});

test('read-only snapshots disable editing and cannot emit mutations', async () => {
    const ui = setup(); ui.socket.replies.adminLogin = { ...snapshot(), writable: false, imagesWritable: false }; await ui.login();
    assert.equal(ui.el('edit-question').disabled, true);
    assert.equal(ui.el('category-image').disabled, true);
    assert.equal(ui.el('import-bank').disabled, true);
    await ui.el('question-form').fire('submit');
    assert.equal(ui.socket.sent.some(item => item.event === 'adminMutate'), false);
});


test('hidden browser tabs pause stats and resume once without discarding drafts', async () => {
    const ui = setup(); await ui.login();
    ui.el('edit-question').value = 'مسودة';
    ui.document.visibilityState = 'hidden'; await ui.document.fire('visibilitychange');
    assert.equal(ui.intervals.size, 0);
    await ui.tick(); assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 0);
    ui.document.visibilityState = 'visible'; await ui.document.fire('visibilitychange'); await flush();
    assert.equal(ui.intervals.size, 1);
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 1);
    assert.equal(ui.el('edit-question').value, 'مسودة');
});

test('creating a new bank switches context without carrying over another bank’s draft name', async () => {
    const ui = setup(); await ui.login();
    ui.el('rename-bank-name').value = 'اسم غير محفوظ'; await ui.el('rename-bank-name').fire('input');
    ui.el('edit-question').value = 'مسودة البنك الأول';
    const next = snapshot(8); next.banks.push({ id: 'third', name: 'بنك جديد', questions: [] });
    ui.socket.replies.adminMutate = next;
    ui.el('bank-name').value = 'بنك جديد'; await ui.el('bank-form').fire('submit'); await flush();
    assert.equal(ui.el('bank-select').value, 'third');
    assert.equal(ui.el('rename-bank-name').value, 'بنك جديد');
    assert.equal(ui.el('edit-question').value, '');
});


test('stats resume after tab visibility starts game-state synchronization before the workspace handler', async () => {
    const ui = setup(); await ui.login();
    ui.el('edit-question').value = 'مسودة محفوظة محليًا';
    ui.document.visibilityState = 'hidden'; await ui.document.fire('visibilitychange');
    assert.equal(ui.intervals.size, 0);
    ui.context.connectionReady = false;
    ui.document.visibilityState = 'visible'; await ui.document.fire('visibilitychange');
    assert.equal(ui.intervals.size, 1, 'Keep a future polling opportunity while synchronization is pending');
    await ui.tick();
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 0, 'Do not query admin stats before synchronization finishes');
    ui.context.connectionReady = true;
    await ui.tick();
    assert.equal(ui.socket.sent.filter(item => item.event === 'adminStats').length, 1);
    assert.equal(ui.el('edit-question').value, 'مسودة محفوظة محليًا');
});
