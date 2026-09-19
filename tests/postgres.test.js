const test = require('node:test');
const assert = require('node:assert/strict');
const { connectPostgres } = require('../lib/postgres');

function harness({ fail = false, constructorFails = false } = {}) {
    // This synthetic value must never reach logs, even through an error message.
    const secret = 'test-only-private-connection-value';
    const logs = [], queries = [];
    let options, ended = false, errorHandler;
    class FakePool {
        constructor(value) { if (constructorFails) throw Error(secret); options = value; }
        on(event, handler) { assert.equal(event, 'error'); errorHandler = handler; }
        async query(sql) { queries.push(sql); if (fail) throw Error(secret); return { rows: [{ '?column?': 1 }] }; }
        async end() { ended = true; }
    }
    const logger = { info: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) };
    return { secret, logs, queries, logger, FakePool, get options() { return options; }, get ended() { return ended; }, emitError() { errorHandler(Error(secret)); } };
}

test('PostgreSQL startup probe uses env, executes only SELECT 1 and logs no secrets', async () => {
    const h = harness();
    const pool = await connectPostgres({ env: { DATABASE_URL: h.secret }, PoolClass: h.FakePool, logger: h.logger });
    assert.ok(pool);
    assert.equal(h.options.connectionString, h.secret);
    assert.deepEqual(h.queries, ['SELECT 1']);
    assert.match(h.logs.join('\n'), /Connection successful/);
    h.emitError();
    assert.match(h.logs.join('\n'), /Connection lost/);
    assert.ok(!h.logs.join('\n').includes(h.secret));
});

test('failed PostgreSQL probe closes pool and does not expose errors or stop the game', async () => {
    const h = harness({ fail: true });
    assert.equal(await connectPostgres({ env: { DATABASE_URL: h.secret }, PoolClass: h.FakePool, logger: h.logger }), null);
    assert.equal(h.ended, true);
    assert.match(h.logs.join('\n'), /Connection failed/);
    assert.ok(!h.logs.join('\n').includes(h.secret));
});

test('invalid connection options and missing DATABASE_URL are handled safely', async () => {
    const h = harness({ constructorFails: true });
    assert.equal(await connectPostgres({ env: { DATABASE_URL: h.secret }, PoolClass: h.FakePool, logger: h.logger }), null);
    assert.ok(!h.logs.join('\n').includes(h.secret));
    const empty = harness();
    assert.equal(await connectPostgres({ env: {}, PoolClass: empty.FakePool, logger: empty.logger }), null);
    assert.equal(empty.options, undefined);
    assert.deepEqual(empty.queries, []);
    assert.match(empty.logs.join('\n'), /skipped/);
});
