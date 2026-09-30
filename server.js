const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { installMultiplayer, QUESTIONS_PER_ROUND, TOTAL_ROUNDS, DURATION } = require("./lib/multiplayer");
const { version: siteVersion } = require("./package.json");

const { securityHeaders } = require("./lib/security-headers");
const { configureClientIp } = require("./lib/client-ip");
const app = express();
const { validateAdminConfig } = require('./lib/security-config');
const { createOriginCheck, socketOriginOptions } = require('./lib/socket-origin');
const { readLimits } = require('./lib/limits');
const { createConnectionGate } = require('./lib/connection-limits');
let clientIp, allowedOrigin, limits;
try {
    validateAdminConfig();
    limits = readLimits();
    clientIp = configureClientIp(app);
    allowedOrigin = createOriginCheck(process.env, () => server.address()?.port || Number(process.env.PORT || 3000));
} catch (error) {
    console.error(`[Startup] ${error.message}`);
    process.exit(1);
}
app.disable('x-powered-by');
const headers = securityHeaders();
app.use(headers);
const server = http.createServer(app);
const gate = createConnectionGate(limits, clientIp);
const originOptions = socketOriginOptions(allowedOrigin);
const io = new Server(server, {
    ...originOptions,
    allowRequest(req, callback) {
        originOptions.allowRequest(req, (error, allowed) => {
            if (!allowed) return callback(error, false);
            gate.allowRequest(req, callback);
        });
    },
    connectTimeout: limits.handshakeTimeoutMs,
    maxHttpBufferSize: limits.socketBufferBytes
});
gate.install(io.engine);

io.engine.use(headers);
io.engine.use((req, res, next) => {
    if (!allowedOrigin(req.headers.origin)) return next(new Error('مصدر الاتصال غير مسموح.'));
    next();
});
io.engine.use((req, res, next) => { req.clientIp = clientIp(req); next(); });
io.use((socket, next) => { socket.data.clientIp = socket.request.clientIp; next(); });

const { installSocketProtection } = require('./lib/socket-protection');
installSocketProtection(io, limits);

const PORT = Number(process.env.PORT ?? 3000);

app.get("/api/site", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion });
});

app.get("/api/version", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion, rounds: TOTAL_ROUNDS, questionsPerRound: QUESTIONS_PER_ROUND, duration: DURATION });
});
// Serve the same client shell for the developer page; socket auth remains server-owned.
app.get("/developer", (req, res) => {
    if (req.path.endsWith("/")) return res.redirect(308, "/developer");
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "public/index.html"));
});
app.get("/favicon.png", (req, res) => res.sendFile(path.join(__dirname, "favicon.png")));
app.use(express.static(path.join(__dirname, "public"), {
    setHeaders(res, filename) { res.set("Cache-Control", /\.(webp|svg|ttf)$/.test(filename) ? "public, max-age=3600" : "no-store"); }
}));

// -------------------------
// Questions
// -------------------------

const { createQuestionStore } = require("./lib/question-store");
const { installAdmin } = require("./lib/admin");
const { installCategoryImages } = require("./lib/category-images");
const questionStore = createQuestionStore({ required: QUESTIONS_PER_ROUND * TOTAL_ROUNDS });
installCategoryImages(app, questionStore);


// -------------------------
// Rooms
// -------------------------

const rooms = new Map();

const { sendLobby } = installMultiplayer(io, rooms, questionStore, { limits });

installAdmin(io, rooms, questionStore, {
    onChanged() {
        for (const [code, room] of rooms) if (!room.started) sendLobby(code);
    }
});

// Start server

questionStore.init().then(() => {
    server.listen(PORT, () => console.log(`وَمْضة running at http://localhost:${server.address().port}`));
}).catch(error => {
    console.error("تعذر تحميل بنك الأسئلة:", error.code || "storage error");
    process.exitCode = 1;
});
