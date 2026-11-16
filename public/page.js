// Page-level touches outside the game scripts. Loaded in <head>, so the classes below
// are set before the body first paints (no flash of content that then hides).
(() => {
    const root = document.documentElement;

    // Scroll reveal: every [data-reveal] element rises into view the first time it is scrolled to
    // (or at once if it is already on screen). Elements that arrive in the same moment are numbered
    // in page order (data-reveal-step) and style.css plays them one after another.
    // Without IntersectionObserver, or with reduced motion, nothing is hidden at all.
    const MAX_STEP = 4;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if ("IntersectionObserver" in window && !reducedMotion) {
        root.classList.add("reveal-ready");
        document.addEventListener("DOMContentLoaded", () => {
            try {
                const observer = new IntersectionObserver(entries => {
                    const arriving = entries
                        .filter(entry => entry.isIntersecting && (entry.intersectionRatio >= 0.2 || entry.intersectionRect.height >= 120))
                        .map(entry => entry.target)
                        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
                    arriving.forEach((target, index) => {
                        if (index > 0) target.dataset.revealStep = String(Math.min(index, MAX_STEP));
                        target.classList.add("is-visible");
                        observer.unobserve(target);
                    });
                // Trigger a little above the bottom edge, once a fifth of the piece (or 120px of a
                // very tall one) is in view, so it is seen arriving, not found already finished.
                }, { rootMargin: "0px 0px -10% 0px", threshold: [0, 0.1, 0.2] });
                document.querySelectorAll("[data-reveal]").forEach(item => observer.observe(item));
            } catch {
                root.classList.remove("reveal-ready");
            }
        });
    }

    // An open dialog stops the page from scrolling, which removes its scrollbar. style.css keeps
    // that scrollbar's lane while a dialog is open, but only on a page that really scrolls:
    // a lane on a page without a scrollbar would show the sky beside the header and shift it.
    document.addEventListener("DOMContentLoaded", () => {
        const update = () => root.classList.toggle("page-scrolls", root.scrollHeight > root.clientHeight);
        if ("ResizeObserver" in window) new ResizeObserver(update).observe(document.body);
        window.addEventListener("resize", update);
        update();
    });
})();
