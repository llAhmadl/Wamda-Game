function integer(env, name, fallback, maximum = 100000) {
    if (env[name] === undefined || env[name] === '') return fallback;
    const value = Number(env[name]);
    if (!/^\d+$/.test(env[name]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw Error(`${name} must be a positive integer no greater than ${maximum}.`);
    }
    return value;
}
function readLimits(env = process.env) {
    const imageUploadBytes = integer(env, 'IMAGE_UPLOAD_MAX_BYTES', 2 * 1024 * 1024, 2 * 1024 * 1024);
    const importBytes = integer(env, 'QUESTION_IMPORT_MAX_BYTES', 500000, 500000);
    // Polling encodes binary attachments as base64. Reserve only 1 KiB for
    // packet framing/metadata; reducing below this breaks valid 2 MiB uploads.
    const minimumBuffer = Math.max(Math.ceil(imageUploadBytes / 3) * 4, importBytes) + 1024;
    const socketBufferBytes = integer(env, 'SOCKET_MAX_BUFFER_BYTES', minimumBuffer, 16 * 1024 * 1024);
    if (socketBufferBytes < minimumBuffer) throw Error('SOCKET_MAX_BUFFER_BYTES is too small for configured image/import limits.');
    return {
        imageUploadBytes, importBytes, socketBufferBytes,
        concurrentUploads: integer(env, 'MAX_CONCURRENT_IMAGE_UPLOADS', 2, 16),
        eventBytes: integer(env, 'SOCKET_EVENT_MAX_BYTES', 8192, 65536),
        rateWindowMs: integer(env, 'SOCKET_RATE_WINDOW_MS', 10000, 60000),
        rateTotal: integer(env, 'SOCKET_RATE_TOTAL', 120),
        rateEvent: integer(env, 'SOCKET_RATE_EVENT', 60),
        rateRooms: integer(env, 'SOCKET_RATE_ROOMS', 10),
        rateAnswers: integer(env, 'SOCKET_RATE_ANSWERS', 60),
        rateAdmin: integer(env, 'SOCKET_RATE_ADMIN', 30),
        rateUploads: integer(env, 'SOCKET_RATE_UPLOADS', 6),
        playersPerRoom: integer(env, 'MAX_PLAYERS_PER_ROOM', 32),
        rooms: integer(env, 'MAX_ROOMS', 100),
        connections: integer(env, 'MAX_CONNECTIONS', 500),
        connectionsPerIp: integer(env, 'MAX_CONNECTIONS_PER_IP', 40),
        sessions: integer(env, 'MAX_SESSIONS', 5000),
        adminLoginIps: integer(env, 'MAX_ADMIN_LOGIN_IPS', 5000),
        handshakeTimeoutMs: integer(env, 'HANDSHAKE_TIMEOUT_MS', 10000, 60000)
    };
}
module.exports = { integer, readLimits };
