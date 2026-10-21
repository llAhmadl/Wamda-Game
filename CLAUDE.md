# وَمْضة (Wamda) — project rules

Real-time multiplayer Arabic quiz game. Express + Socket.IO + PostgreSQL (Supabase) + vanilla JS, no build step.

## Workflow
- `main` → production (`wamda`, https://wamda-i0c9.onrender.com). Do not touch until the owner says the site is ready.
- `development` → staging (`wamda-staging`, https://wamda-staging.onrender.com), auto-deploys on push.
- Work on a feature branch off `development`, merge back into `development`, test on staging.
- Never commit, push, merge or deploy without the owner's explicit approval.
- Version lives only in `package.json`: `npm version X.Y.Z --no-git-tag-version`.
- Run `npm test` (Node 22) before every commit; all tests must pass.

## Shared database (intentional)
Staging and production use the **same** Supabase database (`public.wamda_banks` row id=1, `public.wamda_category_images`).
- Any change to the stored bank format must stay readable by the code currently on `main`. Old code throws on an unknown `schemaVersion` and on category images outside its allow-list (`lib/question-store.js` `validate`). Warn the owner before such a change.
- New category images go through Developer Mode upload (`/category-images/<uuid>.webp`), not new static files, until `main` is updated.
- Destructive tests (deleting banks/questions) on staging affect production data.
- The server never creates tables; migrations in `migrations/` are run manually in Supabase by the owner.

## Architecture constraints
- The server is authoritative: scoring, timers and correct answers never reach the client before a question closes.
- Rooms and sessions live in memory: single instance only.
- Render free plan: the server sleeps after ~15 min idle, which wipes in-memory rooms. Accepted until launch.
- Socket event contract (`lib/multiplayer.js`, `lib/admin.js`) is shared with the client; changing it means updating both sides and tests.
- Limits come from env (`lib/limits.js`). Production (`NODE_ENV=production`) requires `ADMIN_CODE` (12–256 chars) and HTTPS `ALLOWED_ORIGINS`.

## UI conventions
- Arabic, RTL. Tajawal only (400/500/700, self-hosted WOFF2 with TTF fallback).
- Accent `#87BDFF` (light) / `#FF6D42` (dark), errors `#FF4D4D`. Tokens on `:root` in `public/style.css`.
- Respect `prefers-reduced-motion` and `prefers-reduced-transparency`.
- CSP is `'self'`: no inline scripts, no CDNs.
- Keep the localStorage keys `firsthit-theme` and `wamda-session-v1` (existing players depend on them).
- `public/name-validation.js` must mirror `lib/player-name.js` (parity test in `tests/player-name.test.js`).

## Secrets
`ADMIN_CODE` and `DATABASE_URL` exist only in Render env. Never in Git, `public/`, logs or tests.
