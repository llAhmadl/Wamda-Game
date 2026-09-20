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

function setup({ saved = null, dark = false, blockedStorage = false, clipboardFails = false, reducedMotion = false } = {}) {
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
    document.querySelectorAll = selector => selector === 'dialog[open]' ? [...elements.values()].filter(element => element.tagName === 'dialog' && element.open) : [];
    const window = new Element("window");
    const system = new Element("media");
    system.matches = dark;
    window.matchMedia = query => query.includes("reduced-motion") ? { matches: reducedMotion } : system;
    window.scrollTo = () => {};
    const store = new Map(saved ? [["firsthit-theme", saved]] : []);
    const localStorage = {
        getItem: key => { if (blockedStorage) throw Error("Storage blocked"); return store.get(key) ?? null; },
        setItem: (key, value) => { if (blockedStorage) throw Error("Storage blocked"); store.set(key, value); }
    };
    const socket = {
        id: "host", connected: true, events: {}, sent: [], replies: {}, pending: [], defer: false,
        on(event, callback) { this.events[event] = callback; },
        emit(event, data, callback) { this.sent.push({ event, data }); if (callback) callback({ ok: true, code: "ABCDE" }); },
        timeout() {
            return { emit: (event, data, callback) => {
                this.sent.push({ event, data });
                if (this.defer) this.pending.push(callback);
                else callback(null, this.replies[event] || { ok: true });
            } };
        },
        receive(event, data) { return this.events[event]?.(data); }
    };
    const intervals = new Map();
    let intervalId = 0;
    let copied = "";
    const context = vm.createContext({
        document, window, localStorage, console, io: () => socket,
        navigator: { clipboard: { writeText: async value => { if (clipboardFails) throw Error("Clipboard blocked"); copied = value; } } },
        setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; },
        clearInterval: id => intervals.delete(id)
    });
    vm.runInContext(themeCode, context);
    vm.runInContext(nameCode, context);
    vm.runInContext(appCode, context);
    return { el, document, window, system, store, socket, context, intervals, meta, get copied() { return copied; } };
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
    tick(); tick();
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
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
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
    assert.match(ui.el("scoring-description").textContent, /نقطتين/);
    await ui.el("scoring-mode").fire("change", { target: { value: "4" } });
    assert.equal(ui.socket.sent.at(-1).data.scoringMode, 4);
    await cards[0].click();
    assert.deepEqual(Array.from(ui.socket.sent.at(-1).data.categoryIds), ["history"]);
    ui.socket.receive("lobbyUpdate", categoryLobby({ categories: [{ id: "history", name: "التاريخ الحديث", image: "/updated.webp", count: 20 }], selectedCategoryIds: ["history"] }));
    assert.equal(ui.el("category-cards").children.length, 1);
    assert.equal(ui.el("category-cards").children[0].children[2].textContent, "التاريخ الحديث");
    assert.equal(ui.el("category-cards").children[0].children[0].src, "/updated.webp");
});

test("guests see selected categories and scoring but cannot submit settings, even from a forced click", async () => {
    const ui = setup();
    ui.socket.receive("lobbyUpdate", categoryLobby({ hostId: "other", selectedCategoryIds: ["history"], scoringMode: 4 }));
    const cards = ui.el("category-cards").children;
    assert.ok(cards.every(card => card.disabled));
    assert.equal(cards[1].children[1].textContent, "✓");
    assert.equal(ui.el("scoring-mode").disabled, true);
    assert.equal(ui.el("scoring-mode").value, "4");
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

test("logo returns home after acknowledged lobby exit and never leaves an active match", async () => {
    const ui = setup();
    ui.el("name-input").value = "أحمد";
    await ui.el("play-button").click();
    await ui.el("create-button").click();
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science", "history"] }));
    ui.socket.defer = true;
    await ui.el("home-logo").click();
    assert.equal(ui.socket.sent.at(-1).event, "leaveRoom");
    assert.equal(ui.el("lobby-screen").classList.contains("hidden"), false);
    ui.socket.pending.shift()(null, { ok: false, message: "تعذر المغادرة." });
    assert.equal(ui.el("lobby-screen").classList.contains("hidden"), false);
    await ui.el("home-logo").click();
    ui.el("developer-dialog").open = true;
    ui.socket.pending.shift()(null, { ok: true });
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
    assert.equal(ui.el("developer-dialog").open, false);
    ui.socket.defer = false;
    ui.socket.receive("lobbyUpdate", categoryLobby({ selectedCategoryIds: ["science", "history"] }));
    ui.socket.receive("question", { questionId: 0, round: 1, rounds: 2, number: 1, total: 10, question: "سؤال", choices: ["أ", "ب"], duration: 20 });
    const sent = ui.socket.sent.length;
    assert.equal(ui.el("home-logo").disabled, true);
    await ui.el("home-logo").fire("click");
    vm.runInContext("returnHome()", ui.context);
    assert.equal(ui.socket.sent.length, sent);
    assert.equal(ui.el("game-screen").classList.contains("hidden"), false);
    ui.socket.receive("questionClosed", { correctIndex: 0, lastInRound: true, reason: "quota", winners: [{ id: "host", awardedPoints: 2 }] });
    assert.equal(ui.el("answer-message").textContent, "إجابة صحيحة! +2 نقطة");
    assert.equal(ui.el("home-logo").disabled, true);
    ui.socket.receive("roundOver", { round: 1, ranking: [{ name: "أحمد", score: 2 }] });
    assert.equal(ui.el("home-logo").disabled, true);
    await ui.el("home-logo").fire("click");
    assert.equal(ui.socket.sent.length, sent);
    ui.socket.receive("gameOver", { ranking: [{ name: "أحمد", score: 2 }] });
    assert.equal(ui.el("home-logo").disabled, false);
    await ui.el("home-logo").click();
    assert.equal(ui.el("home-screen").classList.contains("hidden"), false);
});
