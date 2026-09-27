const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/navigation.js'), 'utf8');

function setup(initialPath = '/') {
    const document = new EventTarget(), window = new EventTarget();
    const elements = new Map();
    function element(id) {
        const classes = new Set();
        const value = {
            dataset: {}, attributes: {}, open: false,
            classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
            setAttribute(name, text) { this.attributes[name] = text; },
            focus() { document.activeElement = this; },
            close() { this.open = false; },
            querySelector() { return elements.get('current-game-heading'); }
        };
        elements.set(id, value); return value;
    }
    for (const id of ['game-main', 'developer-page', 'developer-title', 'menu-toggle', 'current-game-heading', 'menu']) element(id);
    document.documentElement = { dataset: {} };
    document.getElementById = id => elements.get(id);
    document.querySelectorAll = () => [...elements.values()].filter(item => item.open);
    window.location = { pathname: initialPath };
    window.scrollTo = () => {};
    let cursor = 0;
    const entries = [{ path: initialPath, state: null }];
    function go(delta) {
        cursor = Math.max(0, Math.min(entries.length - 1, cursor + delta));
        window.location.pathname = entries[cursor].path;
        window.dispatchEvent(new Event('popstate'));
    }
    window.history = {
        get state() { return entries[cursor].state; },
        pushState(state, title, url) {
            entries.splice(cursor + 1);
            entries.push({ state, path: url }); cursor++;
            window.location.pathname = url;
        },
        replaceState(state, title, url) { entries[cursor] = { state, path: url }; window.location.pathname = url; },
        back() { go(-1); }, forward() { go(1); }
    };
    const events = [];
    document.addEventListener('wamda:pagechange', event => events.push(event.detail.page));
    vm.runInNewContext(source, { window, document, CustomEvent });
    return { document, window, events, entries, el: id => elements.get(id), nav: window.WamdaNavigation };
}

test('developer navigation uses one history entry, restores the game, and supports browser forward/back', () => {
    const ui = setup();
    ui.el('menu').open = true;
    const game = ui.el('game-main');
    game.liveQuestion = { id: 4, accepted: true };
    ui.nav.openDeveloperPage();
    ui.nav.openDeveloperPage();
    assert.equal(ui.entries.length, 2, 'Double taps do not create duplicate history entries');
    assert.equal(ui.window.location.pathname, '/developer');
    assert.equal(game.classList.contains('hidden'), true);
    assert.equal(ui.el('developer-page').classList.contains('hidden'), false);
    assert.equal(ui.el('menu').open, false);
    assert.equal(ui.document.activeElement, ui.el('developer-title'));
    ui.nav.closeDeveloperPage();
    assert.equal(ui.window.location.pathname, '/');
    assert.equal(game.classList.contains('hidden'), false);
    assert.equal(ui.el('developer-page').classList.contains('hidden'), true);
    assert.deepEqual(game.liveQuestion, { id: 4, accepted: true }, 'Page navigation does not rebuild or discard the live game');
    assert.equal(ui.document.activeElement, ui.el('current-game-heading'));
    ui.window.history.forward();
    assert.equal(ui.nav.isDeveloperPage(), true);
    ui.window.history.back();
    assert.deepEqual(ui.events, ['game', 'developer', 'game', 'developer', 'game']);
});

test('direct developer links remain in Wamda when returning, including restored history and trailing slash', () => {
    for (const pathname of ['/developer', '/developer/']) {
        const ui = setup(pathname);
        assert.equal(ui.document.documentElement.dataset.page, 'developer');
        assert.equal(ui.el('game-main').classList.contains('hidden'), true);
        ui.nav.closeDeveloperPage();
        assert.equal(ui.window.location.pathname, '/');
        assert.equal(ui.entries.length, 1, 'A deep link must not navigate back to an unrelated external page');
        assert.equal(ui.document.title, 'وَمْضة');
    }
});


test('repeated return taps schedule only one asynchronous history traversal', () => {
    const ui = setup();
    ui.nav.openDeveloperPage();
    const performBack = ui.window.history.back;
    let pendingBacks = 0;
    ui.window.history.back = () => { pendingBacks++; };
    ui.nav.closeDeveloperPage();
    ui.nav.closeDeveloperPage();
    assert.equal(pendingBacks, 1, 'The second tap must not leave the app before popstate');
    assert.equal(ui.window.location.pathname, '/developer');
    performBack();
    assert.equal(ui.window.location.pathname, '/');
    ui.nav.openDeveloperPage();
    ui.nav.closeDeveloperPage();
    assert.equal(pendingBacks, 2, 'A completed traversal must allow later returns');
});
