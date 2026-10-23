// Core: session, connection recovery, shared state and screen switching.
// Game scripts are classic scripts loaded in order and share these globals.
const SESSION_KEY = "wamda-session-v1";
let savedSession = null;
try { savedSession = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* Storage can be unavailable. */ }
if (!savedSession || typeof savedSession.playerId !== "string" || typeof savedSession.reconnectToken !== "string") savedSession = null;
const socket = io({ auth: savedSession || {} });

// ---------- State ----------
let playerId = savedSession?.playerId || null;
let playerName = "";
let currentRoom = "";
let gameId = null;
let phase = "lobby";
let amHost = false;
let questionId = null;
let currentRound = 1;
let lastInRound = false;
let countdown = null;
let connectionReady = false;
let homePending = false;
let resetNameOnSync = false;
let connectionEpoch = 0;
let overlayDelay = null;
let longDelay = null;
let syncRetry = null;
let replaced = false;
let previousFocus = null;

// ---------- Elements ----------
const el = id => document.getElementById(id);
const screens = { name: el("name-screen"), home: el("home-screen"), lobby: el("lobby-screen"), game: el("game-screen"), results: el("results-screen") };
const nameInput = el("name-input");
const playerNameText = el("player-name");
const createButton = el("create-button");
const joinButton = el("join-button");
const roomCodeInput = el("room-code-input");
const homeError = el("home-error");
const roomCodeText = el("room-code");
const choicesContainer = el("choices");
const answerMessage = el("answer-message");
const timerElement = el("timer");
const nextQuestionButton = el("next-question-button");
const nextRoundButton = el("next-round-button");
const homeButton = el("home-button");
const connectionOverlay = el("connection-overlay");
const connectionMessage = el("connection-message");
const reconnectButton = el("reconnect-button");

// ---------- Arabic counting ----------
// forms: [one, two, plural for 3–10, singular accusative for 11+]; zero is optional.
function arabicCount(n, [one, two, few, many], zero = null) {
    if (n === 0 && zero) return zero;
    if (n === 1) return one;
    if (n === 2) return two;
    const rest = n % 100;
    return `${n} ${rest >= 3 && rest <= 10 ? few : many}`;
}
const pointsText = n => arabicCount(n, ["نقطة واحدة", "نقطتان", "نقاط", "نقطة"], "0 نقطة");
const questionsText = n => arabicCount(n, ["سؤال واحد", "سؤالان", "أسئلة", "سؤالًا"], "لا توجد أسئلة");
const playersText = n => arabicCount(n, ["لاعب واحد", "لاعبان", "لاعبين", "لاعبًا"]);

// ---------- Screens & controls ----------
function showScreen(name) {
    stopResultsAnimation();
    for (const screen of Object.values(screens)) screen.classList.add("hidden");
    screens[name].classList.remove("hidden");
    screens[name].querySelector("h1")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}
function focusCurrentPageHeading() {
    Object.values(screens).find(screen => !screen.classList.contains("hidden"))?.querySelector("h1")?.focus({ preventScroll: true });
}
function isActiveGame() {
    return Boolean(currentRoom) && ["question", "review", "roundResults"].includes(phase);
}
function updateControls() {
    el("quit-button").classList.toggle("hidden", !currentRoom);
    el("players-button").classList.toggle("hidden", !(currentRoom && amHost));
    const logo = el("home-logo");
    logo.disabled = homePending;
    logo.title = isActiveGame() ? "تحديث الصفحة واستعادة المباراة" : "العودة إلى صفحة الاسم";
    logo.setAttribute("aria-label", `وَمْضة — ${logo.title}`);
    nextQuestionButton.classList.toggle("hidden", !(phase === "review" && amHost));
    nextRoundButton.classList.toggle("hidden", !(phase === "roundResults" && amHost));
    nextQuestionButton.textContent = lastInRound ? "عرض نتائج الجولة" : "السؤال التالي";
    el("advance-message").textContent = phase === "review" ? (amHost ? "انتقل عندما يكون الجميع جاهزًا." : "بانتظار المضيف للمتابعة...") : "";
    el("round-message").textContent = phase === "roundResults" ? (amHost ? "ابدأ الجولة التالية عندما يكون الجميع جاهزًا." : "بانتظار المضيف لبدء الجولة التالية...")
        : phase === "finished" && currentRoom && !amHost ? "إذا بدأ المضيف مباراة جديدة ستنتقل لها تلقائيًا." : "";
    updateResultActions();
}
function isConnected() {
    if (socket.connected && connectionReady) return true;
    homeError.textContent = "لم يتم الاتصال بعد. حاول بعد قليل.";
    return false;
}
function closeDialogs() {
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    el("menu-toggle").setAttribute("aria-expanded", "false");
}

// ---------- Names ----------
// The same error presentation is used for registration and renaming.
function createNameField(input, label, error) {
    const placeholder = input.getAttribute("placeholder") || "";
    const originalLabel = label.textContent;
    function clear() {
        input.removeAttribute("aria-invalid");
        input.setAttribute("placeholder", placeholder);
        label.textContent = originalLabel;
        label.classList.remove("input-error-label");
        error.textContent = "";
        error.classList.remove("sr-only");
    }
    input.addEventListener("input", clear);
    return {
        clear,
        reject() {
            const message = "ادخل اسمك، مثال: مشعل";
            input.value = "";
            input.setAttribute("aria-invalid", "true");
            input.setAttribute("placeholder", message);
            label.textContent = "ادخل اسمك";
            label.classList.add("input-error-label");
            // Keep the inline placeholder error announced by assistive technology.
            error.classList.add("sr-only");
            error.textContent = message;
            input.focus();
        }
    };
}
const nameField = createNameField(nameInput, el("name-label"), el("name-error"));

// ---------- Connection recovery ----------
function lockPage(locked) {
    for (const element of document.querySelectorAll("body > header, body > main, body > dialog")) element.inert = locked;
}
function beginRecovery() {
    connectionReady = false;
    clearInterval(countdown);
    if (overlayDelay !== null) return;
    overlayDelay = setTimeout(() => {
        previousFocus = document.activeElement;
        // An open modal lives above fixed overlays, so close it before blocking the page.
        closeDialogs();
        connectionMessage.textContent = "جاري إعادة الاتصال…";
        connectionOverlay.classList.remove("hidden");
        lockPage(true);
        connectionMessage.focus({ preventScroll: true });
    }, 800);
    longDelay = setTimeout(() => {
        if (!replaced) connectionMessage.textContent = "تعذر الاتصال، نحاول إعادتك للجلسة…";
    }, 10000);
}
function finishRecovery() {
    clearTimeout(overlayDelay); clearTimeout(longDelay); clearTimeout(syncRetry);
    overlayDelay = longDelay = syncRetry = null;
    connectionReady = true;
    connectionOverlay.classList.add("hidden");
    reconnectButton.classList.add("hidden");
    lockPage(false);
    if (previousFocus?.isConnected && !previousFocus.closest("[inert], .hidden")) previousFocus.focus({ preventScroll: true });
    else focusCurrentPageHeading();
    previousFocus = null;
}
function storeSession(session) {
    savedSession = session;
    playerId = session?.playerId || null;
    socket.auth = session || {};
    try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
    } catch { /* In-memory recovery still works when storage is blocked. */ }
}
// A server snapshot is the source of truth after connect, wake and reconnect.
function applyState(data) {
    settingsPending = false;
    const hadRegisteredName = Boolean(playerName);
    playerName = data.name ?? playerName;
    playerNameText.textContent = playerName;
    const state = data.state;
    // Keep an unsubmitted draft on ordinary wake/reconnect snapshots. A deliberate
    // reset (including a lost acknowledgement) must restore an empty name field.
    if (!state && !playerName && (hadRegisteredName || resetNameOnSync)) {
        nameInput.value = "";
        nameField.clear();
    }
    resetNameOnSync = false;
    if (!state) {
        currentRoom = ""; phase = "lobby"; amHost = false; gameId = null;
        clearInterval(countdown); updateControls();
        showScreen(playerName ? "home" : "name");
        return;
    }
    renderLobby(state);
    if (state.phase === "lobby") showScreen("lobby");
    else if (state.phase === "question" || state.phase === "review") {
        renderQuestion(state.question);
        if (state.answer) {
            const buttons = choicesContainer.querySelectorAll("button");
            buttons[state.answer.answerIndex]?.classList.add("selected");
            buttons[state.answer.answerIndex]?.setAttribute("aria-pressed", "true");
            buttons.forEach(button => { button.disabled = true; });
            renderAnswer(state.answer);
        }
        if (state.review) renderReview(state.review);
    } else showResults(state.results, state.phase === "finished");
}
function synchronize(afterSync) {
    if (!socket.connected || replaced) return;
    beginRecovery();
    const epoch = ++connectionEpoch;
    socket.timeout(5000).emit("syncState", {}, (error, data) => {
        if (epoch !== connectionEpoch || !socket.connected || replaced) return;
        if (error || !data?.ok) { syncRetry = setTimeout(() => synchronize(afterSync), 1000); return; }
        applyState(data);
        finishRecovery();
        joinInvite();
        if (typeof afterSync === "function") afterSync();
    });
}
socket.on("disconnect", reason => {
    connectionEpoch++;
    clearTimeout(syncRetry);
    if (!replaced) beginRecovery();
    if (reason === "io server disconnect" && !replaced) socket.connect();
});
socket.on("connect_error", error => {
    beginRecovery();
    if (error?.data?.code === "SESSION_INVALID") {
        storeSession(null);
        currentRoom = ""; phase = "lobby";
        homeError.textContent = "الجلسة السابقة غير متاحة. يمكنك إنشاء غرفة أو الانضمام مجددًا.";
        socket.connect();
    }
});
socket.on("connect", () => { replaced = false; beginRecovery(); });
socket.on("sessionState", data => {
    connectionEpoch++;
    storeSession(data.session);
    applyState(data);
    finishRecovery();
    joinInvite();
});
socket.on("sessionReplaced", () => {
    replaced = true; connectionReady = false; connectionEpoch++;
    clearInterval(countdown);
    clearTimeout(overlayDelay); clearTimeout(longDelay); clearTimeout(syncRetry);
    overlayDelay = longDelay = syncRetry = null;
    closeDialogs();
    connectionOverlay.classList.remove("hidden");
    connectionMessage.textContent = "تم فتح جلستك في اتصال آخر.";
    reconnectButton.classList.remove("hidden");
    lockPage(true);
    reconnectButton.focus();
});
reconnectButton.addEventListener("click", () => {
    replaced = false;
    reconnectButton.classList.add("hidden");
    connectionMessage.textContent = "جاري إعادة الاتصال…";
    beginRecovery();
    socket.connect();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") synchronize(); });
window.addEventListener("pageshow", event => { if (event.persisted) synchronize(); });
window.addEventListener("offline", () => { if (!replaced) { connectionEpoch++; beginRecovery(); } });
window.addEventListener("online", () => { if (socket.connected) synchronize(); else if (!replaced) socket.connect(); });
socket.on("hostTransferred", data => {
    const notice = el("host-notice");
    notice.textContent = data.message;
    notice.classList.remove("hidden");
    setTimeout(() => notice.classList.add("hidden"), 10000);
});
