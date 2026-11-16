// Page-level touches outside the game scripts. Loaded in <head>, so the classes below
// are set before the body first paints (no flash of content that then hides).
(() => {
    const root = document.documentElement;

    // Feature band: rises into view the first time it is scrolled to (or at once if already
    // on screen); style.css staggers its items. Without IntersectionObserver, or with reduced
    // motion, nothing is hidden at all.
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if ("IntersectionObserver" in window && !reducedMotion) {
        root.classList.add("reveal-ready");
        document.addEventListener("DOMContentLoaded", () => {
            try {
                const observer = new IntersectionObserver(entries => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        entry.target.classList.add("is-visible");
                        observer.unobserve(entry.target);
                    }
                }, { rootMargin: "0px 0px -6% 0px", threshold: 0.15 });
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
