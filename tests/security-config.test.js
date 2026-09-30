const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateAdminConfig } = require('../lib/security-config');

test('production refuses a missing or weak admin secret before listening or connecting to storage', () => {
    for (const code of ['', 'short-test-code', ' '.repeat(16), 'a'.repeat(257)]) {
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

test('development may disable admin and a 16-character production secret is accepted', () => {
    assert.doesNotThrow(() => validateAdminConfig({}));
    assert.doesNotThrow(() => validateAdminConfig({ NODE_ENV: 'production', ADMIN_CODE: 'test-only-code-16' }));
});
