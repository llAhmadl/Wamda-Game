const socket = io();

// -------------------------
// State
// -------------------------

let playerName = "";
let currentRoom = "";
let countdown = null;
let amHost = false;
let phase = "lobby";
let questionId = null;
let currentRound = 1;
let lastInRound = false;
let resultsAnimation = null;
let resultMotions = [];
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

function showScreen(screenName) {
    stopResultsAnimation();

    for (const screen of Object.values(screens)) {
        screen.classList.add("hidden");
    }

    screens[screenName].classList.remove("hidden");

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
    document.getElementById("home-logo").disabled = isActiveGame();
    document.getElementById("developer-home").disabled = isActiveGame();
    nextQuestionButton.classList.add("hidden");
    nextRoundButton.classList.add("hidden");
    if (phase === "review" && amHost) nextQuestionButton.classList.remove("hidden");
    if (phase === "roundResults" && amHost) nextRoundButton.classList.remove("hidden");
    nextQuestionButton.textContent = lastInRound ? "عرض نتائج الجولة" : "السؤال التالي";
    document.getElementById("advance-message").textContent = phase === "review" ? (amHost ? "انتقل عندما يكون الجميع جاهزًا." : "بانتظار المضيف للمتابعة...") : "";
    document.getElementById("round-message").textContent = phase === "roundResults" ? (amHost ? "ابدأ الجولة التالية عندما يكون الجميع جاهزًا." : "بانتظار المضيف لبدء الجولة التالية...") : "";
}
nextQuestionButton.addEventListener("click", () => socket.emit("nextQuestion", { code: currentRoom, questionId }));
nextRoundButton.addEventListener("click", () => socket.emit("nextRound", { code: currentRoom, round: currentRound }));

const resultsList =
    document.getElementById("results-list");

const homeButton =
    document.getElementById("home-button");

const nameError = document.getElementById("name-error");
const nameField = createNameField(nameInput, document.getElementById("name-label"), nameError);
const playerCount = document.getElementById("player-count");
const copyCodeButton = document.getElementById("copy-code");
const copyMessage = document.getElementById("copy-message");
const connectionMessage = document.getElementById("connection-message");

// A reconnect creates a new socket; the original server does not restore rooms.
socket.on("disconnect", () => {
    connectionMessage.textContent = "انقطع الاتصال. جارٍ إعادة الاتصال...";
    connectionMessage.classList.remove("hidden");
    clearInterval(countdown);
    if (currentRoom) {
        currentRoom = "";
        phase = "lobby";
        settingsPending = false;
        updateControls();
        showScreen("home");
        homeError.textContent = "أنشئ غرفة أو انضم مجددًا بعد عودة الاتصال.";
    }
});

socket.on("connect_error", () => {
    connectionMessage.textContent = "تعذر الاتصال بالخادم. تحقق من اتصالك.";
    connectionMessage.classList.remove("hidden");
});

socket.on("connect", () => {
    connectionMessage.textContent = "";
    connectionMessage.classList.add("hidden");
    if (playerName) socket.emit("changeName", { name: playerName }, () => {});
});

function isConnected() {
    if (socket.connected) return true;
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
    if (socket.connected) socket.emit("changeName", { name }, () => {});

    nameField.clear();

    playerNameText.textContent =
        playerName;

    showScreen("home");
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

createButton.addEventListener(
    "click",
    () => {

        if (!isConnected()) return;

        clearRoomCodeError();

        socket.emit(
            "createRoom",
            {
                name: playerName
            },
            response => {

                if (!response.ok) {

                    homeError.textContent =
                        response.message;

                    return;
                }

                currentRoom =
                    response.code;

                roomCodeText.textContent =
                    currentRoom;

                showScreen("lobby");
            }
        );
    }
);

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

    if (!isConnected()) return;

    clearRoomCodeError();

    const code =
        roomCodeInput
            .value
            .trim()
            .toUpperCase();

    if (!code) {

        showRoomCodeError(roomCodePlaceholder);

        return;
    }

    socket.emit(
        "joinRoom",
        {
            name: playerName,
            code
        },
        response => {

            if (!response.ok) {

                showRoomCodeError("رمز الغرفة غير صحيح");

                return;
            }

            currentRoom =
                response.code;

            roomCodeText.textContent =
                currentRoom;

            showScreen("lobby");
        }
    );
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
    document.getElementById("category-hint").textContent = amHost ? "اختر قسمًا أو أكثر. أسئلة المباراة من البنك المفعّل." : "المضيف يختار الأقسام. تظهر اختياراته هنا مباشرة.";
    const scoring = document.getElementById("scoring-mode");
    scoring.value = String(lobbySettings.scoringMode);
    scoring.disabled = !editable;
    document.getElementById("scoring-description").textContent = lobbySettings.scoringMode === 1 ? "أول إجابة صحيحة تكسب نقطة واحدة." : `الأول الصحيح يكسب نقطتين، وكل لاعب بعده نقطة حتى يكتمل ${lobbySettings.scoringMode} لاعبين.`;
    startButton.disabled = !editable || !lobbySettings.selectedCategoryIds.length;
}

function changeRoomSettings(categoryIds, scoringMode) {
    if (!amHost || isActiveGame() || settingsPending || !socket.connected) return;
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

socket.on(
    "lobbyUpdate",
    data => {

        currentRoom = data.code;

        roomCodeText.textContent =
            data.code;

        playersList.innerHTML = "";

        playerCount.textContent = data.players.length;
        copyMessage.textContent = "";

        data.players.forEach(player => {

            const row =
                document.createElement("div");

            row.className = "player";

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

            playersList.appendChild(row);
        });

        amHost = socket.id === data.hostId;
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
);

// -------------------------
// Start Game
// -------------------------

startButton.addEventListener(
    "click",
    () => {

        if (!amHost || !socket.connected) return;
        document.getElementById("lobby-error").textContent = "";
        socket.timeout(10000).emit(
            "startGame",
            {
                code: currentRoom
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

socket.on(
    "question",
    data => {

        phase = "question";
        questionId = data.questionId;
        currentRound = data.round;
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

        startTimer(data.duration);
    }
);

// -------------------------
// Answer
// -------------------------

function submitAnswer(
    answerIndex,
    selectedButton
) {

    if (selectedButton.disabled) return;

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
            answerIndex, questionId
        }
    );
}

socket.on(
    "answerResult",
    data => {

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
);

// -------------------------
// Question review: wait for an explicit host action.
socket.on("questionClosed", data => {
    clearInterval(countdown);
    phase = "review";
    lastInRound = data.lastInRound;
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
        const earned = data.winners.find(winner => winner.id === socket.id);
        answerMessage.textContent = earned ? `إجابة صحيحة! +${earned.awardedPoints} نقطة` : `أجاب ${data.winners.length} من اللاعبين بشكل صحيح.`;
    } else if (data.winner) {
        answerMessage.textContent = data.winner.id === socket.id ? "سبقت الجميع! +1 نقطة" : `حسم ${data.winner.name} السؤال.`;
    } else if (data.reason === "timeout" || !data.reason) {
        timerElement.textContent = "0";
        answerMessage.textContent = "انتهى الوقت.";
    }
    updateControls();
});

// -------------------------
// Timer
// -------------------------

function startTimer(seconds) {

    clearInterval(countdown);

    let remaining = seconds;

    timerElement.parentElement.dataset.low = "false";

    timerElement.textContent =
        remaining;

    countdown = setInterval(
        () => {

            remaining--;

            if (remaining < 0) {

                clearInterval(countdown);

                return;
            }

            timerElement.textContent =
                remaining;

            timerElement.parentElement.dataset.low = String(remaining <= 5);

            if (remaining === 0) {
                clearInterval(countdown);
                const unanswered = !choicesContainer.querySelector(".selected");
                choicesContainer.querySelectorAll("button").forEach(button => {
                    button.disabled = true;
                });
                if (unanswered) answerMessage.textContent = "انتهى الوقت. بانتظار المضيف للمتابعة.";
            }

        },
        1000
    );
}

// -------------------------
// Results
// -------------------------

function showResults(data, final) {
        phase = final ? "finished" : "roundResults";
        currentRound = data.round;
        updateControls();
        document.getElementById("results-title").textContent = final ? "النتائج النهائية" : `نتائج الجولة ${data.round}`;
        document.getElementById("results-message").textContent = final ? "اكتملت الجولتان، شكرًا للعبكم!" : "انتهت الجولة الأولى. النقاط مستمرة في الجولة الثانية.";
        homeButton.classList.remove("hidden");
        if (!final) homeButton.classList.add("hidden");

        clearInterval(countdown);

        showScreen("results");

        renderRanking(data.ranking, data.round === 1 && !final);
}

function renderRanking(ranking, animateFirstRound) {
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
        return { player, row, position, score, displayed: 0 };
    });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = animateFirstRound && !reducedMotion && entries.some(entry => entry.player.score > 0);
    resultsList.innerHTML = "";

    function paint(progress, move) {
        const oldPositions = new Map();
        if (move) entries.forEach(entry => oldPositions.set(entry, entry.row.getBoundingClientRect().top));
        resultMotions.forEach(animation => animation.cancel());
        resultMotions = [];
        entries.forEach(entry => { entry.displayed = Math.floor(entry.player.score * progress); });
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
            entry.displayed = Math.floor(entry.player.score * progress);
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
socket.on("gameOver", data => showResults(data, true));
socket.on("roundOver", data => showResults(data, false));

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

document.getElementById("leave-button").addEventListener("click", () => {
    homeButton.click();
});

function returnHome() {
    if (isActiveGame()) return;
    const finish = () => {
        currentRoom = "";
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
    if (!socket.connected) return;
    socket.timeout(10000).emit("leaveRoom", {}, (error, response) => {
        if (!error && response?.ok) finish();
        else document.getElementById("lobby-error").textContent = response?.message || "تعذر مغادرة الغرفة. حاول مجددًا.";
    });
}
homeButton.addEventListener("click", returnHome);
document.getElementById("home-logo").addEventListener("click", returnHome);
