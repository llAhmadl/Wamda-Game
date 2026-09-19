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

function enterHome() {

    const name =
        nameInput.value.trim();

    if (!name) {

        nameError.textContent = "أدخل اسمك للمتابعة.";
        nameInput.setAttribute("aria-invalid", "true");
        nameInput.focus();

        return;
    }

    playerName = name;
    if (socket.connected) socket.emit("changeName", { name }, () => {});

    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");

    playerNameText.textContent =
        playerName;

    showScreen("home");
}

playButton.addEventListener(
    "click",
    enterHome
);

nameInput.addEventListener("input", () => {
    nameError.textContent = "";
    nameInput.removeAttribute("aria-invalid");
});

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

        homeError.textContent = "";

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

function joinRoom() {

    if (!isConnected()) return;

    homeError.textContent = "";

    const code =
        roomCodeInput
            .value
            .trim()
            .toUpperCase();

    if (!code) {

        homeError.textContent =
            "أدخل رمز الغرفة.";

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

// -------------------------
// Lobby Updates
// -------------------------

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

        socket.emit(
            "startGame",
            {
                code: currentRoom
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
            `الجولة ${["الأولى", "الثانية", "الثالثة"][data.round - 1] || data.round} | سؤال ${data.number}`;

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
    if (data.winner) {
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
        document.getElementById("results-message").textContent = final ? "اكتملت الجولات الثلاث، شكرًا للعبكم!" : "مجموع النقاط حتى نهاية هذه الجولة.";
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

homeButton.addEventListener(
    "click",
    () => {

        socket.emit("leaveRoom");

        currentRoom = "";

        roomCodeInput.value = "";

        homeError.textContent = "";

        showScreen("home");
    }
);
