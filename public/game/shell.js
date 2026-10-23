// Shell: the brand button. Mid-match it refreshes; otherwise it starts over at name entry.
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

el("home-logo").addEventListener("click", () => {
    if (homePending || replaced) return;
    if (isActiveGame()) {
        if (connectionReady && socket.connected) refreshActiveGame();
        return;
    }
    if (!isConnected()) return;
    homePending = true;
    resetNameOnSync = true;
    updateControls();
    el("site-error").textContent = "";
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
            closeDialogs();
            el("host-notice").classList.add("hidden");
            applyState(response);
            finishRecovery();
            return;
        }
        el("site-error").textContent = "تعذرت العودة لصفحة الاسم. حاول مجددًا بعد عودة الاتصال.";
        // The departure may have reached the server even if its acknowledgement was
        // lost. Resolve that from a fresh snapshot before enabling interaction.
        synchronize();
    });
});
