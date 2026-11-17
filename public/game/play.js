// Play: questions, answers, the "first correct" notifications and the timer.
let answerLimit = 1;
let displayedWinnerCount = 0;
let answerLeadersSignature = null;
let answerBoardKey = null;
// Winner ids already shown as notifications for this question, in place order.
let shownWinners = [];
let lastTick = null;
// The last questionClosed data, and a refused answer's note, for the current question only.
let lastReview = null;
let refusedNote = "";
const questionImage = el("question-image");
const questionText = el("question-text");
const answerToasts = el("answer-leaders");

function setTimerState(state) { timerElement.parentElement.dataset.state = state; }

// Length buckets for the question text (style.css picks the size). Thresholds are in characters.
function lengthBucket(text) {
    const length = Array.from(text).length;
    return length <= 45 ? "short" : length <= 90 ? "medium" : length <= 140 ? "long" : "very-long";
}
// Four short choices sit two by two on phones.
const COMPACT_CHOICE = 14;

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
        shownWinners = [];
        answerToasts.innerHTML = "";
    }
    answerToasts.dataset.phase = "question";
    // Winners in a question payload come from a snapshot (reconnect, wake): shown without motion.
    renderAnswerLeaders(data.winners || []);
    updateControls();
    showScreen("game");
    answerMessage.textContent = "";
    answerMessage.className = "answer-message";
    lastReview = null;
    refusedNote = "";
    el("question-number").textContent = `الجولة ${["الأولى", "الثانية"][data.round - 1] || data.round} | سؤال ${data.number}`;
    questionText.textContent = data.question;
    questionText.dataset.length = lengthBucket(data.question);
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
    choicesContainer.dataset.compact = String(data.choices.length === 4 && data.choices.every(choice => Array.from(choice).length <= COMPACT_CHOICE));
    setTimerState("open");
    startTimer(data);
    fitQuestion();
}
socket.on("question", data => { renderQuestion(data); flashQuestion(); });
// The one signature moment: a brief light sweep across the card as a live question arrives.
const questionPanel = el("question-panel");
function flashQuestion() {
    questionPanel.classList.remove("is-flashing");
    void questionPanel.offsetWidth;
    questionPanel.classList.add("is-flashing");
}

// The question must fit the phone screen; style.css does the work (the picture gives way first).
// When even that cannot fit, step down once ("tight"); in review the picture may then go ("squeeze");
// only after that does the page scroll ("free") rather than clip a choice.
// Runs after each render, when a picture loads and when the screen resizes.
function fitQuestion() {
    if (typeof questionPanel.scrollHeight !== "number" || screens.game.classList.contains("hidden")) return;
    delete questionPanel.dataset.fit;
    for (const step of phase === "review" ? ["tight", "squeeze", "free"] : ["tight", "free"]) {
        if (questionPanel.scrollHeight <= questionPanel.clientHeight + 1) break;
        questionPanel.dataset.fit = step;
    }
    placeToasts();
}
let fitFrame = null;
function scheduleFit() {
    if (fitFrame !== null || typeof window.requestAnimationFrame !== "function") return;
    fitFrame = window.requestAnimationFrame(() => { fitFrame = null; fitQuestion(); });
}
questionImage.addEventListener("load", scheduleFit);
window.addEventListener("resize", scheduleFit);

// "First correct" notifications: one small line per scoring place, sliding in from the left edge of
// the screen, the newest under the previous. The server owns the order and it only grows, so each
// update appends the new places only; retries and reconnect snapshots never repeat one. Snapshot
// winners (live = false) appear without motion.
const PLACE_WORDS = ["أول", "ثاني", "ثالث", "رابع", "خامس", "سادس", "سابع"];
const PLACE_MEDALS = ["🥇", "🥈", "🥉"];
function answerToastText(winner, index) {
    const me = winner.id === playerId;
    const place = `${PLACE_WORDS[index]} واحد`;
    return { name: me ? "أنت" : `\u2068${winner.name}\u2069`, rest: index === 0 ? ` ${me ? "جاوبت" : "جاوب"} ${place}` : ` ${place}` };
}
function answerToast(winner, index, live) {
    const item = document.createElement("li");
    item.className = `answer-toast place-${index + 1}`;
    if (winner.id === playerId) item.classList.add("is-me");
    if (live) item.classList.add("is-new");
    const name = document.createElement("span");
    name.className = "answer-toast-name";
    name.setAttribute("dir", "auto");
    const rest = document.createElement("span");
    rest.className = "answer-toast-rest";
    const words = answerToastText(winner, index);
    name.textContent = words.name;
    rest.textContent = words.rest + (PLACE_MEDALS[index] ? ` ${PLACE_MEDALS[index]}` : "");
    item.appendChild(name);
    item.appendChild(rest);
    return item;
}
// They sit over the least useful part of the screen and never over a choice: under the timer row
// down to the first choice (phones upright), under the choices (phones sideways), the empty margin
// (wide screens). Only as many of the newest as fit there (three at most) are shown; the older ones step aside.
const toastStack = window.matchMedia?.("(orientation: landscape) and (max-height: 520px)");
const toastMargin = window.matchMedia?.("(min-width: 1100px)");
function placeToasts() {
    const items = Array.from(answerToasts.children);
    if (!items.length || typeof window.innerHeight !== "number" || typeof choicesContainer.getBoundingClientRect !== "function") return;
    items.forEach(item => item.classList.remove("is-past"));
    if (toastMargin?.matches) return;
    const step = (items[0].offsetHeight || 24) + 4;
    const choices = choicesContainer.getBoundingClientRect();
    let room;
    if (toastStack?.matches) {
        // Sideways: under the choices, and above the host's bar when it is showing.
        const floor = nextQuestionButton.classList.contains("hidden") ? window.innerHeight
            : Math.min(window.innerHeight, nextQuestionButton.parentElement.getBoundingClientRect().top);
        answerToasts.style.setProperty("--toast-bottom", `${Math.round(window.innerHeight - floor + 4)}px`);
        room = floor - choices.bottom - 8;
    } else {
        const top = el("timer-bar").parentElement.getBoundingClientRect().bottom + 6;
        answerToasts.style.setProperty("--toast-top", `${Math.round(top)}px`);
        room = choices.top - 6 - top;
    }
    // Never more than three at once on a phone, so the question stays readable.
    const shown = Math.min(3, Math.max(1, Math.floor((room + 4) / step)));
    items.forEach((item, index) => item.classList.toggle("is-past", index < items.length - shown));
}
window.addEventListener("resize", () => { if (answerToasts.children.length) placeToasts(); });
function renderAnswerLeaders(winners, live = false) {
    if (!Array.isArray(winners) || winners.length < displayedWinnerCount) return;
    const accepted = winners.slice(0, answerLimit);
    const signature = JSON.stringify([answerLimit, accepted.map(winner => [winner.id, winner.name])]);
    if (signature === answerLeadersSignature) return;
    answerLeadersSignature = signature;
    displayedWinnerCount = accepted.length;
    // A changed order is never expected from the server; if it happens, redraw quietly.
    if (!shownWinners.every((id, index) => accepted[index]?.id === id)) {
        answerToasts.innerHTML = "";
        shownWinners = [];
        live = false;
    }
    accepted.forEach((winner, index) => {
        if (index < shownWinners.length) {
            // Same place, same player: only a rename can change it, and that never animates.
            const name = answerToasts.children[index]?.querySelector(".answer-toast-name");
            if (name) name.textContent = answerToastText(winner, index).name;
            return;
        }
        answerToasts.appendChild(answerToast(winner, index, live));
        shownWinners.push(winner.id);
    });
    placeToasts();
}
socket.on("answerProgress", data => {
    if (data.gameId !== gameId || data.questionId !== questionId || !["question", "review"].includes(phase)) return;
    renderAnswerLeaders(data.winners, true);
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
function renderReview(data, live = false) {
    clearInterval(countdown);
    phase = "review";
    lastInRound = data.lastInRound;
    setTimerState("closed");
    renderAnswerLeaders(data.winners || (data.winner ? [data.winner] : []), live);
    // The notifications fade a few seconds after the close (style.css).
    answerToasts.dataset.phase = "review";
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
    fitQuestion();
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
    renderReview(data, true);
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
            if (!choicesContainer.querySelector(".selected")) { answerMessage.textContent = "انتهى الوقت. بانتظار المضيف للمتابعة."; fitQuestion(); }
        }
    }
    countdown = setInterval(paint, 200);
    paint();
}

nextQuestionButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextQuestion", { code: currentRoom, gameId, questionId }); });
nextRoundButton.addEventListener("click", () => { if (isConnected()) socket.emit("nextRound", { code: currentRoom, gameId, round: currentRound }); });
