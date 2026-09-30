function integer(env, name, fallback, maximum = 100000) {
    if (env[name] === undefined || env[name] === '') return fallback;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw Error(`${name} must be a positive integer no greater than ${maximum}.`);
    }
    return value;
}
function readLimits(env = process.env) {
    return {
        playersPerRoom: integer(env, 'MAX_PLAYERS_PER_ROOM', 32),
        rooms: integer(env, 'MAX_ROOMS', 100),
        connections: integer(env, 'MAX_CONNECTIONS', 500),
        connectionsPerIp: integer(env, 'MAX_CONNECTIONS_PER_IP', 40),
        sessions: integer(env, 'MAX_SESSIONS', 5000),
        handshakeTimeoutMs: integer(env, 'HANDSHAKE_TIMEOUT_MS', 10000, 60000)
    };
}
module.exports = { integer, readLimits };
