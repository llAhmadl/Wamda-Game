const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanPlayerName } = require('../lib/player-name');

test('names remove controls, bidi overrides, invisibles and normalize whitespace before validation', () => {
    for (const control of ['\u0000', '\u001b', '\u007f', '\u061c', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f',
        '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff', '\u034f', '\u2060']) {
        assert.equal(cleanPlayerName(`أح${control}مد`), 'أحمد');
        assert.equal(cleanPlayerName(control), '');
        assert.equal(cleanPlayerName(`١٢٣${control}`), '');
    }
    assert.equal(cleanPlayerName('  أحمد\n\t  علي\u00a0 حسن  '), 'أحمد علي حسن');
    assert.equal(cleanPlayerName('ع'.repeat(19) + '😀'), 'ع'.repeat(19));
    assert.equal(cleanPlayerName('ع'.repeat(25)), 'ع'.repeat(20));
    assert.equal(cleanPlayerName('١'.repeat(20) + 'ع'), '');
    assert.equal(cleanPlayerName('\u200b'.repeat(20) + 'أحمد'), 'أحمد');
    assert.equal(cleanPlayerName({ name: 'أحمد' }), '');
    assert.equal(cleanPlayerName('ع'.repeat(2049)), '');
});

test('browser name validation matches the server for every edge case', () => {
    const browser = require('../public/name-validation').cleanPlayerName;
    for (const value of ['أحمد', '  مشعل  ', '​أحمد‮', '١٢٣', '1 ٢ ۳', '​'.repeat(20) + 'أحمد',
        'ع'.repeat(19) + '😀', 'ع'.repeat(25), '\u0000', 'a  b', 'ع'.repeat(2049), '', null, 42]) {
        assert.equal(browser(value), cleanPlayerName(value), JSON.stringify(value));
    }
});

test('the duplicate-name key folds lookalikes but keeps different names apart', () => {
    const { nameKey } = require('../lib/player-name');
    const same = [['محمد', 'مُحمد'], ['محمد', 'محـمد'], ['محمد', 'مُحَمَّد'], ['احمد', 'أحمد'], ['احمد', 'إحمد'], ['امنة', 'آمنة'],
        ['علي', 'علی'], ['علي', 'على'], ['كريم', 'کريم'], ['Ahmad', 'Аhmad'], ['Ali', 'ali '], ['Ali', 'A l i'],
        ['ABC', 'ΑΒC'], ['Nora', 'NORA'], ['ﻣﺤﻤﺪ', 'محمد']];
    for (const [a, b] of same) assert.equal(nameKey(a), nameKey(b), `${a} / ${b}`);
    const different = [['سارة', 'ساره'], ['محمد', 'أحمد'], ['Ali', 'Alia'], ['علي', 'عليا']];
    for (const [a, b] of different) assert.notEqual(nameKey(a), nameKey(b), `${a} / ${b}`);
});
