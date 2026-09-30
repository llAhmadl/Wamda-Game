const GENERIC_ERROR = 'تعذر إكمال الطلب. حاول مرة أخرى.';
class ClientError extends Error {}
const clientError = message => new ClientError(message);
const clientMessage = error => error instanceof ClientError ? error.message : GENERIC_ERROR;

function onClientEvent(socket, event, handler) {
    socket.on(event, (...args) => {
        const originalReply = typeof args.at(-1) === 'function' ? args.at(-1) : null;
        let replied = false;
        const reply = value => { if (!replied) { replied = true; originalReply(value); } };
        if (originalReply) args[args.length - 1] = reply;
        const failed = error => {
            if (originalReply) reply({ ok: false, message: clientMessage(error) });
            else if (socket.connected) socket.emit('error', { message: clientMessage(error) });
        };
        try { Promise.resolve(handler(...args)).catch(failed); }
        catch (error) { failed(error); }
    });
}
function httpErrorHandler(error, req, res, next) {
    if (res.headersSent) { res.destroy(); return; }
    const status = error.status === 400 || error.status === 404 ? error.status : 500;
    res.status(status).json({ ok: false, message: GENERIC_ERROR });
}
module.exports = { clientError, clientMessage, onClientEvent, httpErrorHandler, GENERIC_ERROR };
