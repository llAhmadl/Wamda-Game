const SESSION_KEY = "wamda-session-v1";
let savedSession = null;
try { savedSession = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* Storage can be unavailable. */ }
if (!savedSession || typeof savedSession.playerId !== "string" || typeof savedSession.reconnectToken !== "string") savedSession = null;
const socket = io({ auth: savedSession || {} });
let playerId = savedSession?.playerId || null;
let gameId = null;
let connectionReady = false;
let homePending = false;
let resetNameOnSync = false;
let connectionEpoch = 0;
let overlayDelay = null;
let longDelay = null;
let syncRetry = null;
let replaced = false;
let previousFocus = null;

// -------------------------
// State
// -------------------------

let playerName = "";
let currentRoom = "";
let countdown = null;
let amHost = false;
let phase = "lobby";
let questionId = null;
let answerLimit = 1;
let displayedWinnerCount = 0;
let answerLeadersSignature = null;
let answerBoardKey = null;
let currentRound = 1;
let lastInRound = false;
let resultsAnimation = null;
let resultMotions = [];
// Round-one scores by player id, so the final results animate overtakes from there.
let roundScores = null;
let lobbySettings = { categories: [], selectedCategoryIds: [], scoringMode: 1 };
let settingsPending = false;
const categoryNodes = new Map();

// -------------------------
// Screens
// -------------------------

const screens = {
    name: document.getElementById("name-screen"),
    home: document.getElementById("home-screen"),
    lobby: document.getElementById("lobby-screen"),
    game: document.getElementById("game-screen"),
    results: document.getElementById("results-screen")
};

function stopResultsAnimation() {
    clearInterval(resultsAnimation);
    resultsAnimation = null;
    resultMotions.forEach(animation => animation.cancel());
    resultMotions = [];
}

function isDeveloperPage() { return Boolean(window.WamdaNavigation?.isDeveloperPage()); }
function focusCurrentPageHeading() {
    const heading = isDeveloperPage() ? document.getElementById("developer-title")
        : Object.values(screens).find(screen => !screen.classList.contains("hidden"))?.querySelector("h1");
    heading?.focus({ preventScroll: true });
}

function showScreen(screenName) {
    stopResultsAnimation();

    for (const screen of Object.values(screens)) {
        screen.classList.add("hidden");
    }

    screens[screenName].classList.remove("hidden");
    if (isDeveloperPage()) return;

    const heading = screens[screenName].querySelector("h1");
    if (heading) heading.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}

// -------------------------
// Elements
// -------------------------

const nameInput =
    document.getElementById("name-input");

const playButton =
    document.getElementById("play-button");

const playerNameText =
    document.getElementById("player-name");

const createButton =
    document.getElementById("create-button");

const joinButton =
    document.getElementById("join-button");

const roomCodeInput =
    document.getElementById("room-code-input");

const homeError =
    document.getElementById("home-error");

const roomCodeText =
    document.getElementById("room-code");

const playersList =
    document.getElementById("players-list");

const hostMessage =
    document.getElementById("host-message");

const startButton =
    document.getElementById("start-button");

const questionNumber =
    document.getElementById("question-number");

const questionText =
    document.getElementById("question-text");

const choicesContainer =
    document.getElementById("choices");

const answerMessage =
    document.getElementById("answer-message");

const timerElement =
    document.getElementById("timer");

const nextQuestionButton = document.getElementById("next-question-button");
const nextRoundButton = document.getElementById("next-round-button");

function updateControls() {
    document.getElementById("quit-button").classList.toggle("hidden", !currentRoom);
    const logo = document.getElementById("home-logo");
    logo.disabled = homePending;
    logo.title = isDeveloperPage() ? "العودة للعبة" : isActiveGame() ? "تحديث الصفحة واستعادة المباراة" : "العودة إلى صفحة الاسم";
    logo.setAttribute("aria-label", `وَمْضة — ${logo.title}`);
    nextQuestionButton.classList.add("hidden");
    nextRoundButton.classList.add("hidden");
    if (phase === "review" && amHost) nextQuestionButton.classList.remove("hidden");
    if (phase === "roundResults" && amHost) nextRoundButton.classList.remove("hidden");
    nextQuestionButton.textContent = lastInRound ? "عرض نتائج الجولة" : "السؤال التالي";
    document.getElementById("advance-message").textContent = phase === "review" ? (amHost ? "انتقل عندما يكون الجميع جاهزًا." : "بانتظار المضيف للمتابعة...") : "";
    document.getElementById("round-message").textContent = phase === "roundResults" ? (amHost ? "ابدأ الجولة التالية عندما يكون الجميع جاهزًا." : "بانتظار المضيف لبدء الجولة التالية...") : "";
}
nextQuestionButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextQuestion", { code: currentRoom, gameId, questionId }); });
nextRoundButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextRound", { code: currentRoom, gameId, round: currentRound }); });

const resultsList =
    document.getElementById("results-list");

const homeButton =
    document.getElementById("home-button");

const nameError = document.getElementById("name-error");
const nameField = createNameField(nameInput, document.getElementById("name-label"), nameError);
const playerCount = document.getElementById("player-count");
const copyCodeButton = document.getElementById("copy-code");
const copyMessage = document.getElementById("copy-message");
const connectionOverlay = document.getElementById("connection-overlay");
const connectionMessage = document.getElementById("connection-message");
const reconnectButton = document.getElementById("reconnect-button");

function lockPage(locked) {
    for (const element of document.querySelectorAll("body > header, body > main, body > dialog")) element.inert = locked;
}
function beginRecovery() {
    connectionReady = false;
    clearInterval(countdown);
    if (overlayDelay !== null) return;
    // A quick wake sync must keep the developer's current editing position.
    if (isDeveloperPage()) previousFocus = document.activeElement;
    overlayDelay = setTimeout(() => {
        previousFocus = document.activeElement;
        // An open modal lives above fixed overlays, so close it before blocking the page.
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
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
            const selected = choicesContainer.querySelectorAll("button")[state.answer.answerIndex];
            selected?.classList.add("selected");
            selected?.setAttribute("aria-pressed", "true");
            choicesContainer.querySelectorAll("button").forEach(button => { button.disabled = true; });
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
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
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
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") synchronize();
});
window.addEventListener("pageshow", event => { if (event.persisted) synchronize(); });
window.addEventListener("offline", () => { if (!replaced) { connectionEpoch++; beginRecovery(); } });
window.addEventListener("online", () => { if (socket.connected) synchronize(); else if (!replaced) socket.connect(); });
socket.on("hostTransferred", data => {
    const notice = document.getElementById("host-notice");
    notice.textContent = data.message;
    notice.classList.remove("hidden");
    setTimeout(() => notice.classList.add("hidden"), 10000);
});
function isConnected() {
    if (socket.connected && connectionReady) return true;
    homeError.textContent = "لم يتم الاتصال بعد. حاول بعد قليل.";
    return false;
}

// -------------------------
// Name
// -------------------------

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

function enterHome() {

    const name = cleanPlayerName(nameInput.value);

    if (!name) {

        nameField.reject();

        return;
    }

    playerName = name;
    if (isConnected()) socket.emit("changeName", { name }, () => {});

    nameField.clear();

    playerNameText.textContent =
        playerName;

    showScreen("home");
    joinInvite();
}

playButton.addEventListener(
    "click",
    enterHome
);

nameInput.addEventListener(
    "keydown",
    event => {

        if (event.key === "Enter") {
            enterHome();
        }
    }
);

// -------------------------
// Create Room
// -------------------------

// Create and join share one guarded request: a lost reply (sleeping server,
// dropped network) re-enables the buttons instead of leaving them stuck.
let roomRequestPending = false;
function requestRoom(event, data, onError) {
    if (roomRequestPending || !isConnected()) return;
    roomRequestPending = true;
    createButton.disabled = joinButton.disabled = true;
    socket.timeout(10000).emit(event, data, (error, response) => {
        roomRequestPending = false;
        createButton.disabled = joinButton.disabled = false;
        if (error) { homeError.textContent = "تعذر الوصول للخادم. حاول مرة أخرى."; return; }
        if (!response?.ok) { onError(response?.message || "تعذر إكمال الطلب. حاول مرة أخرى."); return; }
        currentRoom = response.code;
        roomCodeText.textContent = currentRoom;
        showScreen("lobby");
    });
}

createButton.addEventListener("click", () => {
    clearRoomCodeError();
    requestRoom("createRoom", { name: playerName }, message => { homeError.textContent = message; });
});

// -------------------------
// Join Room
// -------------------------

joinButton.addEventListener(
    "click",
    joinRoom
);

roomCodeInput.addEventListener(
    "keydown",
    event => {

        if (event.key === "Enter") {
            joinRoom();
        }
    }
);

const roomCodePlaceholder = roomCodeInput.getAttribute("placeholder");
function clearRoomCodeError() {
    roomCodeInput.removeAttribute("aria-invalid");
    roomCodeInput.setAttribute("placeholder", roomCodePlaceholder);
    homeError.classList.remove("sr-only");
    homeError.textContent = "";
}
function showRoomCodeError(message) {
    roomCodeInput.value = "";
    roomCodeInput.setAttribute("aria-invalid", "true");
    roomCodeInput.setAttribute("placeholder", message);
    homeError.classList.add("sr-only");
    homeError.textContent = message;
    roomCodeInput.focus();
}
roomCodeInput.addEventListener("input", clearRoomCodeError);

function joinRoom() {
    clearRoomCodeError();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) { showRoomCodeError(roomCodePlaceholder); return; }
    requestRoom("joinRoom", { name: playerName, code }, showRoomCodeError);
}

// An invite link (/?room=CODE) fills the code and joins once the player has a name.
let inviteCode = /[?&]room=([A-Za-z0-9]{5})(?:&|$)/.exec(window.location.search || "")?.[1]?.toUpperCase() || null;
function joinInvite() {
    if (!inviteCode || !playerName || !socket.connected || !connectionReady || isDeveloperPage()) return;
    const code = inviteCode;
    inviteCode = null;
    try { window.history?.replaceState(null, "", "/"); } catch { /* The code still works without a clean URL. */ }
    if (currentRoom) return;
    roomCodeInput.value = code;
    joinRoom();
}

// -------------------------
// Lobby Updates
// -------------------------

function isActiveGame() {
    return Boolean(currentRoom) && ["question", "review", "roundResults"].includes(phase);
}

function renderLobbySettings() {
    const editable = amHost && !isActiveGame() && !settingsPending;
    const grid = document.getElementById("category-cards");
    const categories = lobbySettings.categories;
    for (const [id, node] of categoryNodes) {
        if (!categories.some(category => category.id === id)) {
            node.button.remove();
            categoryNodes.delete(id);
        }
    }
    categories.forEach(category => {
        let node = categoryNodes.get(category.id);
        if (!node) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "category-card";
            const image = document.createElement("img");
            image.alt = ""; image.loading = "lazy"; image.decoding = "async";
            image.width = 480; image.height = 360;
            const check = document.createElement("span");
            check.className = "category-check";
            check.setAttribute("aria-hidden", "true");
            const name = document.createElement("span");
            name.className = "category-name";
            button.appendChild(image); button.appendChild(check); button.appendChild(name);
            button.addEventListener("click", () => {
                const selected = lobbySettings.selectedCategoryIds;
                changeRoomSettings(selected.includes(category.id) ? selected.filter(id => id !== category.id) : [...selected, category.id], lobbySettings.scoringMode);
            });
            node = { button, image, check, name };
            categoryNodes.set(category.id, node);
            grid.appendChild(button);
        }
        const selected = lobbySettings.selectedCategoryIds.includes(category.id);
        node.image.src = category.image || "/images/categories/placeholder.svg";
        node.name.textContent = category.name;
        node.check.textContent = selected ? "✓" : "";
        node.button.setAttribute("aria-pressed", String(selected));
        node.button.setAttribute("aria-label", `${category.name} · ${category.count || 0} سؤالًا`);
        node.button.disabled = !editable;
    });
    const count = lobbySettings.availableQuestionCount ?? categories.filter(c => lobbySettings.selectedCategoryIds.includes(c.id)).reduce((sum, c) => sum + (c.count || 0), 0);
    document.getElementById("category-count").textContent = `${lobbySettings.selectedCategoryIds.length} أقسام محددة · ${count} سؤالًا متاحًا · تحتاج المباراة 20 سؤالًا`;
    document.getElementById("category-hint").textContent = amHost ? "" : "المضيف يختار الأقسام. تظهر اختياراته هنا مباشرة.";
    const scoring = document.getElementById("scoring-mode");
    scoring.value = String(lobbySettings.scoringMode);
    scoring.disabled = !editable;
    document.getElementById("scoring-description").textContent = lobbySettings.scoringMode === 1 ? "أول إجابة صحيحة تكسب نقطة واحدة." : `أول ${lobbySettings.scoringMode} لاعبين يجيبون بشكل صحيح يكسب كل منهم نقطة واحدة.`;
    startButton.disabled = !editable || !lobbySettings.selectedCategoryIds.length;
}

function changeRoomSettings(categoryIds, scoringMode) {
    if (!amHost || isActiveGame() || settingsPending || !socket.connected || !connectionReady) return;
    settingsPending = true;
    document.getElementById("lobby-error").textContent = "";
    renderLobbySettings();
    socket.timeout(10000).emit("updateRoomSettings", { code: currentRoom, categoryIds, scoringMode }, (error, response) => {
        settingsPending = false;
        if (error || !response?.ok) document.getElementById("lobby-error").textContent = response?.message || "تعذر حفظ إعدادات الغرفة. حاول مجددًا.";
        renderLobbySettings();
    });
}
document.getElementById("scoring-mode").addEventListener("change", event => changeRoomSettings(lobbySettings.selectedCategoryIds, Number(event.target.value)));

function renderLobby(data) {
        if (data.gameId !== undefined) gameId = data.gameId;

        currentRoom = data.code;

        roomCodeText.textContent =
            data.code;

        playersList.innerHTML = "";

        playerCount.textContent = data.players.length;
        copyMessage.textContent = "";

        data.players.forEach(player => {

            const row =
                document.createElement("div");

            row.className = player.connected === false ? "player is-away" : "player";

            const name =
                document.createElement("span");

            name.className = "player-name";

            name.textContent =
                player.name;

            row.appendChild(name);

            if (player.id === data.hostId) {

                const host =
                    document.createElement("span");

                host.className = "host";

                host.textContent = "المضيف";

                row.appendChild(host);
            }

            if (playerId === data.hostId && player.id !== playerId) row.appendChild(playerActions(player));

            playersList.appendChild(row);
        });

        amHost = playerId === data.hostId;
        if (!amHost) document.getElementById("host-notice").classList.add("hidden");
        if (data.phase) phase = data.phase;
        lobbySettings = { categories: data.categories || [], selectedCategoryIds: data.selectedCategoryIds || [], scoringMode: data.scoringMode || 1, availableQuestionCount: data.availableQuestionCount };
        renderLobbySettings();
        updateControls();

        if (amHost) {

            startButton.classList.remove(
                "hidden"
            );

            hostMessage.textContent =
                "ابدأ عندما ينضم الجميع.";

        } else {

            startButton.classList.add(
                "hidden"
            );

            hostMessage.textContent =
                "بانتظار المضيف لبدء اللعبة...";
        }
}
socket.on("lobbyUpdate", renderLobby);

// One confirmation dialog for every destructive action; resolves true on confirm.
const confirmDialog = document.getElementById("confirm-dialog");
let confirmResolve = null;
function confirmAction(title, message, acceptLabel) {
    if (confirmResolve) confirmResolve(false);
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-description").textContent = message;
    document.getElementById("confirm-accept").textContent = acceptLabel;
    if (!confirmDialog.open) confirmDialog.showModal();
    document.getElementById("confirm-cancel").focus();
    return new Promise(resolve => { confirmResolve = resolve; });
}
function settleConfirm(value) {
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmDialog.close();
    resolve?.(value);
}
document.getElementById("confirm-accept").addEventListener("click", () => settleConfirm(true));
document.getElementById("confirm-cancel").addEventListener("click", () => settleConfirm(false));
document.getElementById("confirm-close").addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("cancel", event => { event.preventDefault(); settleConfirm(false); });

function hostCommand(event, target) {
    if (!amHost || !isConnected()) return;
    document.getElementById("lobby-error").textContent = "";
    socket.timeout(10000).emit(event, { code: currentRoom, playerId: target.id }, (error, response) => {
        if (error || !response?.ok) document.getElementById("lobby-error").textContent = response?.message || "تعذر تنفيذ الطلب. حاول مجددًا.";
    });
}
function playerActions(player) {
    const actions = document.createElement("span");
    actions.className = "player-actions";
    const make = (className, label, path, onClick) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `player-action ${className}`;
        button.setAttribute("aria-label", label);
        button.title = label;
        const icon = document.createElementNS?.("http://www.w3.org/2000/svg", "svg");
        if (icon) {
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("aria-hidden", "true");
            const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
            shape.setAttribute("d", path);
            icon.appendChild(shape);
            button.appendChild(icon);
        }
        button.addEventListener("click", onClick);
        actions.appendChild(button);
    };
    if (player.connected !== false) make("promote", `جعل ${player.name} المضيف`, "M3 8l4 4 5-7 5 7 4-4-2 11H5Z", async () => {
        if (await confirmAction("نقل الاستضافة؟", `سيصبح ${player.name} المضيف ويتحكم بالغرفة بدلًا منك.`, "نقل الاستضافة")) hostCommand("makeHost", player);
    });
    make("kick", `إخراج ${player.name}`, "M6 6l12 12M18 6 6 18", async () => {
        if (await confirmAction("إخراج اللاعب؟", `سيخرج ${player.name} من الغرفة. يستطيع العودة برمز الغرفة إذا أرسلته له.`, "إخراج")) hostCommand("kickPlayer", player);
    });
    return actions;
}

// Leaving locally after the server confirmed (quit, kick) returns to home.
function clearRoom(message = "") {
    currentRoom = ""; gameId = null; phase = "lobby"; amHost = false; settingsPending = false;
    roundScores = null;
    clearInterval(countdown);
    roomCodeInput.value = "";
    clearRoomCodeError();
    if (confirmResolve) settleConfirm(false);
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
    document.getElementById("host-notice").classList.add("hidden");
    updateControls();
    showScreen(playerName ? "home" : "name");
    homeError.textContent = message;
}
socket.on("kicked", data => clearRoom(data?.message || "أخرجك المضيف من الغرفة."));

async function requestQuitGame() {
    if (!currentRoom || homePending || replaced) return;
    const active = isActiveGame() || phase === "finished";
    const leave = await confirmAction("الخروج من اللعبة؟",
        active ? "ستخرج من المباراة وتفقد نقاطك فيها، وتستطيع بعدها إنشاء غرفة جديدة أو الانضمام لغيرها." : "ستغادر غرفة الانتظار.",
        "خروج");
    if (!leave || !currentRoom || !isConnected()) return;
    socket.timeout(10000).emit("quitMatch", {}, (error, response) => {
        if (!error && response?.ok) clearRoom();
        else document.getElementById("site-error").textContent = "تعذر الخروج من اللعبة. حاول مجددًا.";
    });
}

// -------------------------
// Start Game
// -------------------------

startButton.addEventListener(
    "click",
    () => {

        if (!amHost || !socket.connected || !connectionReady) return;
        document.getElementById("lobby-error").textContent = "";
        socket.timeout(10000).emit(
            "startGame",
            {
                code: currentRoom, gameId
            },
            (error, response) => {
                if (error || !response?.ok) document.getElementById("lobby-error").textContent = response?.message || "تعذر بدء المباراة. حاول مجددًا.";
            }
        );
    }
);

// -------------------------
// Question
// -------------------------

function renderQuestion(data) {
        gameId = data.gameId;

        phase = "question";
        questionId = data.questionId;
        currentRound = data.round;
        answerLimit = [1, 3, 5, 7].includes(data.scoringMode) ? data.scoringMode : lobbySettings.scoringMode;
        const boardKey = JSON.stringify([gameId, questionId, answerLimit]);
        if (boardKey !== answerBoardKey) {
            answerBoardKey = boardKey;
            displayedWinnerCount = 0;
            answerLeadersSignature = null;
        }
        renderAnswerLeaders(data.winners || []);
        updateControls();
        showScreen("game");

        answerMessage.textContent = "";

        answerMessage.className =
            "answer-message";

        questionNumber.textContent =
            `الجولة ${["الأولى", "الثانية"][data.round - 1] || data.round} | سؤال ${data.number}`;

        questionText.textContent =
            data.question;

        choicesContainer.innerHTML = "";

        data.choices.forEach(
            (choice, index) => {

                const button =
                    document.createElement(
                        "button"
                    );

                button.className =
                    "choice";

                const letter = document.createElement("span");
                letter.className = "choice-letter";
                letter.textContent = ["A", "B", "C", "D"][index];
                letter.setAttribute("aria-hidden", "true");

                const label = document.createElement("span");
                label.className = "choice-text";
                label.textContent = choice;

                button.appendChild(letter);
                button.appendChild(label);
                button.setAttribute("aria-pressed", "false");

                button.addEventListener(
                    "click",
                    () => {

                        submitAnswer(
                            index,
                            button
                        );
                    }
                );

                choicesContainer.appendChild(
                    button
                );
            }
        );

        startTimer(data);
}
socket.on("question", renderQuestion);

// Each update replaces the server-owned order; retries never append extra rows.
function renderAnswerLeaders(winners) {
    if (!Array.isArray(winners) || winners.length < displayedWinnerCount) return;
    const accepted = winners.slice(0, answerLimit);
    const signature = JSON.stringify([answerLimit, accepted.map(winner => [winner.id, winner.name])]);
    if (signature === answerLeadersSignature) return;
    answerLeadersSignature = signature;
    displayedWinnerCount = accepted.length;
    const list = document.getElementById("answer-leaders");
    list.innerHTML = "";
    for (let index = 0; index < answerLimit; index++) {
        const winner = accepted[index];
        const row = document.createElement("li");
        row.className = winner ? "answer-leader is-filled" : "answer-leader";
        const rank = document.createElement("span");
        rank.className = "answer-rank";
        rank.textContent = `${index + 1}.`;
        rank.setAttribute("aria-hidden", "true");
        const name = document.createElement("bdi");
        name.className = "answer-player";
        name.textContent = winner ? winner.name : "—";
        if (!winner) row.setAttribute("aria-label", `المركز ${index + 1}، بانتظار إجابة صحيحة`);
        row.appendChild(rank);
        row.appendChild(name);
        list.appendChild(row);
    }
}
socket.on("answerProgress", data => {
    if (data.gameId !== gameId || data.questionId !== questionId || !["question", "review"].includes(phase)) return;
    renderAnswerLeaders(data.winners);
});

// -------------------------
// Answer
// -------------------------

function submitAnswer(
    answerIndex,
    selectedButton
) {

    if (selectedButton.disabled || !isConnected() || phase !== "question") return;

    const buttons =
        choicesContainer.querySelectorAll(
            "button"
        );

    buttons.forEach(button => {
        button.disabled = true;
    });

    selectedButton.classList.add("selected");
    selectedButton.setAttribute("aria-pressed", "true");
    answerMessage.textContent = "تم إرسال إجابتك.";

    socket.emit(
        "submitAnswer",
        {
            code: currentRoom,
            answerIndex, questionId, gameId
        }
    );
}

function renderAnswer(data) {

        const correctButton = choicesContainer.querySelectorAll("button")[data.correctIndex];
        if (correctButton) correctButton.classList.add("is-correct");
        const selected = choicesContainer.querySelector(".selected");
        if (selected) {
            selected.classList.add(data.correct ? "is-correct" : "is-wrong");
        }

        // Keep feedback visual, with labels available to screen readers.
        answerMessage.textContent = "";
        if (correctButton) correctButton.setAttribute("aria-label", `${correctButton.textContent}، الإجابة الصحيحة`);
        if (selected && !data.correct) selected.setAttribute("aria-label", `${selected.textContent}، إجابتك خاطئة`);

}
socket.on("answerResult", renderAnswer);

// -------------------------
// Question review: wait for an explicit host action.
function renderReview(data) {
    clearInterval(countdown);
    phase = "review";
    lastInRound = data.lastInRound;
    renderAnswerLeaders(data.winners || (data.winner ? [data.winner] : []));
    choicesContainer.querySelectorAll("button").forEach((button, index) => {
        button.disabled = true;
        if (index === data.correctIndex) button.classList.add("is-correct");
    });
    const selected = choicesContainer.querySelector(".selected");
    if (selected) {
        const index = Array.from(choicesContainer.querySelectorAll("button")).indexOf(selected);
        if (index !== data.correctIndex) selected.classList.add("is-wrong");
    }
    if (data.winners?.length) {
        const earned = data.winners.find(winner => winner.id === playerId);
        answerMessage.textContent = earned ? `إجابة صحيحة! +${earned.awardedPoints} نقطة` : `أجاب ${data.winners.length} من اللاعبين بشكل صحيح.`;
    } else if (data.winner) {
        answerMessage.textContent = data.winner.id === playerId ? "سبقت الجميع! +1 نقطة" : `حسم ${data.winner.name} السؤال.`;
    } else if (data.reason === "timeout" || !data.reason) {
        timerElement.textContent = "0";
        answerMessage.textContent = "انتهى الوقت.";
    }
    updateControls();
}
socket.on("questionClosed", renderReview);

// -------------------------
// Timer
// -------------------------

function startTimer(data) {
    clearInterval(countdown);
    // Derive from the server deadline and advance against a monotonic clock.
    // Background-tab throttling cannot turn delayed ticks into extra seconds.
    const remainingMs = Math.max(0, data.deadline - data.serverNow);
    const endsAt = performance.now() + remainingMs;
    function paint() {
        const remaining = Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));
        timerElement.textContent = remaining;
        timerElement.parentElement.dataset.low = String(remaining <= 5);
        document.getElementById("timer-bar")?.style?.setProperty("--time-left", String(Math.max(0, endsAt - performance.now()) / ((data.duration || 20) * 1000)));
        if (remaining === 0) {
            clearInterval(countdown);
            choicesContainer.querySelectorAll("button").forEach(button => { button.disabled = true; });
            if (!choicesContainer.querySelector(".selected")) answerMessage.textContent = "انتهى الوقت. بانتظار المضيف للمتابعة.";
        }
    }
    countdown = setInterval(paint, 200);
    paint();
}

// -------------------------
// Results
// -------------------------

// Only live round endings animate; a restored snapshot shows the settled ranking.
function showResults(data, final, live = false) {
        phase = final ? "finished" : "roundResults";
        currentRound = data.round;
        updateControls();
        document.getElementById("results-title").textContent = final ? "النتائج النهائية" : `نتائج الجولة ${data.round}`;
        document.getElementById("results-message").textContent = final ? "اكتملت الجولتان، شكرًا للعبكم!" : "انتهت الجولة الأولى. النقاط مستمرة في الجولة الثانية.";
        homeButton.classList.remove("hidden");
        if (!final) homeButton.classList.add("hidden");

        clearInterval(countdown);

        showScreen("results");

        const from = final ? roundScores : null;
        roundScores = final ? null : new Map(data.ranking.map(player => [player.id, player.score]));
        renderRanking(data.ranking, live && !isDeveloperPage(), from);
}

function renderRanking(ranking, animateScores, from = null) {
    const alphabetical = new Intl.Collator("ar", { sensitivity: "base", numeric: true });
    const entries = ranking.map(player => {
        const row = document.createElement("div");
        row.className = "result-row";
        const position = document.createElement("span");
        position.className = "position";
        const name = document.createElement("span");
        name.textContent = player.name;
        const score = document.createElement("span");
        score.className = "result-score";
        row.appendChild(position);
        row.appendChild(name);
        row.appendChild(score);
        const start = Math.min(player.score, from?.get(player.id) ?? 0);
        return { player, row, position, score, start, displayed: start };
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = animateScores && !reducedMotion && entries.some(entry => entry.player.score > entry.start);
    const at = (entry, progress) => entry.start + Math.floor((entry.player.score - entry.start) * progress);
    resultsList.innerHTML = "";

    function paint(progress, move) {
        const oldPositions = new Map();
        if (move) entries.forEach(entry => oldPositions.set(entry, entry.row.getBoundingClientRect().top));
        resultMotions.forEach(animation => animation.cancel());
        resultMotions = [];
        entries.forEach(entry => { entry.displayed = at(entry, progress); });
        entries.sort((a, b) => b.displayed - a.displayed || alphabetical.compare(a.player.name, b.player.name));
        let rank = 0;
        entries.forEach((entry, index) => {
            if (index === 0 || entry.displayed !== entries[index - 1].displayed) rank = index + 1;
            entry.position.textContent = rank;
            entry.score.textContent = `${entry.displayed} نقطة`;
            entry.row.classList.remove("winner");
            if (rank === 1 && (progress === 1 || entry.displayed > 0)) entry.row.classList.add("winner");
            resultsList.appendChild(entry.row);
        });
        if (move) entries.forEach(entry => {
            const offset = oldPositions.get(entry) - entry.row.getBoundingClientRect().top;
            if (offset && entry.row.animate) {
                resultMotions.push(entry.row.animate([
                    { transform: `translateY(${offset}px)` },
                    { transform: "translateY(0)" }
                ], { duration: 850, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" }));
            }
        });
    }

    paint(animate ? 0 : 1, false);
    if (!animate) return;
    // Count in place, then reorder once. Never interrupt a moving row.
    let elapsed = 0;
    resultsAnimation = setInterval(() => {
        elapsed += 100;
        if (elapsed <= 600) return;
        const progress = Math.min(1, (elapsed - 600) / 1400);
        entries.forEach(entry => {
            entry.displayed = at(entry, progress);
            entry.score.textContent = `${entry.displayed} نقطة`;
            entry.position.textContent = "—";
        });
        if (elapsed >= 2300) {
            paint(1, true);
            clearInterval(resultsAnimation);
            resultsAnimation = null;
        }
    }, 100);
}
socket.on("gameOver", data => showResults(data, true, true));
socket.on("roundOver", data => showResults(data, false, true));

// -------------------------
// Back Home
// -------------------------

copyCodeButton.addEventListener("click", async () => {
    if (!currentRoom) return;
    try {
        await navigator.clipboard.writeText(currentRoom);
        copyMessage.textContent = "تم نسخ رمز الغرفة.";
    } catch {
        copyMessage.textContent = "تعذر النسخ. حدّد الرمز أعلاه وانسخه يدويًا.";
    }
});

document.getElementById("share-invite").addEventListener("click", async () => {
    if (!currentRoom) return;
    const url = `${window.location.origin}/?room=${currentRoom}`;
    try {
        if (navigator.share) {
            await navigator.share({ title: "وَمْضة", text: `انضم لغرفتي في وَمْضة — الرمز ${currentRoom}`, url });
            return;
        }
        await navigator.clipboard.writeText(url);
        copyMessage.textContent = "تم نسخ رابط الدعوة.";
    } catch (error) {
        if (error?.name !== "AbortError") copyMessage.textContent = "تعذرت المشاركة. انسخ الرمز وأرسله يدويًا.";
    }
});

document.getElementById("leave-button").addEventListener("click", () => {
    homeButton.click();
});

function returnHome() {
    if (isActiveGame()) return;
    const finish = () => {
        currentRoom = "";
        gameId = null;
        phase = "lobby";
        settingsPending = false;
        roomCodeInput.value = "";
        clearRoomCodeError();
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
        updateControls();
        showScreen(playerName ? "home" : "name");
    };
    if (!currentRoom) { finish(); return; }
    if (!socket.connected || !connectionReady) return;
    socket.timeout(10000).emit("leaveRoom", {}, (error, response) => {
        if (!error && response?.ok) finish();
        else document.getElementById("lobby-error").textContent = response?.message || "تعذر مغادرة الغرفة. حاول مجددًا.";
    });
}
function refreshActiveGame() {
    // Reload only when credentials will survive it. Restricted storage gets the
    // same fresh server snapshot over the current authenticated connection.
    let canReload = false;
    try {
        if (savedSession) {
            const serialized = JSON.stringify(savedSession);
            localStorage.setItem(SESSION_KEY, serialized);
            canReload = localStorage.getItem(SESSION_KEY) === serialized;
        }
    } catch { /* Keep the live session when browser storage is unavailable. */ }
    resetNameOnSync = false;
    if (!canReload) { synchronize(); return; }
    homePending = true;
    updateControls();
    window.location.reload();
}

homeButton.addEventListener("click", returnHome);
document.addEventListener("wamda:pagechange", updateControls);
document.getElementById("home-logo").addEventListener("click", () => {
    if (isDeveloperPage()) { window.WamdaNavigation.closeDeveloperPage(); return; }
    if (homePending || replaced) return;
    if (isActiveGame()) {
        if (connectionReady && socket.connected) refreshActiveGame();
        return;
    }
    if (!isConnected()) return;
    homePending = true;
    resetNameOnSync = true;
    updateControls();
    document.getElementById("site-error").textContent = "";
    beginRecovery();
    // Cancel outstanding wake-up snapshots before leaving the current room.
    const epoch = ++connectionEpoch;
    socket.timeout(10000).emit("resetSession", {}, (error, response) => {
        homePending = false;
        updateControls();
        if (epoch !== connectionEpoch) return;
        if (!error && response?.code === "GAME_ACTIVE") {
            resetNameOnSync = false;
            synchronize();
            return;
        }
        if (!error && response?.ok) {
            roomCodeInput.value = "";
            clearRoomCodeError();
            document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
            document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
            document.getElementById("host-notice").classList.add("hidden");
            applyState(response);
            finishRecovery();
            return;
        }
        document.getElementById("site-error").textContent = "تعذرت العودة لصفحة الاسم. حاول مجددًا بعد عودة الاتصال.";
        // The departure may have reached the server even if its acknowledgement was
        // lost. Resolve that from a fresh snapshot before enabling interaction.
        synchronize();
    });
});
