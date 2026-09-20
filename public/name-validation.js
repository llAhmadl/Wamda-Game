// Shared by the browser and server so registration and renaming agree.
function cleanPlayerName(value) {
    if (typeof value !== "string") return "";
    const name = value.trim().slice(0, 20);
    return !name || /^[\p{N}\s]+$/u.test(name) ? "" : name;
}

if (typeof module !== "undefined" && module.exports) module.exports = { cleanPlayerName };
