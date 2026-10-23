// Effects: synthesized sounds (no audio files) and a confetti burst.
// Both are optional: unsupported browsers, muted players and reduced motion get none.
const sound = (() => {
    const KEY = "wamda-sound";
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let enabled = true;
    try { enabled = localStorage.getItem(KEY) !== "off"; } catch { /* Default to on. */ }
    let context = null;
    // Browsers only allow audio after a user gesture; create the context on the first one.
    function unlock() {
        if (!AudioContextClass || !enabled) return;
        try {
            context ||= new AudioContextClass();
            if (context.state === "suspended") context.resume();
        } catch { context = null; }
    }
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
    function tone(frequency, start, length, { type = "sine", volume = .12, to = frequency } = {}) {
        const time = context.currentTime + start;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, time);
        if (to !== frequency) oscillator.frequency.exponentialRampToValueAtTime(to, time + length);
        gain.gain.setValueAtTime(.0001, time);
        gain.gain.exponentialRampToValueAtTime(volume, time + .012);
        gain.gain.exponentialRampToValueAtTime(.0001, time + length);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(time);
        oscillator.stop(time + length + .02);
    }
    const sounds = {
        tick: () => tone(1046, 0, .07, { type: "triangle", volume: .09 }),
        correct: () => { tone(659, 0, .14); tone(880, .09, .16); tone(1319, .19, .28, { volume: .1 }); },
        wrong: () => { tone(233, 0, .32, { type: "sawtooth", volume: .05, to: 155 }); tone(175, .05, .3, { type: "triangle", volume: .07, to: 120 }); },
        win: () => [523, 659, 784, 1047].forEach((note, index) => tone(note, index * .11, .3, { volume: .1 }))
    };
    function renderToggle() {
        const toggle = el("sound-toggle");
        toggle.setAttribute("aria-pressed", String(enabled));
        toggle.classList.toggle("is-muted", !enabled);
        el("sound-label").textContent = enabled ? "إيقاف الأصوات" : "تشغيل الأصوات";
    }
    el("sound-toggle").addEventListener("click", () => {
        enabled = !enabled;
        try { localStorage.setItem(KEY, enabled ? "on" : "off"); } catch { /* The toggle still works for this visit. */ }
        renderToggle();
        if (enabled) { unlock(); if (context) sounds.tick(); }
    });
    renderToggle();
    return {
        play(name) {
            if (!enabled || !context || context.state !== "running" || document.visibilityState === "hidden") return;
            try { sounds[name]?.(); } catch { /* Audio is best effort. */ }
        }
    };
})();

const reducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

// A short canvas burst from the top of the page; removed when the last piece falls.
function celebrate() {
    if (reducedMotion() || !document.body?.appendChild) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext?.("2d");
    if (!context || !window.requestAnimationFrame) return;
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.width = window.innerWidth * ratio;
    const height = canvas.height = window.innerHeight * ratio;
    const colors = ["#87BDFF", "#FF6D42", "#FFC83D", "#34C759", "#AF7CFF", "#FF5C8A"];
    const pieces = Array.from({ length: 140 }, () => ({
        x: width * (.2 + Math.random() * .6), y: -20 * ratio - Math.random() * height * .25,
        vx: (Math.random() - .5) * 9 * ratio, vy: (2 + Math.random() * 5) * ratio,
        size: (5 + Math.random() * 6) * ratio, spin: Math.random() * Math.PI, turn: (Math.random() - .5) * .3,
        color: colors[Math.floor(Math.random() * colors.length)], round: Math.random() < .3
    }));
    const startedAt = performance.now();
    function frame(time) {
        context.clearRect(0, 0, width, height);
        let alive = 0;
        const fade = Math.max(0, 1 - Math.max(0, time - startedAt - 2200) / 800);
        for (const piece of pieces) {
            piece.vy += .12 * ratio; piece.vx *= .99;
            piece.x += piece.vx; piece.y += piece.vy; piece.spin += piece.turn;
            if (piece.y > height + 20) continue;
            alive++;
            context.save();
            context.globalAlpha = fade;
            context.translate(piece.x, piece.y);
            context.rotate(piece.spin);
            context.fillStyle = piece.color;
            if (piece.round) { context.beginPath(); context.arc(0, 0, piece.size / 2, 0, Math.PI * 2); context.fill(); }
            else context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
            context.restore();
        }
        if (alive && fade > 0) window.requestAnimationFrame(frame);
        else canvas.remove();
    }
    window.requestAnimationFrame(frame);
}

// Crown drawn inline so it inherits the theme color.
function crownIcon() {
    if (!document.createElementNS) return null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "crown");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19 18H5Z");
    svg.appendChild(path);
    return svg;
}
