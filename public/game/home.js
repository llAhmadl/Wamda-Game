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
joinButton.addEventListener("click", joinRoom);
roomCodeInput.addEventListener("keydown", event => { if (event.key === "Enter") joinRoom(); });

// An invite link (/?room=CODE) fills the code and joins once the player has a name.
let inviteCode = /[?&]room=([A-Za-z0-9]{5})(?:&|$)/.exec(window.location.search || "")?.[1]?.toUpperCase() || null;
function joinInvite() {
    if (!inviteCode || !playerName || !socket.connected || !connectionReady) return;
    const code = inviteCode;
    inviteCode = null;
    try { window.history?.replaceState(null, "", "/"); } catch { /* The code still works without a clean URL. */ }
    if (currentRoom) return;
    roomCodeInput.value = code;
    joinRoom();
}
