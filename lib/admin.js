const { clientError, clientMessage, onClientEvent } = require('./client-errors');
const { createHash, timingSafeEqual } = require('node:crypto');

function installAdmin(io, rooms, store, { onChanged = () => {}, env = process.env } = {}) {
    const code = env.ADMIN_CODE;
    const digest = value => createHash('sha256').update(value).digest();
    const attempts = new Map();
    const expiry = 60 * 60 * 1000;
    function stats() {
        const players = [...io.sockets.sockets.values()].filter(s => s.data.name).map(s => ({
            name: s.data.name, room: s.data.roomCode || '', host: rooms.get(s.data.roomCode)?.hostId === s.data.playerId
        }));
        return { connections: io.sockets.sockets.size, players, rooms: rooms.size };
    }
    io.on('connection', socket => {
        onClientEvent(socket, 'adminLogin', (payload, reply) => {
            if (typeof reply !== 'function') return;
            if (!code) return reply({ ok: false, message: 'وضع المطور غير مفعّل. أضف ADMIN_CODE إلى إعدادات الخادم.' });
            const now = Date.now();
            for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
            const key = socket.data.clientIp || socket.handshake.address;
            const attempt = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
            if (attempt.count >= 5) return reply({ ok: false, message: 'محاولات كثيرة. حاول بعد 15 دقيقة.' });
            attempt.count++;
            attempts.set(key, attempt);
            if (typeof payload?.code !== 'string' || payload.code.length > 256 || !timingSafeEqual(digest(payload.code), digest(code))) return reply({ ok: false, message: 'الكود غير صحيح.' });
            attempts.delete(key);
            socket.data.adminUntil = now + expiry;
            reply({ ok: true, ...store.snapshot(), stats: stats() });
        });
        function protectedEvent(event, action) {
            onClientEvent(socket, event, async (payload, reply) => {
                if (typeof reply !== 'function') return;
                if (!(socket.data.adminUntil > Date.now())) return reply({ ok: false, unauthorized: true, message: 'سجّل الدخول إلى وضع المطور أولًا.' });
                try { reply({ ok: true, ...await action(payload || {}) }); }
                catch (error) { reply({ ok: false, message: clientMessage(error) }); }
            });
        }
        protectedEvent('adminRead', async () => ({ ...await store.refresh(), stats: stats() }));
        protectedEvent('adminStats', () => ({ stats: stats() }));
        protectedEvent('adminMutate', async payload => { const state = await store.mutate(payload); onChanged(); return state; });
        let uploading = false;
        protectedEvent('adminUploadCategoryImage', async payload => {
            if (uploading) throw clientError('انتظر اكتمال رفع الصورة الحالية.');
            uploading = true;
            try { return await store.uploadCategoryImage(payload); }
            finally { uploading = false; }
        });
        protectedEvent('adminLogout', () => { socket.data.adminUntil = 0; return {}; });
    });
}
module.exports = { installAdmin };
