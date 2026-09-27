const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const publicDir = path.join(__dirname, "../public");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const appCode = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const themeCode = fs.readFileSync(path.join(publicDir, "theme.js"), "utf8");
const nameCode = fs.readFileSync(path.join(publicDir, "name-validation.js"), "utf8");

// A deliberately small DOM double: these are logic checks, NOT browser/layout tests.
class Element {
    constructor(tag = "div") {
        this.tagName = tag; this.children = []; this.attributes = {};
        this.dataset = {}; this.events = {}; this.className = "";
        this.value = ""; this.disabled = false; this._text = "";
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(" "); }
        };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
    set innerHTML(value) { assert.equal(value, ""); this.children = []; this._text = ""; }
    appendChild(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
        child.parentElement = this; this.children.push(child); return child;
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }
    close() { this.open = false; }
    showModal() { this.open = true; }
    getBoundingClientRect() { return { top: (this.parentElement?.children.indexOf(this) || 0) * 69 }; }
    animate() { return { cancel() {} }; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { (this.events[type] ||= []).push(callback); }
    async fire(type, event = {}) { for (const callback of this.events[type] || []) await callback(event); }
    click() { if (!this.disabled) return this.fire("click"); }
    focus() { this.focused = true; }
    querySelectorAll(selector) {
        const matches = el => selector.startsWith(".") ? el.classList.contains(selector.slice(1)) : el.tagName === selector;
        return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function setup({ saved = null, dark = false, blockedStorage = false, clipboardFails = false, reducedMotion = false, session = null } = {}) {
    const elements = new Map();
    for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(match[1]);
        element.className = /class="([^"]+)"/.exec(match[2])?.[1] || "";
        for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
        if (match[1] === "label") element.textContent = html.slice(match.index + match[0].length).split("<")[0];
        assert.ok(!elements.has(match[3]), "IDs must be unique");
        elements.set(match[3], element);
    }
    const el = id => { assert.ok(elements.has(id), "Missing HTML element: " + id); return elements.get(id); };
    for (const [screen, title] of [["name", "name-title"], ["home", "home-title"], ["lobby", "lobby-title"], ["game", "question-text"], ["results", "results-title"]]) {
        el(screen + "-screen").appendChild(el(title));
    }
    const timerWrapper = new Element("span");
    timerWrapper.appendChild(el("timer"));
    const document = new Element("document");
    document.documentElement = new Element("html");
    document.documentElement.dataset.theme = "light";
    const meta = {};
    document.getElementById = id => elements.get(id) || null;
    document.createElement = tag => new Element(tag);
    document.querySelector = selector => selector === 'meta[name="theme-color"]' ? meta : null;
    const pageRegions = [new Element("header"), new Element("main"), el("developer-dialog")];
    document.querySelectorAll = selector => selector === "body > header, body > main, body > dialog" ? pageRegions : selector === 'dialog[open]' ? [...elements.values()].filter(element => element.tagName === 'dialog' && element.open) : [];
    const window = new Element("window");
    let reloads = 0;
    window.location = { reload() { reloads++; } };
    const system = new Element("media");
    system.matches = dark;
    window.matchMedia = query => query.includes("reduced-motion") ? { matches: reducedMotion } : system;
    window.scrollTo = () => {};
    const store = new Map(saved ? [["firsthit-theme", saved]] : []);
    if (session) store.set("wamda-session-v1", JSON.stringify(session));
    const localStorage = {
        removeItem: key => store.delete(key),
        getItem: key => { if (blockedStorage) throw Error("Storage blocked"); return store.get(key) ?? null; },
        setItem: (key, value) => { if (blockedStorage) throw Error("Storage blocked"); store.set(key, value); }
    };
    const socket = {
        connect() { this.connected = true; },
        disconnect() { this.connected = false; this.receive("disconnect", "io client disconnect"); },
        id: "transport-host", connected: true, events: {}, sent: [], replies: {}, pending: [], defer: false,
        on(event, callback) { this.events[event] = callback; },
        emit(event, data, callback) { this.sent.push({ event, data }); if (callback) callback({ ok: true, code: "ABCDE" }); },
        timeout() {
            return { emit: (event, data, callback) => {
                this.sent.push({ event, data });
                if (this.defer) this.pending.push(callback);
                else callback(null, this.replies[event] || { ok: true });
            } };
        },
        receive(event, data) {
            if (event === "question") data = { deadline: clock + data.duration * 1000, serverNow: clock, ...data };
            return this.events[event]?.(data);
        }
    };
    let clock = 0;
    const timers = new Map();
    const intervals = new Map();
    let intervalId = 0;
    let copied = "";
    const context = vm.createContext({
        document, window, localStorage, console, io: options => { socket.initialAuth = options.auth; return socket; },
        performance: { now: () => clock },
        setTimeout: (callback, ms) => { timers.set(++intervalId, { callback, at: clock + ms }); return intervalId; },
        clearTimeout: id => timers.delete(id),
        navigator: { clipboard: { writeText: async value => { if (clipboardFails) throw Error("Clipboard blocked"); copied = value; } } },
        setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; },
        clearInterval: id => intervals.delete(id)
    });
    vm.runInContext(themeCode, context);
    vm.runInContext(nameCode, context);
    vm.runInContext(appCode, context);
    socket.receive("sessionState", { session: session || { playerId: "host", reconnectToken: "test-token" }, state: null });
    function advance(ms) {
        clock += ms;
        for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.callback(); }
        for (const callback of intervals.values()) callback();
    }
    return { el, document, window, system, store, socket, context, intervals, timers, advance, meta, pageRegions, get reloads() { return reloads; }, get copied() { return copied; } };
}

test("light/dark toggle persists, updates its label and restores before DOM ready", async () => {
    const ui = setup();
    assert.equal(ui.document.documentElement.dataset.theme, "light");
    await ui.document.fire("DOMContentLoaded");
    await ui.el("theme-toggle").click();
    assert.equal(ui.document.documentElement.dataset.theme, "dark");
    assert.equal(ui.store.get("firsthit-theme"), "dark");
    assert.equal(ui.el("theme-label").textContent, "الوضع الفاتح");
    assert.equal(ui.meta.content, "#1b1c1e");
    const reloaded = setup({ saved: "dark" });
    assert.equal(reloaded.document.documentElement.dataset.theme, "dark");
    await ui.el("theme-toggle").click();
    assert.equal(ui.store.get("firsthit-theme"), "light");
});

test("theme follows system until manually selected; works with blocked storage", async () => {
    const ui = setup({ dark: true, blockedStorage: true });
    await ui.document.fire("DOMContentLoaded");
    assert.equal(ui.document.documentElement.dataset.theme, "dark");
    await ui.el("theme-toggle").click();
    assert.equal(ui.document.documentElement.dataset.theme, "light");
    await ui.system.fire("change", { matches: true });
    assert.equal(ui.document.documentElement.dataset.theme, "light");
    const automatic = setup();
    await automatic.system.fire("change", { matches: true });
    assert.equal(automatic.document.documentElement.dataset.theme, "dark");
});

test("name, home, room, player list and copy feedback", async () => {
    const ui = setup();
    await ui.el("play-button").click();
    assert.equal(ui.el("name-input").getAttribute("aria-invalid"), "true");
    ui.el("name-input").value = "أحمد";
    await ui.el("play-button").click();
    assert.equal(ui.el("player-name").textContent, "أحمد");
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
    await ui.el("create-button").click();
    assert.equal(ui.el("room-code").textContent, "ABCDE");
    ui.socket.receive("lobbyUpdate", { code: "ABCDE", hostId: "host", players: [{ id: "host", name: "أحمد" }, { id: "guest", name: "Guest" }] });
    assert.equal(ui.el("players-list").children.length, 2);
    assert.equal(ui.el("player-count").textContent, "2");
    assert.equal(ui.el("start-button").classList.contains("hidden"), false);
    await ui.el("copy-code").click();
    assert.equal(ui.copied, "ABCDE");
    assert.match(ui.el("copy-message").textContent, /تم نسخ/);
    await ui.el("leave-button").click();
    assert.equal(ui.socket.sent.at(-1).event, "leaveRoom");
});

test("copy failure gives useful feedback and guests cannot see Start", async () => {
    const ui = setup({ clipboardFails: true });
    ui.socket.receive("lobbyUpdate", { code: "ABCDE", hostId: "other", players: [] });
    await ui.el("copy-code").click();
    assert.match(ui.el("copy-message").textContent, /حدّد الرمز/);
    assert.equal(ui.el("start-button").classList.contains("hidden"), true);
});

test("name registration rejects numeric-only names in different scripts and recovers on input", async () => {
    const ui = setup();
    for (const name of ["", "   ", "12345", "١٢٣٤٥", "۱۲۳۴۵", "１２３", "1 ٢ ۳"]) {
        ui.el("name-input").value = name;
        await ui.el("play-button").click();
        assert.equal(ui.el("name-input").getAttribute("aria-invalid"), "true");
        assert.equal(ui.el("name-input").value, "", "Discard the invalid value");
        assert.equal(ui.el("name-input").getAttribute("placeholder"), "ادخل اسمك، مثال: مشعل");
        assert.equal(ui.el("name-label").textContent, "ادخل اسمك");
        assert.ok(ui.el("name-label").classList.contains("input-error-label"));
        assert.equal(ui.el("name-error").textContent, "ادخل اسمك، مثال: مشعل");
        assert.ok(ui.el("name-error").classList.contains("sr-only"), "Announce the error without duplicating it below the field");
        assert.equal(ui.el("name-screen").classList.contains("hidden"), false);
    }
    assert.equal(ui.socket.sent.length, 0, "Invalid names never reach the socket");
    ui.el("name-input").value = "  مشعل ٢  ";
    await ui.el("name-input").fire("input");
    assert.equal(ui.el("name-input").getAttribute("aria-invalid"), null);
    assert.equal(ui.el("name-input").getAttribute("placeholder"), "الاسم");
    assert.equal(ui.el("name-label").textContent, "سجل اسمك");
    assert.equal(ui.el("name-label").classList.contains("input-error-label"), false);
    assert.equal(ui.el("name-error").textContent, "");
    await ui.el("name-input").fire("keydown", { key: "Enter" });
    assert.equal(ui.el("player-name").textContent, "مشعل ٢");
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
});

test("answers submit once, selected wrong answers are not marked correct", async () => {
    const ui = setup();
    ui.socket.receive("question", { number: 1, total: 5, question: "Test question", choices: ["One", "Two", "Three", "Four"], duration: 15 });
    const choices = ui.el("choices").children;
    assert.equal(choices.length, 4);
    assert.equal(choices[0].children[0].textContent, "A");
    await choices[0].click();
    await choices[0].click();
    assert.equal(ui.socket.sent.filter(e => e.event === "submitAnswer").length, 1);
    assert.ok(choices.every(choice => choice.disabled));
    ui.socket.receive("answerResult", { correct: false, correctIndex: 1 });
    assert.ok(choices[0].classList.contains("is-wrong"));
    assert.ok(choices[1].classList.contains("is-correct"));
    assert.equal(ui.el("answer-message").textContent, "");
    assert.ok(!choices[0].classList.contains("is-correct"));
    assert.equal(choices[0].children[1].textContent, "One");
});

test("timer closes unanswered choices; equal scores share rank", () => {
    const ui = setup();
    ui.socket.receive("question", { number: 1, total: 5, question: "Test", choices: ["A", "B"], duration: 2 });
    const tick = [...ui.intervals.values()][0];
    ui.advance(2000);
    assert.equal(ui.el("timer").textContent, "0");
    assert.ok(ui.el("choices").children.every(c => c.disabled));
    assert.match(ui.el("answer-message").textContent, /انتهى الوقت/);
    ui.socket.receive("gameOver", { ranking: [{name:"A", score:3},{name:"B", score:3},{name:"C", score:1}] });
    assert.deepEqual(ui.el("results-list").children.map(row => row.children[0].textContent), ["1", "1", "3"]);
    assert.equal(ui.el("results-list").children.filter(row => row.classList.contains("winner")).length, 2);
});

test("untrusted names stay plain text and offline actions do not queue rooms", async () => {
    const ui = setup();
    const unsafe = "<img src=x onerror=alert(1)>";
    ui.socket.receive("lobbyUpdate", { code:"ABCDE", hostId:"host", players:[{id:"host",name:unsafe}] });
    assert.equal(ui.el("players-list").children[0].children[0].textContent, unsafe);
    assert.equal(ui.el("players-list").children[0].children[0].children.length, 0);
    ui.socket.connected = false;
    ui.socket.receive("disconnect");
    await ui.el("create-button").click();
    assert.equal(ui.socket.sent.length, 0);
    assert.equal(ui.el("name-screen").classList.contains("hidden"), false, "Keep the current screen during recovery");
});

test("static UI contracts: local fonts, reduced motion, and touch-friendly sizing", () => {
    const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
    assert.match(css, /@font-face/);
    assert.match(css, /font-weight: 700/);
    assert.match(css, /\.choice\.is-correct \.choice-letter/);
    assert.match(css, /\.choice\.is-wrong \.choice-letter/);
    assert.ok(!/https?:\/\//.test(html + css));
    assert.match(html, /width=device-width/);
    assert.match(css, /min-height: 48px/);
    assert.match(css, /min-height: 44px/);
    assert.match(css, /font-size: 16px/);
    assert.match(css, /prefers-reduced-motion|No animation/i);
    assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
});


test("Arabic layout, hidden scores, and host-only round controls", () => {
    assert.match(html, /lang="ar" dir="rtl"/);
    assert.match(html, /وَمْضة/);
    assert.ok(!html.includes('id="game-scores"'));
    assert.ok(!html.includes('class="timer-unit"'));
    const ui = setup();
    ui.socket.receive("lobbyUpdate", { code: "ABCDE", hostId: "guest", players: [] });
    ui.socket.receive("question", { questionId: 4, number: 5, total: 5, round: 1, rounds: 3, question: "سؤال", choices: ["أ", "ب"], duration: 20 });
    assert.equal(ui.el("question-number").textContent, "الجولة الأولى | سؤال 5");
    ui.socket.receive("questionClosed", { correctIndex: 1, lastInRound: true });
    assert.ok(ui.el("next-question-button").classList.contains("hidden"));
    ui.socket.receive("lobbyUpdate", { code: "ABCDE", hostId: "host", players: [] });
    assert.ok(!ui.el("next-question-button").classList.contains("hidden"));
    assert.equal(ui.el("next-question-button").textContent, "عرض نتائج الجولة");
    ui.socket.receive("roundOver", { round: 1, ranking: [{ name: "أحمد", score: 8 }] });
    assert.ok(!ui.el("next-round-button").classList.contains("hidden"));
    assert.ok(ui.el("home-button").classList.contains("hidden"));
    ui.socket.receive("question", { questionId: 5, number: 1, total: 5, round: 2, rounds: 3, question: "سؤال", choices: ["أ", "ب"], duration: 20 });
    assert.ok(ui.el("results-screen").classList.contains("hidden"));
    assert.ok(ui.el("next-question-button").classList.contains("hidden"));
});


test("first round counts from alphabetical zeros to ranked scores and cancels when leaving", () => {
    const ui = setup();
    const ranking = [{name:"علي",score:2},{name:"خالد",score:1},{name:"أحمد",score:0}];
    ui.socket.receive("roundOver", { round: 1, ranking });
    const rows = () => ui.el("results-list").children;
    assert.deepEqual(rows().map(row => row.children[1].textContent), ["أحمد", "خالد", "علي"]);
    assert.deepEqual(rows().map(row => row.children[2].textContent), ["0 نقطة", "0 نقطة", "0 نقطة"]);
    const tick = [...ui.intervals.values()][0];
    for (let i = 0; i < 8; i++) tick();
    assert.ok(rows().every(row => row.children[2].textContent === "0 نقطة"));
    for (let i = 0; i < 12; i++) tick();
    assert.deepEqual(rows().map(row => row.children[1].textContent), ["أحمد", "خالد", "علي"], "Keep rows still while counting");
    assert.deepEqual(rows().map(row => row.children[2].textContent), ["0 نقطة", "1 نقطة", "2 نقطة"]);
    for (let i = 0; i < 3; i++) tick();
    assert.deepEqual(rows().map(row => row.children[1].textContent), ["علي", "خالد", "أحمد"]);
    assert.deepEqual(rows().map(row => row.children[2].textContent), ["2 نقطة", "1 نقطة", "0 نقطة"]);
    assert.equal(ui.intervals.size, 0);
    ui.socket.receive("roundOver", { round: 1, ranking });
    ui.socket.receive("question", { questionId: 5, round: 2, rounds: 3, number: 1, total: 5, question: "سؤال", choices: ["أ", "ب"], duration: 20 });
    assert.equal(ui.intervals.size, 1, "Only the question timer remains");
});

test("reduced motion shows final scores immediately and ties sort alphabetically", () => {
    const ui = setup({ reducedMotion: true });
    ui.socket.receive("roundOver", { round: 1, ranking: [{name:"علي",score:2},{name:"أحمد",score:2},{name:"خالد",score:0}] });
    const rows = ui.el("results-list").children;
    assert.deepEqual(rows.map(row => row.children[1].textContent), ["أحمد", "علي", "خالد"]);
    assert.deepEqual(rows.map(row => row.children[0].textContent), ["1", "1", "3"]);
    assert.equal(ui.intervals.size, 0);
});


test("another player wins: lock every choice without showing a false timeout", () => {
    const ui = setup();
    ui.socket.receive("question", { questionId: 0, number: 1, total: 5, round: 1, rounds: 3, question: "سؤال", choices: ["الأول", "الثاني"], duration: 20 });
    ui.socket.receive("questionClosed", { correctIndex: 1, lastInRound: false, reason: "winner", winner: { id: "guest", name: "علي" } });
    assert.ok(ui.el("choices").children.every(button => button.disabled));
    assert.ok(ui.el("choices").children[1].classList.contains("is-correct"));
    assert.equal(ui.el("timer").textContent, "20");
    assert.equal(ui.el("answer-message").textContent, "حسم علي السؤال.");
    assert.equal(ui.intervals.size, 0);
});

const categoryLobby = (overrides = {}) => ({
    code: "ABCDE", hostId: "host", players: [{ id: "host", name: "أحمد" }], phase: "lobby",
    categories: [
        { id: "science", name: "علوم", image: "/images/categories/science.svg", count: 12 },
        { id: "history", name: "تاريخ", image: "/images/categories/history.svg", count: 9 }
    ],
    selectedCategoryIds: [], scoringMode: 1, ...overrides
});

test("category cards and scoring update only from server snapshots, support multiselect and removal", async () => {
    const ui = setup();
    ui.socket.receive("lobbyUpdate", categoryLobby());
    const cards = ui.el("category-cards").children;
    assert.equal(cards.length, 2);
    assert.equal(cards[0].children[2].textContent, "علوم");
    assert.equal(cards[0].getAttribute("aria-pressed"), "false");
    assert.equal(ui.el("start-button").disabled, true);
    await cards[0].click();
    const first = ui.socket.sent.at(-1);
    assert.equal(first.event, "updateRoomSettings");
    assert.deepEqual(Array.from(first.data.categoryIds), ["science"]);
    assert.equal(cards[0].getAttribute("aria-pressed"), "false", "Do not show unconfirmed settings");
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science"] }));
    assert.equal(cards[0].getAttribute("aria-pressed"), "true");
    assert.equal(cards[0].children[1].textContent, "✓");
    assert.equal(ui.el("start-button").disabled, false);
    await cards[1].click();
    assert.deepEqual(Array.from(ui.socket.sent.at(-1).data.categoryIds), ["science", "history"]);
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science", "history"], scoringMode: 3 }));
    assert.match(ui.el("category-count").textContent, /21 سؤالًا/);
    assert.equal(ui.el("scoring-mode").value, "3");
    assert.match(ui.el("scoring-description").textContent, /نقطة واحدة/);
    await ui.el("scoring-mode").fire("change", { target: { value: "5" } });
    assert.equal(ui.socket.sent.at(-1).data.scoringMode, 5);
    await cards[0].click();
    assert.deepEqual(Array.from(ui.socket.sent.at(-1).data.categoryIds), ["history"]);
    ui.socket.receive("lobbyUpdate", categoryLobby({ categories: [{ id: "history", name: "التاريخ الحديث", image: "/updated.webp", count: 20 }], selectedCategoryIds: ["history"] }));
    assert.equal(ui.el("category-cards").children.length, 1);
    assert.equal(ui.el("category-cards").children[0].children[2].textContent, "التاريخ الحديث");
    assert.equal(ui.el("category-cards").children[0].children[0].src, "/updated.webp");
});

test("guests see selected categories and scoring but cannot submit settings, even from a forced click", async () => {
    const ui = setup();
    ui.socket.receive("lobbyUpdate", categoryLobby({ hostId: "other", selectedCategoryIds: ["history"], scoringMode: 7 }));
    const cards = ui.el("category-cards").children;
    assert.ok(cards.every(card => card.disabled));
    assert.equal(cards[1].children[1].textContent, "✓");
    assert.equal(ui.el("scoring-mode").disabled, true);
    assert.equal(ui.el("scoring-mode").value, "7");
    await cards[0].fire("click");
    await ui.el("scoring-mode").fire("change", { target: { value: "1" } });
    assert.equal(ui.socket.sent.length, 0);
    assert.match(ui.el("category-hint").textContent, /المضيف/);
});

test("settings prevent overlapping requests and recover from server rejection; start errors stay visible", async () => {
    const ui = setup();
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science"] }));
    ui.socket.defer = true;
    const cards = ui.el("category-cards").children;
    await cards[1].click();
    assert.ok(cards.every(card => card.disabled));
    assert.equal(ui.el("scoring-mode").disabled, true);
    assert.equal(ui.el("start-button").disabled, true);
    await cards[0].fire("click");
    assert.equal(ui.socket.sent.length, 1);
    ui.socket.pending.shift()(null, { ok: false, message: "الإعدادات متاحة للمضيف فقط." });
    assert.match(ui.el("lobby-error").textContent, /للمضيف/);
    assert.ok(cards.every(card => !card.disabled));
    assert.equal(ui.el("start-button").disabled, false);
    ui.socket.defer = false;
    ui.socket.replies.startGame = { ok: false, message: "لا توجد أسئلة كافية في التصنيفات المختارة." };
    await ui.el("start-button").click();
    assert.match(ui.el("lobby-error").textContent, /أسئلة كافية/);
    assert.ok(ui.el("game-screen").classList.contains("hidden"));
});

test("home controls preserve acknowledged room exit and prevent leaving an active match", async () => {
    const ui = setup();
    ui.el("name-input").value = "أحمد";
    await ui.el("play-button").click();
    await ui.el("create-button").click();
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science", "history"] }));
    ui.socket.defer = true;
    await ui.el("home-button").click();
    assert.equal(ui.socket.sent.at(-1).event, "leaveRoom");
    assert.equal(ui.el("lobby-screen").classList.contains("hidden"), false);
    ui.socket.pending.shift()(null, { ok: false, message: "تعذر المغادرة." });
    assert.equal(ui.el("lobby-screen").classList.contains("hidden"), false);
    await ui.el("home-button").click();
    ui.el("developer-dialog").open = true;
    ui.socket.pending.shift()(null, { ok: true });
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
    assert.equal(ui.el("developer-dialog").open, false);
    ui.socket.defer = false;
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science", "history"] }));
    ui.socket.receive("question", { questionId: 0, round: 1, rounds: 2, number: 1, total: 10, question: "سؤال", choices: ["أ", "ب"], duration: 20 });
    const sent = ui.socket.sent.length;
    assert.equal(ui.el("developer-home").disabled, true);
    await ui.el("home-button").fire("click");
    vm.runInContext("returnHome()", ui.context);
    assert.equal(ui.socket.sent.length, sent);
    assert.equal(ui.el("game-screen").classList.contains("hidden"), false);
    ui.socket.receive("questionClosed", { correctIndex: 0, lastInRound: true, reason: "quota", winners: [{ id: "host", awardedPoints: 1 }] });
    assert.equal(ui.el("answer-message").textContent, "إجابة صحيحة! +1 نقطة");
    assert.equal(ui.el("developer-home").disabled, true);
    ui.socket.receive("roundOver", { round: 1, ranking: [{ name: "أحمد", score: 2 }] });
    assert.equal(ui.el("developer-home").disabled, true);
    await ui.el("home-button").fire("click");
    assert.equal(ui.socket.sent.length, sent);
    ui.socket.receive("gameOver", { ranking: [{ name: "أحمد", score: 2 }] });
    assert.equal(ui.el("developer-home").disabled, false);
    await ui.el("home-button").click();
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
});

const recoveryState = (overrides = {}) => ({
    ...categoryLobby({ selectedCategoryIds: ["science"], phase: "question" }),
    gameId: "match-one", question: { gameId: "match-one", questionId: 6, round: 1, number: 7,
        choices: ["أ", "ب", "ج", "د"], question: "سؤال مستعاد", duration: 20,
        deadline: 120000, serverNow: 113000 }, answer: null, review: null, results: null,
    ...overrides
});
function restore(ui, state) {
    ui.socket.connected = true;
    ui.socket.receive("sessionState", { session: { playerId: "host", reconnectToken: "private-test" }, name: "أحمد", state });
}

test("brief outages stay invisible; sustained recovery locks page until server snapshot applies", async () => {
    const ui = setup();
    restore(ui, recoveryState());
    ui.socket.connected = false; ui.socket.receive("disconnect");
    ui.advance(799);
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    const sent = ui.socket.sent.length;
    await ui.el("choices").children[0].fire("click");
    assert.equal(ui.socket.sent.length, sent);
    restore(ui, recoveryState()); ui.advance(2);
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    ui.socket.connected = false; ui.socket.receive("disconnect");
    ui.el("developer-dialog").open = true;
    ui.advance(800);
    assert.equal(ui.el("developer-dialog").open, false);
    assert.ok(!ui.el("connection-overlay").classList.contains("hidden"));
    assert.ok(ui.pageRegions.every(el => el.inert));
    assert.equal(ui.el("connection-message").textContent, "جاري إعادة الاتصال…");
    ui.advance(9200);
    assert.equal(ui.el("connection-message").textContent, "تعذر الاتصال، نحاول إعادتك للجلسة…");
    ui.socket.connected = true; ui.socket.receive("connect");
    assert.ok(!ui.el("connection-overlay").classList.contains("hidden"), "Transport readiness is not state readiness");
    restore(ui, recoveryState());
    assert.equal(ui.el("question-text").textContent, "سؤال مستعاد");
    assert.equal(ui.el("timer").textContent, "7");
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    assert.ok(ui.pageRegions.every(el => !el.inert));
    ui.advance(3500);
    assert.equal(ui.el("timer").textContent, "4", "A throttled tick derives elapsed time, never subtracts just one second");
});

test("restored accepted answers cannot be submitted again and review/results use current state", async () => {
    const ui = setup();
    restore(ui, recoveryState({ answer: { answerIndex: 1, correct: false, correctIndex: 0, awardedPoints: 0 } }));
    assert.ok(ui.el("choices").children.every(button => button.disabled));
    assert.ok(ui.el("choices").children[1].classList.contains("selected"));
    assert.ok(ui.el("choices").children[1].classList.contains("is-wrong"));
    await ui.el("choices").children[1].fire("click");
    assert.equal(ui.socket.sent.filter(x => x.event === "submitAnswer").length, 0);
    restore(ui, recoveryState({ hostId: "guest", phase: "review", review: { correctIndex: 0, lastInRound: false, reason: "winner", winners: [{ id: "guest", awardedPoints: 1 }] } }));
    assert.ok(ui.el("choices").children.every(button => button.disabled));
    assert.ok(ui.el("next-question-button").classList.contains("hidden"));
    restore(ui, recoveryState({ phase: "finished", results: { round: 2, ranking: [{ id: "host", name: "أحمد", score: 17 }] } }));
    assert.ok(!ui.el("results-screen").classList.contains("hidden"));
    assert.equal(ui.el("results-list").children[0].children[2].textContent, "17 نقطة");
    assert.equal(ui.intervals.size, 0);
});

test("wake synchronization ignores an old acknowledgement and retries failed snapshots while keeping overlay", async () => {
    const ui = setup();
    restore(ui, recoveryState());
    ui.socket.defer = true;
    ui.document.visibilityState = "visible";
    await ui.document.fire("visibilitychange");
    const stale = ui.socket.pending.shift();
    ui.socket.connected = false; ui.socket.receive("disconnect");
    ui.advance(800);
    restore(ui, recoveryState({ phase: "finished", results: { round: 2, ranking: [] } }));
    stale(null, { ok: true, state: recoveryState() });
    assert.ok(!ui.el("results-screen").classList.contains("hidden"));
    await ui.window.fire("pageshow", { persisted: true });
    ui.advance(800);
    ui.socket.pending.shift()(Error("timeout"));
    assert.ok(!ui.el("connection-overlay").classList.contains("hidden"));
    ui.advance(1000);
    ui.socket.pending.shift()(null, { ok: true, state: recoveryState() });
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    assert.equal(ui.el("timer").textContent, "7");
});

test("credentials persist privately; replaced tabs require explicit reclaim and unavailable sessions return home", async () => {
    const ui = setup();
    restore(ui, recoveryState());
    assert.equal(JSON.parse(ui.store.get("wamda-session-v1")).reconnectToken, "private-test");
    assert.equal(ui.el("connection-message").textContent.includes("private-test"), false);
    ui.socket.receive("sessionReplaced");
    ui.socket.connected = false; ui.socket.receive("disconnect", "io server disconnect");
    assert.equal(ui.socket.connected, false, "Do not automatically fight the other tab");
    assert.ok(!ui.el("reconnect-button").classList.contains("hidden"));
    assert.ok(ui.pageRegions.every(el => el.inert));
    await ui.el("reconnect-button").click();
    assert.equal(ui.socket.connected, true);
    assert.ok(!ui.el("connection-overlay").classList.contains("hidden"));
    restore(ui, recoveryState());
    ui.socket.receive("connect_error", { data: { code: "SESSION_INVALID" } });
    assert.equal(ui.store.has("wamda-session-v1"), false);
    ui.socket.receive("sessionState", { session: { playerId: "new", reconnectToken: "new-private" }, state: null });
    assert.ok(!ui.el("home-screen").classList.contains("hidden"));
    assert.match(ui.el("home-error").textContent, /الجلسة السابقة غير متاحة/);
    const reloaded = setup({ session: { playerId: "host", reconnectToken: "private-test" } });
    assert.equal(reloaded.socket.initialAuth.playerId, "host");
    assert.equal(reloaded.socket.initialAuth.reconnectToken, "private-test");
    const blocked = setup({ blockedStorage: true });
    restore(blocked, recoveryState());
    assert.equal(blocked.socket.auth.reconnectToken, "private-test");
});

test("connection overlay uses theme colors, subtle blur and reduced motion", () => {
    const css = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
    const overlay = css.slice(css.indexOf(".connection-overlay {"));
    assert.match(overlay, /var\(--background\)/);
    assert.match(overlay, /backdrop-filter: blur\(2px\)/);
    assert.match(overlay, /prefers-reduced-motion: reduce/);
    assert.match(overlay, /animation: none/);
    assert.doesNotMatch(overlay, /gradient|box-shadow|text-shadow/);
});


test("brand returns to blank name entry before or after a match, preserving theme and connection", async () => {
    for (const phase of ["home", "lobby", "finished"]) {
        const ui = setup({ saved: "dark" });
        const state = phase === "home" ? null : recoveryState({ phase });
        if (phase === "review") state.review = { correctIndex: 0, reason: "timeout" };
        if (["roundResults", "finished"].includes(phase)) state.results = { round: 1, ranking: [] };
        restore(ui, state);
        assert.equal(ui.el("home-logo").disabled, false, phase);
        ui.socket.defer = true;
        await ui.el("home-logo").click();
        assert.equal(ui.socket.sent.at(-1).event, "resetSession");
        assert.equal(ui.reloads, 0);
        assert.equal(ui.el("home-logo").disabled, true);
        await ui.el("home-logo").fire("click");
        assert.equal(ui.socket.sent.filter(e => e.event === "resetSession").length, 1);
        ui.socket.pending.shift()(null, { ok: true, name: "", state: null });
        assert.equal(ui.reloads, 0);
        assert.ok(!ui.el("name-screen").classList.contains("hidden"));
        assert.equal(ui.el("player-name").textContent, "");
        assert.equal(ui.socket.connected, true);
        assert.equal(ui.store.get("firsthit-theme"), "dark");
    }
});

test("lost reset reply restores blank name entry; failed reset keeps the current room", async () => {
    const ui = setup();
    restore(ui, recoveryState({ phase: "lobby" }));
    ui.el("name-input").value = "أحمد";
    ui.socket.defer = true;
    await ui.el("home-logo").click();
    ui.socket.pending.shift()(Error("timeout"));
    assert.equal(ui.reloads, 0);
    assert.equal(ui.socket.sent.at(-1).event, "syncState");
    ui.socket.pending.shift()(null, { ok: true, name: "", state: null });
    assert.ok(!ui.el("name-screen").classList.contains("hidden"));
    assert.equal(ui.el("name-input").value, "");
    assert.equal(ui.el("player-name").textContent, "");
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    restore(ui, recoveryState({ phase: "lobby" }));
    await ui.el("home-logo").click();
    ui.socket.pending.shift()(null, { ok: false });
    ui.socket.pending.shift()(null, { ok: true, name: "أحمد", state: recoveryState({ phase: "lobby" }) });
    assert.equal(ui.reloads, 0);
    assert.ok(!ui.el("lobby-screen").classList.contains("hidden"));
    assert.match(ui.el("site-error").textContent, /تعذرت العودة لصفحة الاسم/);
});


test("unsubmitted name survives wake and reconnect synchronization", async () => {
    const ui = setup();
    const fresh = { session: { playerId: "new", reconnectToken: "private-test" }, name: "", state: null };
    ui.socket.receive("sessionState", fresh);
    ui.el("name-input").value = "مسودة الاسم";
    ui.socket.defer = true;
    await ui.window.fire("pageshow", { persisted: true });
    ui.socket.pending.shift()(null, { ok: true, name: "", state: null });
    assert.equal(ui.el("name-input").value, "مسودة الاسم");
    ui.socket.connected = false; ui.socket.receive("disconnect");
    ui.socket.connected = true; ui.socket.receive("sessionState", fresh);
    assert.equal(ui.el("name-input").value, "مسودة الاسم");
    assert.ok(!ui.el("name-screen").classList.contains("hidden"));
});

test("brand explicitly clears an unsubmitted draft, also after a lost reset reply", async () => {
    for (const lostReply of [false, true]) {
        const ui = setup();
        ui.socket.receive("sessionState", { session: { playerId: "new", reconnectToken: "private-test" }, name: "", state: null });
        ui.el("name-input").value = "مسودة الاسم";
        ui.socket.defer = true;
        await ui.el("home-logo").click();
        if (lostReply) ui.socket.pending.shift()(Error("timeout"));
        ui.socket.pending.shift()(null, { ok: true, name: "", state: null });
        assert.equal(ui.el("name-input").value, "");
        assert.equal(ui.el("player-name").textContent, "");
        assert.ok(!ui.el("name-screen").classList.contains("hidden"));
        assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
    }
});


test("brand asks before reloading active matches without leaving or clearing credentials", async () => {
    for (const phase of ["question", "review", "roundResults"]) {
        const ui = setup({ saved: "dark" });
        const state = recoveryState({ phase });
        if (phase === "review") state.review = { correctIndex: 0, winners: [] };
        if (phase === "roundResults") state.results = { round: 1, ranking: [] };
        restore(ui, state);
        const credentials = ui.store.get("wamda-session-v1");
        await ui.el("home-logo").click();
        await ui.el("home-logo").fire("click");
        assert.equal(ui.reloads, 0, "Opening confirmation must not reload");
        assert.equal(ui.el("refresh-dialog").open, true);
        assert.equal(ui.el("refresh-cancel").focused, true);
        await ui.el("refresh-confirm").click();
        await ui.el("refresh-confirm").fire("click");
        assert.equal(ui.reloads, 1, phase);
        assert.equal(ui.socket.sent.length, 0, "Refresh must not send resetSession or leaveRoom");
        assert.equal(ui.store.get("wamda-session-v1"), credentials);
        assert.equal(ui.store.get("firsthit-theme"), "dark");
        assert.equal(ui.socket.connected, true);
        assert.match(ui.el("home-logo").getAttribute("aria-label"), /استعادة المباراة/);
    }
});

test("brand racing game start synchronizes and asks before refreshing", async () => {
    const ui = setup();
    restore(ui, recoveryState({ phase: "lobby" }));
    ui.socket.defer = true;
    await ui.el("home-logo").click();
    assert.equal(ui.socket.sent.at(-1).event, "resetSession");
    ui.socket.pending.shift()(null, { ok: false, code: "GAME_ACTIVE" });
    assert.equal(ui.reloads, 0);
    assert.equal(ui.socket.sent.at(-1).event, "syncState");
    ui.socket.pending.shift()(null, { ok: true, name: "أحمد", state: recoveryState() });
    assert.equal(ui.el("refresh-dialog").open, true);
    assert.equal(ui.reloads, 0);
    await ui.el("refresh-confirm").click();
    assert.equal(ui.reloads, 1);
    assert.equal(ui.el("player-name").textContent, "أحمد");
    assert.ok(ui.store.has("wamda-session-v1"));
});

test("brand keeps an active session and synchronizes when storage blocks reload recovery", async () => {
    const ui = setup({ blockedStorage: true });
    restore(ui, recoveryState());
    ui.socket.defer = true;
    await ui.el("home-logo").click();
    assert.equal(ui.reloads, 0);
    assert.equal(ui.el("refresh-dialog").open, true);
    await ui.el("refresh-confirm").click();
    assert.equal(ui.socket.sent.at(-1).event, "syncState");
    ui.socket.pending.shift()(null, { ok: true, name: "أحمد", state: recoveryState() });
    assert.ok(!ui.el("game-screen").classList.contains("hidden"));
    assert.equal(ui.el("timer").textContent, "7");
    assert.ok(ui.el("connection-overlay").classList.contains("hidden"));
});

test("live answer board follows server order, handles duplicates and stale events, and clears for each question", () => {
    const ui = setup();
    const state = recoveryState();
    state.scoringMode = 3;
    state.question.scoringMode = 3;
    restore(ui, state);
    const list = ui.el("answer-leaders");
    assert.equal(list.children.length, 3);
    assert.deepEqual(list.children.map(row => row.children[1].textContent), ["—", "—", "—"]);
    const first = { id: "guest", name: "سوسن", rank: 1, awardedPoints: 1 };
    const data = { gameId: state.gameId, questionId: 6, scoringMode: 3, winners: [first] };
    ui.socket.receive("answerProgress", data);
    const firstRow = list.children[0];
    ui.socket.receive("answerProgress", data);
    assert.equal(list.children[0], firstRow, "Repeated snapshots must not trigger another live announcement");
    assert.deepEqual(list.children.map(row => row.children[1].textContent), ["سوسن", "—", "—"]);
    assert.equal(list.children.filter(row => row.classList.contains("is-filled")).length, 1);
    ui.socket.receive("answerProgress", { ...data, winners: [] });
    ui.socket.receive("answerProgress", { ...data, gameId: "old", winners: [] });
    ui.socket.receive("answerProgress", { ...data, questionId: 5, winners: [] });
    assert.equal(list.children[0].children[1].textContent, "سوسن");
    const unsafeName = "<img src=x onerror=alert(1)>";
    ui.socket.receive("answerProgress", { ...data, winners: [first, { id: "host", name: unsafeName, rank: 2, awardedPoints: 1 }] });
    assert.equal(list.children[1].children[1].textContent, unsafeName);
    assert.equal(list.children[1].children[1].children.length, 0);
    ui.socket.receive("question", { ...state.question, questionId: 7, number: 8, winners: [] });
    ui.socket.receive("answerProgress", data);
    assert.deepEqual(list.children.map(row => row.children[1].textContent), ["—", "—", "—"]);
});

test("answer board restores all four quotas and accepted names from server snapshots", () => {
    for (const mode of [1, 3, 5, 7]) {
        const ui = setup();
        const winners = [{ id: "guest", name: "سوسن", rank: 1, awardedPoints: 1 }];
        const state = recoveryState({ scoringMode: mode });
        state.question = { ...state.question, scoringMode: mode, winners };
        restore(ui, state);
        assert.equal(ui.el("answer-leaders").children.length, mode);
        assert.equal(ui.el("answer-leaders").children[0].children[1].textContent, "سوسن");
        const restoredRow = ui.el("answer-leaders").children[0];
        restore(ui, state);
        assert.equal(ui.el("answer-leaders").children[0], restoredRow, "An unchanged wake snapshot must not reannounce winners");
        ui.socket.receive("disconnect");
        restore(ui, { ...state, phase: "review", review: { correctIndex: 0, reason: "timeout", winners } });
        assert.equal(ui.el("answer-leaders").children[0].children[1].textContent, "سوسن");
        assert.equal(ui.el("answer-leaders").children.filter(row => row.classList.contains("is-filled")).length, 1);
    }
});


test("cancel, close and Escape keep the match running without reload or socket commands", async () => {
    for (const action of ["refresh-cancel", "refresh-close", "escape"]) {
        const ui = setup();
        restore(ui, recoveryState());
        await ui.el("home-logo").click();
        const before = ui.el("timer").textContent;
        ui.advance(1000);
        assert.notEqual(ui.el("timer").textContent, before, "Confirmation never pauses the match");
        if (action === "escape") await ui.el("refresh-dialog").fire("cancel", { preventDefault() {} });
        else await ui.el(action).click();
        assert.equal(ui.el("refresh-dialog").open, false);
        await ui.el("refresh-confirm").fire("click");
        assert.equal(ui.reloads, 0);
        assert.equal(ui.socket.sent.length, 0);
        assert.ok(!ui.el("game-screen").classList.contains("hidden"));
    }
});

test("disconnect and replaced-session recovery invalidate an open refresh confirmation", async () => {
    for (const event of ["disconnect", "sessionReplaced"]) {
        const ui = setup();
        restore(ui, recoveryState());
        await ui.el("home-logo").click();
        ui.socket.receive(event);
        await ui.el("refresh-confirm").fire("click");
        assert.equal(ui.reloads, 0);
        ui.advance(800);
        assert.equal(ui.el("refresh-dialog").open, false);
        assert.equal(ui.socket.sent.length, 0);
    }
});
