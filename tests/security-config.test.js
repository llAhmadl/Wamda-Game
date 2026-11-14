const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateAdminConfig } = require('../lib/security-config');

test('production refuses a missing or weak admin secret before listening or connecting to storage', () => {
    for (const code of ['', 'a'.repeat(11), ' '.repeat(12), ' ' + 'a'.repeat(11) + ' ', 'a'.repeat(257)]) {
        const result = spawnSync(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'), timeout: 5000,
            env: { ...process.env, NODE_ENV: 'production', ADMIN_CODE: code, DATABASE_URL: '', PORT: '0' }, encoding: 'utf8'
        });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /Production requires ADMIN_CODE/);
        if (code.trim()) assert.ok(!result.stderr.includes(code));
    }
});

test('development may disable admin and 12-to-256-character production secrets are accepted', () => {
    assert.doesNotThrow(() => validateAdminConfig({}));
    for (const length of [12, 16, 256]) {
        assert.doesNotThrow(() => validateAdminConfig({ NODE_ENV: 'production', ADMIN_CODE: 'a'.repeat(length) }));
    }
});
