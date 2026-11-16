// Play: questions, answers, the live "first correct" board and the timer.
let answerLimit = 1;
let displayedWinnerCount = 0;
let answerLeadersSignature = null;
let answerBoardKey = null;
let lastTick = null;
// The last questionClosed data, and a refused answer's note, for the current question only.
let lastReview = null;
let refusedNote = "";
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
    lastReview = null;
    refusedNote = "";
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
socket.on("question", data => { renderQuestion(data); flashQuestion(); });
// The one signature moment: a brief light sweep across the card as a live question arrives.
const questionPanel = el("question-panel");
function flashQuestion() {
    questionPanel.classList.remove("is-flashing");
    void questionPanel.offsetWidth;
    questionPanel.classList.add("is-flashing");
}

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
    const sentGame = gameId, sentQuestion = questionId;
    // Acceptance arrives as answerResult; the acknowledgement only matters when the answer was refused.
    socket.timeout(10000).emit("submitAnswer", { code: currentRoom, answerIndex, questionId, gameId }, (error, response) => {
        if (error || response?.ok || sentGame !== gameId || sentQuestion !== questionId) return;
        if (response?.code === "TOO_LATE") refuseAnswer("وصلت إجابتك بعد انتهاء الوقت ⏱️");
        else if (response?.code === "CLOSED") refuseAnswer("انقفل السؤال قبل ما توصل إجابتك.");
    });
}
// A refused answer never counted: drop its selection so the review cannot show it
// as the player's own (possibly correct) answer, and say why it earned nothing.
function refuseAnswer(note) {
    refusedNote = note;
    const selected = choicesContainer.querySelector(".selected");
    if (selected) {
        selected.classList.remove("selected", "is-wrong");
        selected.setAttribute("aria-pressed", "false");
        selected.removeAttribute("aria-label");
    }
    answerMessage.textContent = refusedText(lastReview);
}
// The refusal note, then what the review adds: the correct choice when nobody won
// (never "time is up" twice), otherwise the usual winners line.
function refusedText(review) {
    if (!review) return refusedNote;
    const nobody = !review.winners?.length && !review.winner;
    return `${refusedNote} ${nobody ? correctChoiceText(review) : reviewText(review)}`.trim();
}

// Only the player's own choice is marked; the correct one arrives with questionClosed.
function renderAnswer(data) {
    const selected = choicesContainer.querySelector(".selected");
    selected?.classList.add(data.correct ? "is-correct" : "is-wrong");
    // Keep feedback visual, with labels available to screen readers.
    answerMessage.textContent = "";
    if (selected) selected.setAttribute("aria-label", `${selected.textContent}، ${data.correct ? "إجابتك صحيحة" : "إجابتك خاطئة"}`);
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
    if (!data.winners?.length && !data.winner && data.reason !== "answered") timerElement.textContent = "0";
    lastReview = data;
    answerMessage.textContent = refusedNote ? refusedText(data) : reviewText(data);
    updateControls();
}
// "+1" is wrapped in a left-to-right isolate so RTL text never shows it as "1+".
// With no winner the correct choice is named, first-strong isolated for mixed scripts.
function reviewText(data) {
    if (data.winners?.length) {
        const earned = data.winners.find(winner => winner.id === playerId);
        return earned ? `إجابة صحيحة! ⁦+${earned.awardedPoints}⁩ نقطة` : `أجاب ${playersText(data.winners.length)} إجابة صحيحة.`;
    }
    if (data.winner) return data.winner.id === playerId ? "سبقت الجميع! ⁦+1⁩ نقطة" : `حسم ${data.winner.name} السؤال.`;
    const answer = correctChoiceText(data);
    return `${data.reason === "answered" ? "ما أحد جاوب صح هالمرة." : "انتهى الوقت."}${answer ? ` ${answer}` : ""}`;
}
function correctChoiceText(data) {
    const choice = choicesContainer.querySelectorAll("button")[data.correctIndex]?.querySelector(".choice-text")?.textContent;
    return choice ? `الجواب الصحيح: \u2068${choice}\u2069` : "";
}
// The fastest correct answer gets a confetti burst on their own screen.
socket.on("questionClosed", data => {
    renderReview(data);
    preloadImage(data.nextImage);
    if ((data.winners?.[0] || data.winner)?.id === playerId) celebrate();
});
// Loading the next picture during the review keeps it from eating into that question's time.
function preloadImage(src) {
    if (typeof src !== "string" || !src.startsWith("/category-images/")) return;
    const image = document.createElement("img");
    image.decoding = "async";
    image.src = src;
}

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
