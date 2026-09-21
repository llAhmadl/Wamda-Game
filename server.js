const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { installMultiplayer, QUESTIONS_PER_ROUND, TOTAL_ROUNDS, DURATION } = require("./lib/multiplayer");
const { version: siteVersion } = require("./package.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 + 64 * 1024 });

const PORT = Number(process.env.PORT ?? 3000);

app.get("/api/site", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion });
});

app.get("/api/version", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ version: siteVersion, rounds: TOTAL_ROUNDS, questionsPerRound: QUESTIONS_PER_ROUND, duration: DURATION });
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

const { sendLobby } = installMultiplayer(io, rooms, questionStore);

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
