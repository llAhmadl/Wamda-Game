// Server-owned sanitizing; public/name-validation.js remains unchanged.
function cleanPlayerName(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    const cleaned = value.normalize('NFC')
        .replace(/[\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu, '')
        .replace(/\s+/gu, ' ')
        .replace(/\p{Cc}/gu, '')
        .replace(/\s+/gu, ' ').trim();
    // Preserve the existing 20 UTF-16-unit limit, without splitting a surrogate
    // pair. Validate after cleaning/truncation so invisible padding cannot make
    // empty or numeric-only names acceptable.
    const name = cleaned.slice(0, 20).replace(/[\uD800-\uDBFF]$/, '').trim();
    return !name || name.length > 20 || /^[\p{N}\s]+$/u.test(name) ? '' : name;
}
module.exports = { cleanPlayerName };
