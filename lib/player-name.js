// Server-owned sanitizing; public/name-validation.js mirrors it for instant feedback.
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
// Comparison key for the one-name-per-room rule; the displayed name stays as typed.
// Cheap and table-free: NFKC, lowercase, drop Arabic marks/tatweel/spaces, then fold
// letters that look alike (Arabic letter variants, Cyrillic/Greek twins of Latin letters).
const IGNORED = /[ً-ٰٟۖ-ۭـ\s]/gu;
const LOOKALIKES = new Map(Object.entries({
    'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ی': 'ي', 'ک': 'ك',
    // Cyrillic (already lowercased)
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
    'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l',
    'ԛ': 'q', 'ԝ': 'w',
    // Greek (already lowercased)
    'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'h', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ν': 'n', 'ο': 'o',
    'ρ': 'p', 'τ': 't', 'υ': 'y', 'χ': 'x'
}));
function nameKey(name) {
    let key = '';
    for (const char of String(name).normalize('NFKC').toLocaleLowerCase('en-US').replace(IGNORED, '')) key += LOOKALIKES.get(char) ?? char;
    return key;
}
module.exports = { cleanPlayerName, nameKey };
