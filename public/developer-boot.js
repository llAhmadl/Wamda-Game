// The developer page is its own document with its own anonymous connection, so
// opening it never replaces (or downloads) a player's game session.
const socket = io({ auth: {} });
let connectionReady = false;
socket.on("connect", () => { connectionReady = true; });
socket.on("disconnect", () => { connectionReady = false; });
document.getElementById("developer-home").addEventListener("click", () => { window.location.href = "/"; });
fetch("/api/site").then(response => response.ok ? response.json() : null).then(data => {
    if (typeof data?.version === "string") document.getElementById("site-version").textContent = ` · v${data.version}`;
}).catch(() => { /* The footer stays usable without metadata. */ });
