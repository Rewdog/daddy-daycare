# GitHub Copilot Instructions — DayCare

Summer 2026 chore and reward tracker built for a family summer program.
Full project rules are in `CLAUDE.md` at the repo root.

## Stack

- Vanilla HTML/CSS/JavaScript — no build step, no bundler, no TypeScript
- Cloudflare Worker (`worker.js`) handles all `/api/*` routes + serves static files
- All state in Cloudflare KV (`DAYCARE_KV` binding) — no localStorage
- Session auth via `Authorization: Bearer {token}` header

## Branch Rule — CRITICAL

**ALL changes go to the `dev` branch. Never commit or push to `main`.**

Both Workers are connected directly to GitHub — **pushing is all you need to do.**

| Branch | Worker | URL | Auto-deploys? |
|--------|--------|-----|---------------|
| `dev` | `daycare-dev` | `your-daycare-dev.workers.dev` | ✅ yes |
| `main` | `daycare` (production) | `your-daycare.workers.dev` | ✅ yes |

```
git checkout dev        # always work here
git push origin dev     # push here — Cloudflare auto-deploys daycare-dev
```

**Do NOT run `wrangler deploy`.** Cloudflare handles deployment automatically on push.
Only Dad merges dev → main after review.

## Tests — Run Before Every Push

```bash
bun test
```

Tests live in `tests/`. **All 21 must pass before pushing.** The pre-push git hook enforces this automatically once wired up:

```bash
git config core.hooksPath .githooks  # one-time setup per clone
```

**What the tests cover:**
- `tests/worker.test.js` — IP restriction, CORS, auth routes (401/403/404), Dad-only enforcement
- `tests/app-invariants.test.js` — `appState` shape consistency, regression guard for `refreshState`, no localStorage

**The regression guard (most important test):** `refreshState()` replaces the entire `appState` object. If you add a new field to `resetAppState()`, you MUST also add it to the `appState = { ... }` assignment inside `refreshState()`. Forgetting this causes that field to become `undefined` after the first API refresh, which crashes renderers. The test explicitly checks this and will fail with a clear message naming the missing field.

## Key Rules

- Never add localStorage — all state goes through the Worker API
- Never modify `index.html` or `style.css` without Dad's approval — kids built these
- Dad must approve all point awards — never auto-credit tokens
- New API routes go in `worker.js`, new client logic goes in `app.js`
- Run `bun test` before pushing — or the pre-push hook will block you
- Test at `your-daycare-dev.workers.dev` before anything touches `main`

## Points Economy

Earning: workout (30), reading/30min (60), cook (25), unprompted chores (15), creative project (25), kind/help your sibling (60), clean house (50), trash (10), new badge (30).

Spending: Extra screen time (45), Small treat (45), Special outing (60).

Dad approves all submissions. Kids can appeal. Max one of each activity per day.
