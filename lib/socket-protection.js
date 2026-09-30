const EVENTS = new Set(['syncState', 'changeName', 'createRoom', 'joinRoom', 'updateRoomSettings', 'startGame',
    'submitAnswer', 'nextQuestion', 'nextRound', 'leaveRoom', 'resetSession', 'adminLogin', 'adminRead',
    'adminStats', 'adminMutate', 'adminUploadCategoryImage', 'adminLogout']);

// Bounded traversal counts binary data without Buffer.toJSON() expansion. Deep
// objects, extra binary attachments and oversized metadata are rejected early.
function payloadFits(value, budget, allowBinary = false) {
    const pending = [[value, 0]];
    while (pending.length) {
        const [item, depth] = pending.pop();
        if (depth > 32) return false;
        if (Buffer.isBuffer(item)) {
            if (!allowBinary) return false;
            budget -= item.length;
        } else if (typeof item === 'string') budget -= Buffer.byteLength(item) + 2;
        else if (item && typeof item === 'object') {
            const entries = Object.entries(item);
            budget -= 2 + entries.length * 2;
            if (budget < 0) return false;
            for (const [key, child] of entries) {
                budget -= Buffer.byteLength(key) + 3;
                pending.push([child, depth + 1]);
            }
        } else budget -= 8;
        if (budget < 0) return false;
    }
    return true;
}
function installSocketProtection(io, limits, { now = Date.now } = {}) {
    io.on('connection', socket => {
        const buckets = new Map();
        function take(key, capacity) {
            const time = now(), bucket = buckets.get(key) || { tokens: capacity, at: time };
            bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, time - bucket.at) * capacity / limits.rateWindowMs);
            bucket.at = time;
            buckets.set(key, bucket);
            if (bucket.tokens < 1) return false;
            bucket.tokens--;
            return true;
        }
        socket.use(([event, ...args], next) => {
            const ack = typeof args.at(-1) === 'function' ? args.pop() : null;
            const deny = (message, extra = {}) => {
                const response = { ok: false, message, ...extra };
                if (ack) ack(response); else socket.emit('error', { message });
            };
            if (!take('*', limits.rateTotal)) return deny('طلبات كثيرة. انتظر قليلًا ثم حاول مجددًا.');
            if (!EVENTS.has(event)) return deny('طلب غير صالح.');
            const capacity = ['createRoom', 'joinRoom'].includes(event) ? limits.rateRooms
                : event === 'submitAnswer' ? limits.rateAnswers
                : event === 'adminUploadCategoryImage' ? limits.rateUploads
                : event.startsWith('admin') ? limits.rateAdmin : limits.rateEvent;
            if (!take(event, capacity)) return deny('طلبات كثيرة. انتظر قليلًا ثم حاول مجددًا.');
            const upload = event === 'adminUploadCategoryImage';
            if (upload && !(socket.data.adminUntil > Date.now())) return deny('سجّل الدخول إلى وضع المطور أولًا.', { unauthorized: true });
            const payload = args[0];
            const budget = upload ? limits.imageUploadBytes + 1024
                : event === 'adminMutate' && payload?.action === 'importQuestions' ? limits.importBytes + 1024 : limits.eventBytes;
            if (args.length > 1 || !payloadFits(payload, budget, upload)) return deny('حجم الطلب كبير أو بياناته غير صالحة.');
            next();
        });
    });
}
module.exports = { installSocketProtection, payloadFits };
