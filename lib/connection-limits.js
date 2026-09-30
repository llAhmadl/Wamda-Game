function createConnectionGate(limits, clientIp) {
    const counts = new Map();
    const reservations = new WeakMap();
    let total = 0;
    return {
        allowRequest(req, callback) {
            const ip = clientIp(req);
            req.clientIp = ip;
            if (total >= limits.connections || (counts.get(ip) || 0) >= limits.connectionsPerIp) {
                return callback('عدد الاتصالات كبير. حاول بعد قليل.', false);
            }
            total++;
            counts.set(ip, (counts.get(ip) || 0) + 1);
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                clearTimeout(timer);
                req.socket.off('close', release);
                total--;
                const remaining = counts.get(ip) - 1;
                if (remaining) counts.set(ip, remaining); else counts.delete(ip);
            };
            const timer = setTimeout(release, limits.handshakeTimeoutMs);
            timer.unref();
            req.socket.once('close', release);
            reservations.set(req, { release, attach(socket) {
                if (released) { socket.close(true); return; }
                clearTimeout(timer);
                req.socket.off('close', release);
                socket.once('close', release);
            } });
            callback(null, true);
        },
        install(engine) {
            engine.on('connection', socket => reservations.get(socket.request)?.attach(socket));
            engine.on('connection_error', ({ req }) => reservations.get(req)?.release());
        }
    };
}
module.exports = { createConnectionGate };
