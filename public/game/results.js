// Results: animated rankings, the final celebration and playing again.
let resultsAnimation = null;
let resultMotions = [];
// Round-one scores by player id, so the final results animate overtakes from there.
let roundScores = null;
const resultsList = el("results-list");
const playAgainButton = el("play-again-button");

function stopResultsAnimation() {
    clearInterval(resultsAnimation);
    resultsAnimation = null;
    resultMotions.forEach(animation => animation.cancel());
    resultMotions = [];
}

// Final results: the host can restart in this room; everyone can still go home.
function updateResultActions() {
    const finished = phase === "finished" && Boolean(currentRoom);
    playAgainButton.classList.toggle("hidden", !(finished && amHost));
    homeButton.classList.toggle("hidden", phase === "roundResults");
    homeButton.classList.toggle("primary", !(finished && amHost));
    homeButton.classList.toggle("secondary", finished && amHost);
}

// Only live round endings animate; a restored snapshot shows the settled ranking.
function showResults(data, final, live = false) {
    phase = final ? "finished" : "roundResults";
    currentRound = data.round;
    updateControls();
    el("results-title").textContent = final ? "النتائج النهائية" : `نتائج الجولة ${data.round}`;
    el("results-message").textContent = final ? "اكتملت الجولتان، شكرًا للعبكم!" : "انتهت الجولة الأولى. النقاط مستمرة في الجولة الثانية.";
    clearInterval(countdown);
    showScreen("results");
    const from = final ? roundScores : null;
    roundScores = final ? null : new Map(data.ranking.map(player => [player.id, player.score]));
    renderRanking(data.ranking, live, from, final && live);
}

function renderRanking(ranking, animateScores, from = null, celebrateEnd = false) {
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
    const animate = animateScores && !reducedMotion() && entries.some(entry => entry.player.score > entry.start);
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
            entry.score.textContent = pointsText(entry.displayed);
            entry.row.className = "result-row";
            const settled = progress === 1 || entry.displayed > 0;
            if (rank === 1 && settled) {
                entry.row.classList.add("winner");
                const crown = crownIcon();
                if (crown) entry.position.appendChild(crown);
            }
            if (settled && rank <= 3 && entry.displayed > 0) entry.row.classList.add(`place-${rank}`);
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
    const finale = () => { if (celebrateEnd && entries.some(entry => entry.player.score > 0)) { celebrate(); sound.play("win"); } };

    paint(animate ? 0 : 1, false);
    if (!animate) { finale(); return; }
    // Count in place, then reorder once. Never interrupt a moving row.
    let elapsed = 0;
    resultsAnimation = setInterval(() => {
        elapsed += 100;
        if (elapsed <= 600) return;
        const progress = Math.min(1, (elapsed - 600) / 1400);
        entries.forEach(entry => {
            entry.displayed = at(entry, progress);
            entry.score.textContent = pointsText(entry.displayed);
            entry.position.textContent = "—";
        });
        if (elapsed >= 2300) {
            paint(1, true);
            clearInterval(resultsAnimation);
            resultsAnimation = null;
            finale();
        }
    }, 100);
}
socket.on("gameOver", data => showResults(data, true, true));
socket.on("roundOver", data => showResults(data, false, true));

playAgainButton.addEventListener("click", () => {
    if (!amHost || phase !== "finished" || !isConnected()) return;
    playAgainButton.disabled = true;
    socket.timeout(10000).emit("playAgain", { code: currentRoom }, (error, response) => {
        playAgainButton.disabled = false;
        if (error || !response?.ok) el("round-message").textContent = response?.message || "تعذر بدء مباراة جديدة. حاول مجددًا.";
    });
});

function returnHome() {
    if (isActiveGame()) return;
    const finish = () => {
        currentRoom = ""; gameId = null; phase = "lobby"; settingsPending = false;
        roomCodeInput.value = "";
        clearRoomCodeError();
        closeDialogs();
        updateControls();
        showScreen(playerName ? "home" : "name");
    };
    if (!currentRoom) { finish(); return; }
    if (!socket.connected || !connectionReady) return;
    socket.timeout(10000).emit("leaveRoom", {}, (error, response) => {
        if (!error && response?.ok) finish();
        else lobbyError.textContent = response?.message || "تعذر مغادرة الغرفة. حاول مجددًا.";
    });
}
homeButton.addEventListener("click", returnHome);
