// Run before the stylesheet to avoid a flash of the wrong theme.
(() => {
    const storageKey = "firsthit-theme";
    const root = document.documentElement;
    root.dataset.page = window.location.pathname?.replace(/\/+$/, "") === "/developer" ? "developer" : "game";
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    let preference = null;

    function readPreference() {
        try {
            const saved = localStorage.getItem(storageKey);
            return saved === "light" || saved === "dark" ? saved : null;
        } catch {
            return null;
        }
    }

    function applyTheme(theme) {
        root.dataset.theme = theme;
        const dark = theme === "dark";
        const themeColor = document.querySelector('meta[name="theme-color"]');
        if (themeColor) themeColor.content = dark ? "#1b1c1e" : "#ffffff";

        const button = document.getElementById("theme-toggle");
        const label = document.getElementById("theme-label");
        if (button && label) {
            label.textContent = dark ? "الوضع الفاتح" : "الوضع الداكن";
            button.setAttribute("aria-label", dark ? "التبديل إلى الوضع الفاتح" : "التبديل إلى الوضع الداكن");
            button.title = button.getAttribute("aria-label");
        }
    }

    preference = readPreference();
    applyTheme(preference || (systemTheme.matches ? "dark" : "light"));

    document.addEventListener("DOMContentLoaded", () => {
        applyTheme(root.dataset.theme);
        document.getElementById("theme-toggle").addEventListener("click", () => {
            preference = root.dataset.theme === "dark" ? "light" : "dark";
            applyTheme(preference);
            try {
                localStorage.setItem(storageKey, preference);
            } catch {
                // The switch still works when browser storage is unavailable.
            }
        });
    });

    systemTheme.addEventListener("change", event => {
        if (!preference) applyTheme(event.matches ? "dark" : "light");
    });

    window.addEventListener("storage", event => {
        if (event.key !== storageKey && event.key !== null) return;
        preference = readPreference();
        applyTheme(preference || (systemTheme.matches ? "dark" : "light"));
    });
})();
