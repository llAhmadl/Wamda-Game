// Home: name entry, creating and joining rooms, invite links.
function enterHome() {
    const name = cleanPlayerName(nameInput.value);
    if (!name) { nameField.reject(); return; }
    playerName = name;
    if (isConnected()) socket.emit("changeName", { name }, () => {});
    nameField.clear();
    playerNameText.textContent = playerName;
    showScreen("home");
    joinInvite();
}
el("play-button").addEventListener("click", enterHome);
nameInput.addEventListener("keydown", event => { if (event.key === "Enter") enterHome(); });

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
        if (error) { showError("تعذر الوصول للخادم. حاول مرة أخرى.", "home", homeError); return; }
        if (!response?.ok) { onError(response?.message || "تعذر إكمال الطلب. حاول مرة أخرى.", response?.code); return; }
        currentRoom = response.code;
        roomCodeText.textContent = currentRoom;
        showScreen("lobby");
    });
}
createButton.addEventListener("click", () => {
    clearRoomCodeError();
    requestRoom("createRoom", { name: playerName }, message => showError(message, "home", homeError));
});

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
    requestRoom("joinRoom", { name: playerName, code }, (message, reason) => {
        // The room exists but is mid-match: keep the code so the player can try again later.
        if (reason === "MATCH_RUNNING") { roomCodeInput.value = code; showError(message, "home", homeError); return; }
        if (reason !== "NAME_TAKEN") { showRoomCodeError(message); return; }
        // Someone in that room has this name: keep the code, ask for another
        // name (settings.js owns the dialog) and join again once it is saved.
        openRenameDialog(message, () => { roomCodeInput.value = code; joinRoom(); });
    });
}
joinButton.addEventListener("click", joinRoom);
roomCodeInput.addEventListener("keydown", event => { if (event.key === "Enter") joinRoom(); });

// An invite link (/?room=CODE) fills the code and joins once the player has a name.
// A player still in another room (rooms live for a day) is asked before moving;
// mid-match the invite waits for them to finish instead.
let inviteCode = /[?&]room=([A-Za-z0-9]{5})(?:&|$)/.exec(window.location.search || "")?.[1]?.toUpperCase() || null;
function joinInviteCode(code) {
    roomCodeInput.value = code;
    joinRoom();
}
async function joinInvite() {
    if (!inviteCode || !playerName || !socket.connected || !connectionReady) return;
    const code = inviteCode;
    inviteCode = null;
    try { window.history?.replaceState(null, "", "/"); } catch { /* The code still works without a clean URL. */ }
    if (currentRoom === code) return;
    if (!currentRoom) { joinInviteCode(code); return; }
    if (isActiveGame()) { showSiteError("خلّص مباراتك أول، بعدين افتح رابط الدعوة"); return; }
    // The code is Latin: isolate it so the question mark stays at the end of the sentence.
    const move = await confirmAction("تنتقل لغرفة ثانية؟", `تطلع من غرفتك الحالية وتدخل غرفة \u2066${code}\u2069؟`, "انتقال");
    // The match may have started or the room changed while the dialog was open.
    if (!move || !currentRoom || currentRoom === code || isActiveGame() || !isConnected()) return;
    socket.timeout(10000).emit("leaveRoom", {}, (error, response) => {
        if (error || !response?.ok) { showSiteError(response?.message || "تعذر الخروج من غرفتك الحالية. حاول مرة ثانية."); return; }
        clearRoom();
        joinInviteCode(code);
    });
}
