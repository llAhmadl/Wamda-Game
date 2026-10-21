// Mirrors lib/player-name.js so the browser rejects exactly what the server rejects
// (invisible characters, numeric-only names). tests/player-name.test.js checks parity.
function cleanPlayerName(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    const cleaned = value.normalize("NFC")
        .replace(/[\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, "")
        .replace(/\s+/gu, " ")
        .replace(/\p{Cc}/gu, "")
        .replace(/\s+/gu, " ").trim();
    const name = cleaned.slice(0, 20).replace(/[\uD800-\uDBFF]$/, "").trim();
    return !name || name.length > 20 || /^[\p{N}\s]+$/u.test(name) ? "" : name;
}

if (typeof module !== "undefined" && module.exports) module.exports = { cleanPlayerName };
