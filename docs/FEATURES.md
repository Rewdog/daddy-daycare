# Feature Reference

Complete guide to everything Daddy Daycare does and how to configure it.

---

## Table of Contents

1. [How it works — the big picture](#how-it-works)
2. [Roles & login](#roles--login)
3. [Token economy](#token-economy)
4. [Chores](#chores)
5. [Streaks](#streaks)
6. [Rewards shop](#rewards-shop)
7. [Affirmations](#affirmations)
8. [Daily schedule](#daily-schedule)
9. [Easter Egg Challenges](#easter-egg-challenges)
10. [TV dashboard](#tv-dashboard)
11. [Avatars](#avatars)
11. [Token bank](#token-bank)
12. [Spend notifications](#spend-notifications)
13. [Configuration reference](#configuration-reference)
14. [Storage reference (KV schema)](#storage-reference)

---

## How it works

The app is a token economy system for kids during a structured home program (summer, school break, etc.). The loop is simple:

1. **Kids do things** — chores, daily streaks, writing affirmations — and submit them through the app.
2. **A parent approves or denies** every submission. Nothing auto-credits.
3. **Kids accumulate Summer Tokens** (☀️) and spend them in the rewards shop.
4. **The TV dashboard** runs on the living room screen all day, showing live scores, streaks, the schedule, and motivational messages.

All data lives in Cloudflare KV and syncs across every device in real time. No accounts, no email — just role buttons and passwords.

---

## Roles & Login

### Roles

Roles are split into two categories:

- **Parent roles** — get the parent view with approval controls, token bank, and chore/reward admin. Configured via `PARENT_ROLES` in `wrangler.jsonc`.
- **Kid roles** — get the kid view with chore submissions, streaks, and the rewards shop. Configured via `KID_ROLES` in `wrangler.jsonc`.

Default parent roles: `Dad`, `Mom`
Default kid roles: `Child 1`, `Child 2`

### Logging In

1. Tap your character's button on the login screen.
2. Enter your password and hit **Continue**.
3. First login ever for a role triggers a **password setup flow** (enter once, confirm, saved).

Sessions last 14 days. The app remembers your session across browser closes until it expires or you sign out.

### IP Restriction (Optional)

Set `ALLOWED_IP` in `wrangler.jsonc` to your home IP address to lock the app so it only works from your home network. Requests from other IPs get a 403. Leave it empty to allow access from anywhere.

---

## Token Economy

**Summer Tokens (☀️)** are the currency of the whole system.

### Earning tokens

| Source | How |
|--------|-----|
| Chores | Submitting a chore and getting parent approval awards the chore's token value |
| Affirmations | First 3 affirmations a kid writes per day earn 3 ☀️ each (9 max per day) |

Tokens never expire. They carry over forever until spent.

### Losing tokens

Kids can only lose tokens by spending them in the rewards shop, or if a parent manually withdraws from the token bank (e.g., as a consequence for behavior).

### Balances

- Kids see their balance in the header at all times.
- Parents see all kids' balances in the **Kids' Balances** section of the parent view.
- The TV dashboard shows a live scoreboard with both kids' token counts.

---

## Chores

### The submission flow

1. Kid opens the **Chores** panel and taps **Submit +X ☀️** on a chore.
2. The button changes to **⏳ Waiting...** — the chore enters the pending queue.
3. Parent sees it in **Pending Approvals** and taps **Approve** or **Deny**.
4. If approved: tokens added, button shows **✅ Approved** (green, disabled).
5. If denied: button reverts to **Resubmit +X ☀️** in red — kid can try again.

Each chore can only be submitted once per day (same day key + chore ID). Duplicate attempts silently deduplicate.

### Chore-to-streak connections

Some chores automatically advance streaks when approved. The connections are:

| Chore ID | Advances streak |
|----------|----------------|
| `be-kind-sibling`, `encourage-sibling`, `no-fighting-day` | Kindness |
| `help-sibling`, `play-together-1hr`, `project-together`, `teamwork-activity` | Helping |
| `morning-workout` | Workout |

You can edit `CHORE_STREAK_MAP` in `worker.js` if you change chore IDs.

### Ad-hoc chore requests

Kids can ask for points on something not in the list. They tap **"Ask for points on another chore"**, describe what they did, and submit. The parent sees the description in the pending queue and assigns a point value at approval time.

### Chore admin (parents)

Parents have a **🛠️ Chore Admin** section with:
- Inline edit of chore name and point value
- **Add Chore** button
- **Save Chores** to persist changes
- Chores are stored in KV and shown to all kids on next refresh

Default chores (14 total):

| Label | Points |
|-------|--------|
| 💛 Be Kind to Your Sibling | 60 |
| 🙌 Encourage Your Sibling | 30 |
| 🤝 Help Your Sibling With Something | 40 |
| ✌️🤝 No Fighting — Play Together 1 Hour | 30 |
| ✌️ No Fighting — Whole Day | 40 |
| 🎨 Work on a Project Together | 40 |
| 🏅 Teamwork Activity Together | 30 |
| 💪 Morning Workout / Exercise | 30 |
| 📚 Reading (30 Minutes) | 60 |
| 🎭 Complete a Creative Project | 25 |
| 🍳 Help Cook a Meal | 25 |
| ⭐ Chores Without Being Asked | 15 |
| 🧽 Clean the House | 50 |
| 🗑️ Take Out the Trash | 10 |

> To change defaults permanently (before first deploy), edit `DEFAULT_CHORES` in `worker.js`. After first deploy, use the parent admin panel — KV overrides the hardcoded defaults.

---

## Streaks

Streaks track daily habits. Kids log them each day; a parent approves.

### How streaks work

- Log Today → pending queue → parent approves → streak increments.
- Approval must be for the **same calendar day**. If yesterday's was the last approval, today's adds one. If there was a gap, the streak resets to 1.
- Each streak tracks: **current** (active run), **best** (all-time), and **goal** (optional target).

### Core streaks (always present)

| Streak | Goal | What it's for |
|--------|------|---------------|
| 🤝 Helping Streak | 5 days | Helping out around the house and with siblings |
| 💛 Kindness Streak | 7 days | Being kind and encouraging to others |
| 💪 Workout Streak | None | Staying active every day (no goal, unlimited) |

### Extra streaks (family-specific)

Add any streaks your family needs in `schedule.config.js`:

```js
window.SCHEDULE_CONFIG = {
  extraStreaks: {
    "pet-care": {
      label: "🐾 Pet Care Streak",
      goal: 7,
      prompt: "Took care of the pet today",
      vacationHold: true,
    },
  },
};
```

Each entry:
- `label` — display name with emoji
- `goal` — target day count (0 = unlimited, no goal displayed)
- `prompt` — shown on the kid's log button tooltip area
- `vacationHold` — set to `true` to enable the **Vacation Keep-Alive** button

### Vacation Keep-Alive

For streaks with `vacationHold: true`, kids see a **🏖️ Vacation Keep-Alive** button. This lets them request that a parent "freeze" the streak during a vacation without it resetting. When approved in vacation-hold mode, the streak count stays the same but `lastApprovedDay` advances — keeping the chain alive without incrementing.

### Streak milestones

- Hitting a streak goal triggers a **"CRUSHED THE GOAL! 🏆"** announcement on the TV dashboard with confetti.
- New personal bests also trigger a dashboard announcement.

### Streak board

Both the kid view and parent view show a **Streak Board** with every kid's current and best count for every streak. The TV dashboard has a full **Streak Watch** panel with fire emoji bars showing progress toward the goal.

---

## Rewards Shop

Kids spend tokens on rewards from the **Cash Out** panel.

### How spending works

1. Kid taps a reward button showing the cost.
2. If they have enough: tokens deducted immediately, spend notification created.
3. If not enough: error message "Not enough Summer Tokens. Need X more."
4. No parent approval required for spending — it's immediate.

### Default rewards

| Reward | Cost |
|--------|------|
| 📱 30 Min Extra Screen Time | 45 ☀️ |
| 🎬 Pick the Movie Tonight | 15 ☀️ |
| 🍕 Choose Dinner One Night | 30 ☀️ |
| 🍦 Small Treat / Snack Run | 45 ☀️ |
| 🎉 Special Outing (Your Pick) | 60 ☀️ |
| 🌙 Stay Up 30 Min Later | 45 ☀️ |
| 💛 30 Min Alone With a Parent | 45 ☀️ |

> Edit default rewards in `worker.js` → `DEFAULT_REWARDS` before first deploy. After deploy, use the parent admin panel.

### Rewards admin

The parent view includes a rewards editor for inline editing. Changes persist in KV.

---

## Affirmations

Affirmations are kind messages kids (and parents) write to each other.

### Writing an affirmation

1. Tap **💛 Write an Affirmation** (in the kid view or from the Day Wrap block on the schedule).
2. Pick a recipient from the family (anyone except yourself).
3. Write a message (up to 400 characters) and submit.

### Token credit

Kids earn **3 ☀️** for writing an affirmation. They get credit for their first **3 affirmations per day** — so a maximum of 9 ☀️ per day from affirmations. No parent approval needed; credit is immediate.

Parents can write unlimited affirmations without earning tokens.

The kid view shows "X credit remaining" next to the affirmation button until the daily credit is used.

### Affirmation ticker

The TV dashboard shows a rotating carousel of recent affirmations — from who, to who, and what they said. It auto-advances based on message length (longer messages stay up longer, minimum 4 seconds).

---

## Daily Schedule

The schedule gives the day structure and helps kids know what's coming.

### How the schedule shows up

- Any user can tap **📅 Today's Schedule** to expand the schedule panel.
- Shows today's theme (name, emoji, suggested chores), the current/upcoming blocks, and a completion summary.
- Each block can be marked **Not Done**, **In Progress**, or **Done** by parents.

### Week ranges

Named periods shown in the dashboard header. Useful for labeling vacations, camps, or special phases:

```js
weekRanges: [
  { start:[2026,6,2], end:[2026,6,6], emoji:"🚀", label:"Week 1 — Build Sprint", note:"First week!" },
  { start:[2026,6,22], end:[2026,6,27], emoji:"🚢", label:"CRUISE! 🚢", note:"OFF — we're on a boat" },
]
```

### Day themes

Each weekday can have a theme with a name, color, morning description, afternoon description, and suggested chores:

```js
dayThemes: {
  1: { name:"Family Day", emoji:"👨‍👩‍👧‍👦", color:"#e8f5e9",
       morning:"Activity with a parent or fun family hangout",
       afternoon:"Lighter family time",
       chores:["be-kind-sibling","play-together-1hr"] },
  5: { name:"Chill & Community", emoji:"🎬", color:"#f3e5f5",
       morning:"🎥 Movie Day — pick the movie, make popcorn",
       afternoon:"Video games, free play",
       chores:["play-together-1hr","no-fighting-day"] },
}
```

The theme color tints the dashboard background. Chore IDs listed here are highlighted in the kid's chore panel.

### Daily blocks

The backbone of the day — time-stamped blocks from morning to end of day:

```js
dailyBlocks: [
  { id:"morning-kickoff", time:"9:30", emoji:"☀️", label:"Morning Kickoff",
    desc:"Gather up, talk about the plan", hour:9, min:30 },
  { id:"lunch", time:"12:00", emoji:"🍽️", label:"Lunch",
    desc:"Eat together", hour:12, min:0 },
  // ...
]
```

`hour` and `min` are used to determine the "current" block on the dashboard.

### Custom dates

Override the entire block schedule for a specific date — useful for appointment days, field trips, or special events:

```js
customDates: {
  "2026-06-15": [
    { id:"field-trip", time:"9:00", emoji:"🚌", label:"Field Trip",
      desc:"Leave for the museum", hour:9, min:0 },
    // ...
  ],
}
```

### Transition range

Apply a different block schedule across a date range — useful for a ramp-up or wind-down phase:

```js
transitionRange: {
  start: [2026, 5, 21],
  end:   [2026, 5, 31],
  blocks: [
    { id:"dad-works", time:"9:30", emoji:"💻", label:"Dad Works",
      desc:"Free-range until 11am", hour:9, min:30 },
    // ...
  ],
},
```

### Block status tracking

Parents mark each block as it happens:

| Status | Meaning |
|--------|---------|
| Unmarked | Default — not yet tracked |
| Not Done | Planned but didn't happen |
| In Progress | Currently happening |
| Done | Completed |

Done/In Progress/Not Done counts are shown in the TV dashboard's schedule metrics card. Completing blocks triggers dashboard announcements and confetti.

---

## TV Dashboard

The TV dashboard is a full-screen display designed for a living room screen. It can be launched two ways:

- **From the login screen** — tap **📺 TV Dashboard** before logging in. No session required; uses the public `/api/dashboard` endpoint (IP-restricted).
- **From the parent view** — tap **"Enable TV Dashboard"** after logging in as a parent.

In both cases the dashboard is read-only — no approvals, no edits, no token adjustments are possible from this view.

### Panels

**Hero block (top left, large)**
- Live clock and date
- Week context (e.g., "⚡ Transition · Reduced work hours — easing into summer")
- Current schedule block with theme-driven description
- Status of current block (Done / In Progress / Not Done / Unmarked)
- Motivational message (rotates every minute)
- Token scoreboard — both kids, tap to trigger celebration animation
- Pending count pill and suggested chores from today's theme

**Schedule summary card (top right)**
- ✅ Done, 🚀 Going, ❌ Missed, ⬜ Left block counts for the day

**Upcoming blocks panel (bottom left)**
- Next 4 schedule blocks with time and status color coding
- Day Wrap block shows a shortcut to write an affirmation

**Streak Watch panel (bottom center)**
- All kids × all streaks
- Fire emoji bars showing progress toward goal
- Goal badge if hit ("🏆 GOAL!"), progress fraction if not ("3/7")
- Clickable avatar triggers a comet animation across the screen

**Pending Approvals panel (bottom right)**
- Top 5 pending items waiting for parent approval

**Affirmation ticker (top, full width)**
- Rotating carousel of today's affirmations — who sent what to whom

### Live alerts

The dashboard announces changes in real time without refresh:

| Alert color | Triggered by |
|-------------|--------------|
| 🟢 Green | Chore approved, tokens earned, streak advanced |
| 🟡 Yellow | New pending item, block goes in-progress |
| 🟠 Orange | Block missed, refresh error |
| 🟣 Purple | Streak goal hit, new personal best |

Each alert optionally plays a sound (Web Audio API) and triggers confetti or other animations.

### Night mode

After 7pm the dashboard automatically switches to a darker color scheme. You can also cycle through **Day / Night / Auto** manually with the theme button in the dashboard header.

### Dashboard persistence

Dashboard mode persists in localStorage — it survives page refreshes and will re-enable automatically when you reload.

---

## Avatars

Every family member can upload a photo to use as their avatar.

### Uploading

1. Log in, open the **📸 Avatar** section.
2. Tap **Choose Photo** and select any image (PNG, JPEG, WebP, GIF — max 8MB).
3. The app crops it to a square, resizes to 180×180px, and saves it.
4. **Remove Photo** reverts to the default emoji.

Avatars appear on the login screen, in the kid/parent header, and in the TV dashboard scoreboard and streak watch panels.

### Defaults

If no avatar is uploaded, each role gets a default emoji:
- First parent role: 👨
- Second parent role: 👩
- Kid roles: 🧒, 👧, 👦, 🧒 (cycling)

---

## Token Bank

Parents can manually add or remove tokens from any kid's balance.

### How to use

1. Find **🏦 Token Bank** in the parent view.
2. Enter an amount in the input field (default: 10).
3. Tap **Deposit** to add tokens or **Take Out** to remove them.

Takes effect immediately and shows in the kid's header balance on next refresh. Balance never goes below zero.

This is useful for manual bonuses ("You helped a stranger — here's 25 tokens") or consequences ("That was unkind — losing 50 tokens").

---

## Easter Egg Challenges

Hidden eggs float randomly on screen. Kids who spot and click one get a timed challenge — the faster they finish, the bigger the token multiplier.

---

### How it works

1. **An egg appears** — a small, low-opacity 🥚 floats somewhere on the page. Easy to miss if you're not looking. Up to 3 eggs can be active at once.
2. **Kid clicks it** — a modal pops up showing the challenge title, base token reward, and time limit. A countdown shows how long before the egg disappears.
3. **Kid accepts** — enters their password to claim it. The challenge is now locked to that kid with the clock running.
4. **Kid completes it** — hits "I Did It!" when done. Goes to the parent's Pending Approvals queue.
5. **Parent approves** — sees the challenge, time used, computed multiplier, and final token amount. One tap to award.

### Token multiplier

The multiplier is based on what fraction of the time limit the kid used:

| Time used | Multiplier |
|-----------|-----------|
| ≤ 25% | 2.0x |
| ≤ 50% | 1.6x |
| ≤ 75% | 1.4x |
| ≤ 100% | 1.2x |
| Over time | 1.0x (base, no penalty) |

**Chore check:** If the kid hasn't had any chores approved today when the parent reviews, the multiplier is capped at 1.2x regardless of speed. Completing chores on the same day as an egg challenge unlocks the full multiplier range.

### Egg behavior

- Eggs appear on a variable schedule (30–90 minute randomized gaps) to keep kids checking the app frequently.
- Each egg has a **15-minute display window**. If not claimed before the window closes, it vanishes.
- A **60-second grace window** applies after the display window ends — a kid who finds the egg and starts typing their password won't lose it mid-entry.
- The same challenge can appear to both kids simultaneously. Each kid must claim and complete it independently.

### Challenge pool

Challenges come from a pool of approved ideas. Anyone can submit — kids or parents. Parent submissions auto-approve; kid submissions go through a one-tap approval queue in the parent view.

Each challenge has:
- **Title** — what to do (e.g., "Clean the garage")
- **Description** — optional context
- **Base tokens** — the reward before the multiplier
- **Time limit** — how many minutes the kid has once they accept

### TV Dashboard

Eggs appear on the TV Dashboard too. Clicking one shows a kid selector first (since no specific kid is logged in on the TV), then a password entry for the chosen kid.

### Parent controls

The **Challenge Admin** section in the parent view shows:
- Pool size and status (warns when low)
- Pending approval count and completion review count
- Last egg activation time
- **Activate Egg Now** — manually push an egg without waiting for the schedule
- **Enable / Disable Eggs** — kill switch to pause the system
- **Add a Challenge Idea** form — submit and auto-approve a new challenge
- Pending kid ideas to approve or reject

---

## Spend Notifications

The **🔔 Spend Notifications** panel in the parent view logs every reward purchase. Shows:
- Which kid redeemed it
- Which reward
- How many tokens it cost
- When it happened

The last 50 transactions are kept. There's no undo — spending is immediate and permanent.

---

## Configuration Reference

### wrangler.jsonc — environment variables

```jsonc
"vars": {
  "APP_NAME":     "Daddy Daycare",        // Header and page title
  "PARENT_ROLES": "[\"Dad\",\"Mom\"]",    // JSON array — who gets the parent view
  "KID_ROLES":    "[\"Child1\",\"Child2\"]", // JSON array — who gets the kid view
  "ALLOWED_IP":   ""                      // Optional: home IP for network lock
}
```

Changes to `vars` require a redeploy. Passwords are set by each family member on first launch — click your character, enter a password, and the app saves it (PBKDF2-hashed) in KV. No wrangler commands needed.

### schedule.config.js — all schedule and streak configuration

```js
window.SCHEDULE_CONFIG = {

  // Named weeks shown in dashboard header
  weekRanges: [
    { start:[YYYY,M,D], end:[YYYY,M,D], emoji:"🚀", label:"Week 1", note:"First week!" },
  ],

  // Day-of-week themes (1=Mon, 2=Tue, ..., 5=Fri — skip weekends or add them too)
  dayThemes: {
    1: { name:"Family Day", emoji:"👨‍👩‍👧‍👦", color:"#e8f5e9",
         morning:"...", afternoon:"...", chores:["chore-id"] },
  },

  // Default time blocks for any normal day
  dailyBlocks: [
    { id:"morning-kickoff", time:"9:30", emoji:"☀️", label:"Morning Kickoff",
      desc:"Gather up", hour:9, min:30 },
  ],

  // Override blocks for specific dates (takes highest priority)
  customDates: {
    "2026-06-15": [ /* full block list */ ],
  },

  // Override blocks for a date range (second priority after customDates)
  transitionRange: {
    start: [2026, 5, 21],
    end:   [2026, 5, 31],
    blocks: [ /* full block list */ ],
  },

  // Family-specific streaks beyond the core 3
  extraStreaks: {
    "pet-care": {
      label: "🐾 Pet Care Streak",
      goal: 7,                    // 0 = unlimited
      prompt: "Took care of the pet today",
      vacationHold: true,         // enables the Vacation Keep-Alive button
    },
  },
};
```

This file must be committed to your private fork so Cloudflare deploys it. Copy `schedule.config.example.js` to start.

### worker.js — hardcoded defaults

These only apply before KV is populated (first deploy). After first deploy, the admin panel controls chores and rewards.

```js
const DEFAULT_CHORES = [ ... ];    // Edit to change opening chore list
const DEFAULT_REWARDS = [ ... ];   // Edit to change opening rewards list
const CHORE_STREAK_MAP = { ... };  // Maps chore IDs to streak IDs they advance
```

---

## Storage Reference

All data lives in Cloudflare KV. Here's the full schema:

| KV Key | Type | Contents |
|--------|------|----------|
| `auth:{role}` | Object | `{hash, salt, iterations}` — PBKDF2 password record |
| `session:{token}` | Object | `{role, expires}` — 14-day session |
| `tokens:{role}` | String (number) | Token balance for a role |
| `chores` | Array | `[{id, label, amount}]` — all configured chores |
| `rewards` | Array | `[{id, label, cost}]` — all configured rewards |
| `pending` | Array | All unresolved submissions |
| `approved` | Array | Approved submission keys (historical) |
| `denied` | Array | Denied submission keys (historical) |
| `streaks` | Object | `{role: {streakId: {current, best, lastApprovedDay}}}` |
| `avatars` | Object | `{role: dataUrl}` — JPEG data URLs |
| `schedule_statuses` | Object | `{dayKey: {blockId: "done"\|"in-progress"\|"not-done"}}` |
| `affirmations` | Array | `[{id, from, to, text, dayKey, ts}]` — last 50 |
| `spend_notifications` | Array | `[{user, rewardName, cost, time}]` — last 50 |
