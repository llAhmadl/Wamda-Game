// Public page navigation keeps the same socket and the current match alive.
(() => {
    const root = document.documentElement;
    const game = document.getElementById("game-main");
    const developer = document.getElementById("developer-page");
    const isDeveloperPage = () => window.location.pathname.replace(/\/+$/, "") === "/developer";

    let returning = false;
    function applyRoute() {
        returning = false;
        const admin = isDeveloperPage();
        root.dataset.page = admin ? "developer" : "game";
        game.classList[admin ? "add" : "remove"]("hidden");
        developer.classList[admin ? "remove" : "add"]("hidden");
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
        document.title = admin ? "وضع المطور — وَمْضة" : "وَمْضة";
        const heading = admin ? document.getElementById("developer-title") : game.querySelector(".screen:not(.hidden) h1");
        heading?.focus({ preventScroll: true });
        window.scrollTo(0, 0);
        document.dispatchEvent(new CustomEvent("wamda:pagechange", { detail: { page: admin ? "developer" : "game" } }));
    }
    function openDeveloperPage() {
        if (isDeveloperPage()) return;
        window.history.pushState({ wamdaDeveloperEntry: true }, "", "/developer");
        applyRoute();
    }
    function closeDeveloperPage() {
        if (!isDeveloperPage() || returning) return;
        if (window.history.state?.wamdaDeveloperEntry) {
            returning = true;
            window.history.back();
        } else {
            // A direct link has no in-app back entry; keep the player on Wamda.
            window.history.replaceState(null, "", "/");
            applyRoute();
        }
    }
    window.WamdaNavigation = { isDeveloperPage, openDeveloperPage, closeDeveloperPage };
    window.addEventListener("popstate", applyRoute);
    applyRoute();
})();
