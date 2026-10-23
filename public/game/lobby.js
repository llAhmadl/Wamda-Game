// Lobby: room settings, the roster, host controls, confirmations and leaving.
let lobbySettings = { categories: [], selectedCategoryIds: [], scoringMode: 1, duration: 20 };
let settingsPending = false;
let roster = { players: [], hostId: null };
const categoryNodes = new Map();
const startButton = el("start-button");
const copyMessage = el("copy-message");
const lobbyError = el("lobby-error");

function renderLobbySettings() {
    const editable = amHost && !isActiveGame() && !settingsPending;
    const grid = el("category-cards");
    const { categories } = lobbySettings;
    for (const [id, node] of categoryNodes) {
        if (!categories.some(category => category.id === id)) { node.button.remove(); categoryNodes.delete(id); }
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
                changeRoomSettings({ categoryIds: selected.includes(category.id) ? selected.filter(id => id !== category.id) : [...selected, category.id] });
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
        node.button.setAttribute("aria-label", `${category.name} · ${questionsText(category.count || 0)}`);
        node.button.disabled = !editable;
    });
    const selectedCount = lobbySettings.selectedCategoryIds.length;
    const count = lobbySettings.availableQuestionCount ?? categories.filter(c => lobbySettings.selectedCategoryIds.includes(c.id)).reduce((sum, c) => sum + (c.count || 0), 0);
    const sections = arabicCount(selectedCount, ["قسم واحد محدد", "قسمان محددان", "أقسام محددة", "قسمًا محددًا"], "لم تختر أي قسم");
    const available = count ? `${questionsText(count)} ${count === 1 ? "متاح" : count === 2 ? "متاحان" : count % 100 >= 3 && count % 100 <= 10 ? "متاحة" : "متاحًا"}` : "لا توجد أسئلة متاحة";
    el("category-count").textContent = `${sections} · ${available} · تحتاج المباراة 20 سؤالًا`;
    el("category-hint").textContent = amHost ? "" : "المضيف يختار الأقسام. تظهر اختياراته هنا مباشرة.";
    const scoring = el("scoring-mode");
    scoring.value = String(lobbySettings.scoringMode);
    scoring.disabled = !editable;
    el("scoring-description").textContent = lobbySettings.scoringMode === 1 ? "أول إجابة صحيحة تكسب نقطة واحدة."
        : `أول ${lobbySettings.scoringMode} لاعبين يجيبون بشكل صحيح يكسب كل منهم نقطة واحدة.`;
    const duration = el("duration-mode");
    duration.value = String(lobbySettings.duration);
    duration.disabled = !editable;
    startButton.disabled = !editable || !selectedCount;
}

function changeRoomSettings(changes) {
    if (!amHost || isActiveGame() || settingsPending || !socket.connected || !connectionReady) return;
    settingsPending = true;
    lobbyError.textContent = "";
    renderLobbySettings();
    const { selectedCategoryIds: categoryIds, scoringMode, duration } = lobbySettings;
    socket.timeout(10000).emit("updateRoomSettings", { code: currentRoom, categoryIds, scoringMode, duration, ...changes }, (error, response) => {
        settingsPending = false;
        if (error || !response?.ok) lobbyError.textContent = response?.message || "تعذر حفظ إعدادات الغرفة. حاول مجددًا.";
        renderLobbySettings();
    });
}
el("scoring-mode").addEventListener("change", event => changeRoomSettings({ scoringMode: Number(event.target.value) }));
el("duration-mode").addEventListener("change", event => changeRoomSettings({ duration: Number(event.target.value) }));

// One row per player; the host also gets promote/kick controls on everyone else.
function renderPlayers(container, players, hostId) {
    container.innerHTML = "";
    players.forEach(player => {
        const row = document.createElement("div");
        row.className = player.connected === false ? "player is-away" : "player";
        const name = document.createElement("span");
        name.className = "player-name";
        name.textContent = player.name;
        row.appendChild(name);
        if (player.id === hostId) {
            const host = document.createElement("span");
            host.className = "host";
            host.textContent = "المضيف";
            row.appendChild(host);
        }
        if (playerId === hostId && player.id !== playerId) row.appendChild(playerActions(player));
        container.appendChild(row);
    });
}

function renderLobby(data) {
    if (data.gameId !== undefined) gameId = data.gameId;
    const returningToLobby = phase === "finished" && data.phase === "lobby";
    currentRoom = data.code;
    roomCodeText.textContent = data.code;
    roster = { players: data.players, hostId: data.hostId };
    renderPlayers(el("players-list"), data.players, data.hostId);
    if (el("players-dialog").open) renderPlayers(el("players-manage"), data.players, data.hostId);
    el("player-count").textContent = data.players.length;
    copyMessage.textContent = "";
    amHost = playerId === data.hostId;
    if (!amHost) {
        el("host-notice").classList.add("hidden");
        if (el("players-dialog").open) el("players-dialog").close();
    }
    if (data.phase) phase = data.phase;
    lobbySettings = { categories: data.categories || [], selectedCategoryIds: data.selectedCategoryIds || [], scoringMode: data.scoringMode || 1,
        duration: data.duration || 20, availableQuestionCount: data.availableQuestionCount };
    renderLobbySettings();
    updateControls();
    startButton.classList.toggle("hidden", !amHost);
    el("host-message").textContent = amHost ? "ابدأ عندما ينضم الجميع." : "بانتظار المضيف لبدء اللعبة...";
    // "Play again" brings everyone from the final results back to this lobby.
    if (returningToLobby) showScreen("lobby");
}
socket.on("lobbyUpdate", renderLobby);

// ---------- Confirmation ----------
// One dialog for every destructive action; resolves true on confirm.
const confirmDialog = el("confirm-dialog");
let confirmResolve = null;
function confirmAction(title, message, acceptLabel) {
    if (confirmResolve) confirmResolve(false);
    el("confirm-title").textContent = title;
    el("confirm-description").textContent = message;
    el("confirm-accept").textContent = acceptLabel;
    if (!confirmDialog.open) confirmDialog.showModal();
    el("confirm-cancel").focus();
    return new Promise(resolve => { confirmResolve = resolve; });
}
function settleConfirm(value) {
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmDialog.close();
    resolve?.(value);
}
el("confirm-accept").addEventListener("click", () => settleConfirm(true));
el("confirm-cancel").addEventListener("click", () => settleConfirm(false));
el("confirm-close").addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("cancel", event => { event.preventDefault(); settleConfirm(false); });

// ---------- Host controls ----------
function hostCommand(event, target) {
    if (!amHost || !isConnected()) return;
    lobbyError.textContent = "";
    socket.timeout(10000).emit(event, { code: currentRoom, playerId: target.id }, (error, response) => {
        if (error || !response?.ok) {
            const message = response?.message || "تعذر تنفيذ الطلب. حاول مجددًا.";
            lobbyError.textContent = message;
            el("site-error").textContent = isActiveGame() ? message : "";
        }
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
        if (document.createElementNS) {
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
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
        const during = isActiveGame() ? " وتُحذف نقاطه في هذه المباراة" : "";
        if (await confirmAction("إخراج اللاعب؟", `سيخرج ${player.name} من الغرفة${during}. يستطيع العودة برمز الغرفة إذا أرسلته له.`, "إخراج")) hostCommand("kickPlayer", player);
    });
    return actions;
}
// The menu's player manager works in every phase, including mid-match.
function openPlayersDialog() {
    if (!amHost || !currentRoom) return;
    renderPlayers(el("players-manage"), roster.players, roster.hostId);
    if (!el("players-dialog").open) el("players-dialog").showModal();
}

// ---------- Leaving ----------
// After the server confirmed a quit or kick, return home with an optional notice.
function clearRoom(message = "") {
    currentRoom = ""; gameId = null; phase = "lobby"; amHost = false; settingsPending = false;
    roundScores = null;
    clearInterval(countdown);
    roomCodeInput.value = "";
    clearRoomCodeError();
    if (confirmResolve) settleConfirm(false);
    closeDialogs();
    el("host-notice").classList.add("hidden");
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
        else el("site-error").textContent = "تعذر الخروج من اللعبة. حاول مجددًا.";
    });
}

startButton.addEventListener("click", () => {
    if (!amHost || !socket.connected || !connectionReady) return;
    lobbyError.textContent = "";
    socket.timeout(10000).emit("startGame", { code: currentRoom, gameId }, (error, response) => {
        if (error || !response?.ok) lobbyError.textContent = response?.message || "تعذر بدء المباراة. حاول مجددًا.";
    });
});

// ---------- Inviting ----------
el("copy-code").addEventListener("click", async () => {
    if (!currentRoom) return;
    try {
        await navigator.clipboard.writeText(currentRoom);
        copyMessage.textContent = "تم نسخ رمز الغرفة.";
    } catch {
        copyMessage.textContent = "تعذر النسخ. حدّد الرمز أعلاه وانسخه يدويًا.";
    }
});
el("share-invite").addEventListener("click", async () => {
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
el("leave-button").addEventListener("click", () => homeButton.click());
