// Play: questions, answers, the live "first correct" board and the timer.
let answerLimit = 1;
let displayedWinnerCount = 0;
let answerLeadersSignature = null;
let answerBoardKey = null;
let lastTick = null;
const questionImage = el("question-image");

function setTimerState(state) { timerElement.parentElement.dataset.state = state; }

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
    answerMessage.className = "answer-message";
    el("question-number").textContent = `الجولة ${["الأولى", "الثانية"][data.round - 1] || data.round} | سؤال ${data.number}`;
    el("question-text").textContent = data.question;
    if (data.image) { questionImage.src = data.image; questionImage.classList.remove("hidden"); }
    else { questionImage.removeAttribute("src"); questionImage.classList.add("hidden"); }
    choicesContainer.innerHTML = "";
    data.choices.forEach((choice, index) => {
        const button = document.createElement("button");
        button.className = "choice";
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
        button.addEventListener("click", () => submitAnswer(index, button));
        choicesContainer.appendChild(button);
    });
    setTimerState("open");
    startTimer(data);
}
socket.on("question", renderQuestion);

// Each update replaces the server-owned order; retries never append extra rows.
// The first place wears a crown; every other winning place has its own color.
function renderAnswerLeaders(winners) {
    if (!Array.isArray(winners) || winners.length < displayedWinnerCount) return;
    const accepted = winners.slice(0, answerLimit);
    const signature = JSON.stringify([answerLimit, accepted.map(winner => [winner.id, winner.name])]);
    if (signature === answerLeadersSignature) return;
    answerLeadersSignature = signature;
    displayedWinnerCount = accepted.length;
    const list = el("answer-leaders");
    list.innerHTML = "";
    for (let index = 0; index < answerLimit; index++) {
        const winner = accepted[index];
        const row = document.createElement("li");
        row.className = winner ? `answer-leader is-filled place-${index + 1}` : "answer-leader";
        if (winner?.id === playerId) row.classList.add("is-me");
        const rank = document.createElement("span");
        rank.className = "answer-rank";
        rank.textContent = String(index + 1);
        rank.setAttribute("aria-hidden", "true");
        if (winner && index === 0) { const crown = crownIcon(); if (crown) rank.appendChild(crown); }
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

function submitAnswer(answerIndex, selectedButton) {
    if (selectedButton.disabled || !isConnected() || phase !== "question") return;
    choicesContainer.querySelectorAll("button").forEach(button => { button.disabled = true; });
    selectedButton.classList.add("selected");
    selectedButton.setAttribute("aria-pressed", "true");
    answerMessage.textContent = "تم إرسال إجابتك.";
    socket.emit("submitAnswer", { code: currentRoom, answerIndex, questionId, gameId });
}

function renderAnswer(data) {
    const correctButton = choicesContainer.querySelectorAll("button")[data.correctIndex];
    correctButton?.classList.add("is-correct");
    const selected = choicesContainer.querySelector(".selected");
    selected?.classList.add(data.correct ? "is-correct" : "is-wrong");
    // Keep feedback visual, with labels available to screen readers.
    answerMessage.textContent = "";
    if (correctButton) correctButton.setAttribute("aria-label", `${correctButton.textContent}، الإجابة الصحيحة`);
    if (selected && !data.correct) selected.setAttribute("aria-label", `${selected.textContent}، إجابتك خاطئة`);
}
// Only live answers make a sound; restored snapshots stay quiet.
socket.on("answerResult", data => { renderAnswer(data); sound.play(data.correct ? "correct" : "wrong"); });

// Question review: wait for an explicit host action.
function renderReview(data) {
    clearInterval(countdown);
    phase = "review";
    lastInRound = data.lastInRound;
    setTimerState("closed");
    renderAnswerLeaders(data.winners || (data.winner ? [data.winner] : []));
    const buttons = choicesContainer.querySelectorAll("button");
    buttons.forEach((button, index) => {
        button.disabled = true;
        if (index === data.correctIndex) button.classList.add("is-correct");
    });
    const selected = choicesContainer.querySelector(".selected");
    if (selected && Array.from(buttons).indexOf(selected) !== data.correctIndex) selected.classList.add("is-wrong");
    if (data.winners?.length) {
        const earned = data.winners.find(winner => winner.id === playerId);
        answerMessage.textContent = earned ? `إجابة صحيحة! +${earned.awardedPoints} نقطة` : `أجاب ${playersText(data.winners.length)} إجابة صحيحة.`;
    } else if (data.winner) {
        answerMessage.textContent = data.winner.id === playerId ? "سبقت الجميع! +1 نقطة" : `حسم ${data.winner.name} السؤال.`;
    } else if (data.reason === "timeout" || !data.reason) {
        timerElement.textContent = "0";
        answerMessage.textContent = "انتهى الوقت.";
    }
    updateControls();
}
// The fastest correct answer gets a confetti burst on their own screen.
socket.on("questionClosed", data => {
    renderReview(data);
    if ((data.winners?.[0] || data.winner)?.id === playerId) celebrate();
});

function startTimer(data) {
    clearInterval(countdown);
    // Derive from the server deadline and advance against a monotonic clock.
    // Background-tab throttling cannot turn delayed ticks into extra seconds.
    const remainingMs = Math.max(0, data.deadline - data.serverNow);
    const endsAt = performance.now() + remainingMs;
    const total = (data.duration || 20) * 1000;
    lastTick = null;
    function paint() {
        const left = Math.max(0, endsAt - performance.now());
        const remaining = Math.ceil(left / 1000);
        timerElement.textContent = remaining;
        timerElement.parentElement.dataset.low = String(remaining <= 5);
        el("timer-bar")?.style?.setProperty("--time-left", String(left / total));
        if (remaining <= 5 && remaining > 0 && remaining !== lastTick && phase === "question") { lastTick = remaining; sound.play("tick"); }
        if (remaining === 0) {
            clearInterval(countdown);
            choicesContainer.querySelectorAll("button").forEach(button => { button.disabled = true; });
            if (!choicesContainer.querySelector(".selected")) answerMessage.textContent = "انتهى الوقت. بانتظار المضيف للمتابعة.";
        }
    }
    countdown = setInterval(paint, 200);
    paint();
}

nextQuestionButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextQuestion", { code: currentRoom, gameId, questionId }); });
nextRoundButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextRound", { code: currentRoom, gameId, round: currentRound }); });
