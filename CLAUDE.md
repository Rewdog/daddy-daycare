# DayCare — Claude Code Rules

> A token economy and gamification system for family summer programs.

## Stack

- **Runtime:** Vanilla HTML/CSS/JavaScript — no build system, no package manager
- **Deploy:** Cloudflare Workers (serving static assets via `assets.directory`)
- **Storage:** Cloudflare KV (replacing localStorage — data must sync across devices)
- **Config:** `wrangler.jsonc`
- **Repo:** github.com/YOUR_USERNAME/YOUR_REPO_NAME

## Branch and Deploy Rules — READ THIS FIRST

> **AI assistants (GitHub Copilot, Claude, any agent): ALL new work goes to the `dev` branch. NEVER push to `main` directly.**

| Environment | Worker Name | URL | Branch | Deploy command |
|-------------|-------------|-----|--------|----------------|
| **dev** | `daycare-dev` | `your-daycare-dev.workers.dev` | `dev` | `bunx wrangler deploy --env dev` |
| **production** | `daycare` | `your-daycare.workers.dev` | `main` | `bunx wrangler deploy` (Dad only) |

**Workflow every time:**
1. Switch to `dev` branch: `git checkout dev` (create it if it doesn't exist: `git checkout -b dev`)
2. Make your changes
3. Commit and push to `dev`: `git push origin dev`
4. Deploy to test: `bunx wrangler deploy --env dev`
5. Test at `your-daycare-dev.workers.dev`
6. Only after Dad reviews and approves: merge `dev` → `main`

**Why:** `main` auto-deploys to production — the real app the kids use. A broken push to `main` breaks the family app immediately. `dev` is the safe sandbox.

**NEVER:** `git push origin main` or `git checkout main && git commit`

## What this app does

Token economy and gamification system for a family summer program:

**Dad view:** Approve/deny chore and streak submissions, manage token bank, monitor all pending items.

**Kid view:** Submit activities for points, log daily streaks, unlock achievement badges, redeem tokens for rewards.

## Points Economy (Example economy — customize in schedule.config.js)

**Core intention:** Build positive relationships between kids — kindness, encouragement, doing things together. Household chores are secondary.

**Earning points:**
| Activity | Points |
|----------|--------|
| Be kind / help your sibling | 60 |
| Encourage your sibling | 30 |
| Help your sibling with something | 40 |
| No fighting — play together 1 hour | 30 |
| No fighting — whole day | 40 |
| Work on a project together | 40 |
| Morning workout / exercise | 30 |
| Reading (per 30 min) | 60 |
| Complete a creative project | 25 |
| Help cook a meal | 25 |
| Chores without being asked | 15 |
| Clean the house | 50 |
| Take out the trash | 10 |
| Puppy recess (walk the dogs) | 15 |
| Feed or give puppy a treat | 10 |

**Spending points (Rewards Shop):**
| Reward | Cost |
|--------|------|
| 30 min extra screen time | 45 |
| Pick the movie Friday | 15 |
| Choose dinner one night | 30 |
| Small treat / snack run | 45 |
| Special outing (your pick) | 60 |
| Stay up 30 min later | 45 |
| 30 min alone with Dad | 45 |

**Rules:**
- Max one of each activity per day
- Points carry over forever — no expiration
- Points can be lost for being unkind
- Dad approves all submissions; kids can appeal

## Feature Roadmap (suggested priorities)

**Must-have (launch day):**
1. Achievement Badges — Super Sibling, Master Cleaner, Dad Assistant, Family MVP, Chore Beast
2. Streak System — 5-day helping, 7-day kindness, unlimited workout
3. Rewards Shop — spend points on the reward table above

**Post-launch:**
4. Family Leaderboard — visual comparison, motivation
5. Random Wheel / Spinner — "Today's Family Challenge" (Nerf battle, board game night, etc.)
6. Losing point system — negative points for bad behavior
7. Sound effects
8. Music

## Persistent Storage — Cloudflare KV

localStorage doesn't sync across devices. Dad approves on his phone; kids submit on theirs.
All state must live in KV:

| KV Key Pattern | Data |
|---------------|------|
| `user:{role}:balance` | Token balance |
| `user:{role}:streaks` | Streak state |
| `user:{role}:badges` | Earned badges |
| `pending:submissions` | Queue awaiting Dad approval |
| `history:{date}:{role}` | Daily activity log |

## Tests — Run Before Every Push

```bash
bun test
```

Tests live in `tests/`. All 21 must pass. The pre-push hook enforces this automatically:

```bash
git config core.hooksPath .githooks  # one-time setup per clone
```

**`tests/worker.test.js`** — IP restriction, CORS preflight, auth gating (401/403/404), Dad-only enforcement for approve/adjust endpoints.

**`tests/app-invariants.test.js`** — Critical structural checks on `app.js`:
- `refreshState()` must preserve every field that `resetAppState()` declares. If you add a new field to `resetAppState`, add it to `refreshState` too — or the test will fail naming the missing field.
- No `localStorage` usage (all state via KV API)
- Key functions (`apiFetch`, `refreshState`, `renderDadView`) must remain defined

**Adding a new `appState` field?** Add it in both places:
1. `resetAppState()` — the initial/logout reset
2. `refreshState()` — the `appState = { ... }` assignment

Missing step 2 is the exact bug class these tests prevent.

## Critical Invariants

- **Kids built this.** Preserve your kids' code style unless explicitly asked for changes.
- **Dad must approve all point awards.** Never auto-credit — pending queue is sacred.
- **No build step.** `index.html`, `app.js`, `style.css` are the artifacts. No bundler unless explicitly approved.
- **Dev before prod.** Every feature goes to `daycare-dev` first. Verify, then merge to `main`.

## Deployment (Auto-deploy via Cloudflare GitHub integration)

Both Workers are connected directly to GitHub — **no manual wrangler deploys needed.**

| Branch | Worker | URL | Deploys automatically on push |
|--------|--------|-----|-------------------------------|
| `dev` | `daycare-dev` | `your-daycare-dev.workers.dev` | ✅ yes |
| `main` | `daycare` | `your-daycare.workers.dev` | ✅ yes |

- Push to `dev` → Cloudflare builds and deploys `daycare-dev` automatically.
- Push to `main` → Cloudflare builds and deploys `daycare` (production) automatically.
- **AI assistants and Copilot: just push to `dev`. Do not run wrangler.**

## Wrangler Commands (local dev only)

```bash
# Local dev server
bunx wrangler dev

# Manual deploy only needed if auto-deploy is broken
bunx wrangler deploy --env dev
bunx wrangler deploy --env production
```

## App Identity

- **Name:** Daddy Daycare
- **Vibe:** Fun
- **Colors:** Light blue & white
- **Icon:** Symbol-based (customize as desired)
