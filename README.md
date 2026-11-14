# Wamda

A real-time multiplayer quiz game in Arabic. One player hosts a room, friends join with a five-letter code or an invite link, and everyone races to answer first.

**Live:** [wamda-i0c9.onrender.com](https://wamda-i0c9.onrender.com)

## How it plays

- Two rounds of ten questions, 15 or 20 seconds each.
- The host picks the categories and how many players score per question: the first 1, 3, 5 or 7 correct answers.
- Answers are ranked by the order the server receives them. A wrong answer takes no place.
- Players who drop out reconnect to the same seat with their score and answer intact. If the host is gone for 30 seconds, the oldest connected player takes over.

## Stack

Node.js 22, Express, Socket.IO and PostgreSQL (Supabase). The client is plain HTML, CSS and JavaScript with no build step. Sounds are generated with the Web Audio API.

The server owns the game state. Correct answers, scores and timers are never sent to a client before a question closes.

## Running locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. Without `DATABASE_URL`, question banks are stored in `data/banks.json`.

To use Developer Mode locally, copy `.env.example` to `.env`, set `ADMIN_CODE`, and start with:

```bash
node --env-file=.env server.js
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_CODE` | Developer Mode password. Required in production, 12–256 characters. |
| `DATABASE_URL` | PostgreSQL connection string for question banks and category images. |
| `ALLOWED_ORIGINS` | Comma-separated HTTPS origins allowed to open a socket. Required in production. |
| `NODE_ENV` | Set to `production` on the server. |

The server never creates tables. Run the SQL files in [`migrations/`](migrations) manually before the first deploy.

## Developer Mode

Available at `/developer`. It manages question banks, categories and images, imports and exports JSON, and shows live players and rooms. Question counts are only visible here. Players never receive them.

## Tests

```bash
npm test
```

The suite covers full matches with real Socket.IO clients, scoring races, reconnection, host transfer, admin access and storage against an in-process PostgreSQL (PGlite).

## Deployment

Hosted on Render. `development` deploys to staging and `main` deploys to production. Rooms live in memory, so the app runs as a single instance.

## Credits

Fonts: [Tajawal](https://fonts.google.com/specimen/Tajawal) and [Baloo Bhaijaan 2](https://fonts.google.com/specimen/Baloo+Bhaijaan+2), both under the SIL Open Font License.
