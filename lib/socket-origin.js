function createOriginCheck(env = process.env, port = () => Number(env.PORT || 3000)) {
    const production = env.NODE_ENV === 'production';
    const value = env.ALLOWED_ORIGINS?.trim();
    if (production && !value) throw Error('Production requires ALLOWED_ORIGINS with the exact HTTPS site origins.');
    let origins;
    if (value) {
        try {
            origins = new Set(value.split(',').map(entry => {
                const text = entry.trim(), url = new URL(text);
                if (!['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:') ||
                    url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) throw Error();
                return url.origin;
            }));
        } catch { throw Error('ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins without paths or wildcards.'); }
    }
    // Same-origin polling GETs and native clients can omit Origin. This check is
    // browser cross-origin protection, not authentication or protection from bots.
    return origin => origin === undefined || (origins
        ? origins.has(origin)
        : [`http://localhost:${port()}`, `http://127.0.0.1:${port()}`, `http://[::1]:${port()}`].includes(origin));
}
function socketOriginOptions(allowed) {
    return {
        cors: { origin: (origin, callback) => callback(null, allowed(origin)), methods: ['GET', 'POST'] },
        // CORS alone does not protect WebSocket handshakes.
        allowRequest: (req, callback) => callback(allowed(req.headers.origin) ? null : 'مصدر الاتصال غير مسموح.', allowed(req.headers.origin))
    };
}
module.exports = { createOriginCheck, socketOriginOptions };
