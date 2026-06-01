// Daddy Daycare Worker — API + static asset fallback.
// All state lives in DAYCARE_KV. Auth: PBKDF2-SHA-256 (100k iterations, 16-byte salt),
// session tokens are randomUUIDs stored under `session:{token}` with a 14-day KV TTL.

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = "SHA-256";
const PBKDF2_KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;
const SESSION_TTL_SECONDS = 1209600; // 14 days
const SPEND_NOTIFICATIONS_MAX = 50;
// Initialized from env at the start of each fetch() — see export default below.
let VALID_ROLES = new Set();
let PARENT_ROLES = new Set();
let KID_ROLES = new Set();
const MAX_CHORES = 20;
const MAX_REWARDS = 20;
const AFFIRMATION_POINTS = 3;

const DEFAULT_REWARDS = [
  { id: "screen-time-30",    label: "📱 30 Min Extra Screen Time", cost: 45  },
  { id: "pick-movie",        label: "🎬 Pick the Movie Tonight",   cost: 15  },
  { id: "choose-dinner",     label: "🍕 Choose Dinner One Night",  cost: 30  },
  { id: "snack-run",         label: "🍦 Small Treat / Snack Run",  cost: 45  },
  { id: "special-outing",    label: "🎉 Special Outing (Your Pick)", cost: 60 },
  { id: "stay-up-late",      label: "🌙 Stay Up 30 Min Later",     cost: 45  },
  { id: "solo-time-parent",  label: "💛 30 Min Alone With a Parent", cost: 45 },
];
const AFFIRMATIONS_MAX = 50;
const MAX_AFFIRMATIONS_PER_DAY = 3;

// When a chore is approved, auto-advance any mapped streak for that day.
// advanceStreak is idempotent per day — safe if the kid also logs the streak manually.
const CHORE_STREAK_MAP = {
  "morning-workout":      "workout",
  "be-kind-sibling":      "kindness",
  "encourage-sibling":    "kindness",
  "no-fighting-day":      "kindness",
  "help-sibling":         "helping",
  "play-together-1hr":    "helping",
  "project-together":     "helping",
  "teamwork-activity":    "helping",
};

const VALID_SCHEDULE_STATUSES = new Set(["not-done", "in-progress", "done"]);

const DEFAULT_CHORES = [
  // Sibling relationship & kindness
  { id: "be-kind-sibling",      label: "💛 Be Kind to Your Sibling",              amount: 60 },
  { id: "encourage-sibling",    label: "🙌 Encourage Your Sibling",              amount: 30 },
  { id: "help-sibling",         label: "🤝 Help Your Sibling With Something",    amount: 40 },
  { id: "play-together-1hr",    label: "✌️🤝 No Fighting — Play Together 1 Hour", amount: 30 },
  { id: "no-fighting-day",      label: "✌️ No Fighting — Whole Day",             amount: 40 },
  { id: "project-together",     label: "🎨 Work on a Project Together",          amount: 40 },
  { id: "teamwork-activity",    label: "🏅 Teamwork Activity Together",          amount: 30 },
  // Learning & growth
  { id: "morning-workout",      label: "💪 Morning Workout / Exercise",          amount: 30 },
  { id: "reading-30",           label: "📚 Reading (30 Minutes)",                amount: 60 },
  { id: "creative-project",     label: "🎭 Complete a Creative Project",         amount: 25 },
  // Family contributions
  { id: "help-cook",            label: "🍳 Help Cook a Meal",                    amount: 25 },
  { id: "chores-unprompted",    label: "⭐ Chores Without Being Asked",           amount: 15 },
  { id: "clean-house",          label: "🧽 Clean the House",                     amount: 50 },
  { id: "take-out-trash",       label: "🗑️ Take Out the Trash",                  amount: 10 },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// ALLOWED_IP is read from env.ALLOWED_IP — set it in wrangler.jsonc [vars] or leave blank to allow all IPs.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Derive role sets from env vars — new families set these in wrangler.jsonc [vars].
    const parentRoles = env.PARENT_ROLES ? JSON.parse(env.PARENT_ROLES) : ["Dad", "Mom"];
    const kidRoles = env.KID_ROLES ? JSON.parse(env.KID_ROLES) : ["Child 1", "Child 2"];
    VALID_ROLES = new Set([...parentRoles, ...kidRoles]);
    PARENT_ROLES = new Set(parentRoles);
    KID_ROLES = new Set(kidRoles);

    const allowedIp = env.ALLOWED_IP || "";
    const clientIp = request.headers.get("CF-Connecting-IP") || "";
    if (allowedIp && clientIp !== allowedIp) {
      return new Response("Access denied", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url);
      } catch (err) {
        console.error("API error:", err);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }

    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};

// ---------- Routing ----------

async function routeApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/config" && method === "GET") return handleGetConfig(env);
  if (path === "/api/avatars" && method === "GET") return handleGetAvatars(env);
  if (path === "/api/auth/check" && method === "POST") return handleAuthCheck(request, env);
  if (path === "/api/auth/setup" && method === "POST") return handleAuthSetup(request, env);
  if (path === "/api/auth/login" && method === "POST") return handleAuthLogin(request, env);

  if (path === "/api/dashboard" && method === "GET") return handleGetDashboard(request, env);
  if (path === "/api/state" && method === "GET") return withSession(request, env, handleGetState);
  if (path === "/api/avatar" && method === "POST") return withSession(request, env, handleSetAvatar);
  if (path === "/api/chores" && method === "POST") return withSession(request, env, handleSetChores);
  if (path === "/api/schedule-status" && method === "POST") return withSession(request, env, handleSetScheduleStatus);
  if (path === "/api/submit" && method === "POST") return withSession(request, env, handleSubmit);
  if (path === "/api/approve" && method === "POST") return withSession(request, env, handleApprove);
  if (path === "/api/deny" && method === "POST") return withSession(request, env, handleDeny);
  if (path === "/api/spend" && method === "POST") return withSession(request, env, handleSpend);
  if (path === "/api/tokens/adjust" && method === "POST") return withSession(request, env, handleTokenAdjust);
  if (path === "/api/affirmation" && method === "POST") return withSession(request, env, handleAffirmation);
  if (path === "/api/rewards" && method === "POST") return withSession(request, env, handleSetRewards);

  // ── Easter Egg Challenge routes ──────────────────────────────────────────
  if (path === "/api/egg-challenges/submit"  && method === "POST") return withSession(request, env, handleEggChallengeSubmit);
  if (path === "/api/egg-challenges/approve" && method === "POST") return withSession(request, env, handleEggChallengeApprove);
  if (path === "/api/egg-challenges/reject"  && method === "POST") return withSession(request, env, handleEggChallengeReject);
  if (path === "/api/egg-challenges/complete"&& method === "POST") return withSession(request, env, handleEggChallengeComplete);
  if (path === "/api/egg-challenges/verify"  && method === "POST") return withSession(request, env, handleEggChallengeVerify);
  if (path === "/api/eggs/accept"            && method === "POST") return withSession(request, env, handleEggAccept);
  if (path === "/api/eggs/activate"          && method === "POST") return withSession(request, env, handleEggActivate);
  if (path === "/api/eggs/toggle"            && method === "POST") return withSession(request, env, handleEggToggle);

  return jsonResponse({ error: "not_found" }, 404);
}

// ---------- Config handler ----------

function handleGetConfig(env) {
  const parentRoles = env.PARENT_ROLES ? JSON.parse(env.PARENT_ROLES) : ["Dad", "Mom"];
  const kidRoles = env.KID_ROLES ? JSON.parse(env.KID_ROLES) : ["Child 1", "Child 2"];
  return jsonResponse({
    appName: env.APP_NAME || "Daddy Daycare",
    parentRoles,
    kidRoles,
    allRoles: [...parentRoles, ...kidRoles],
  });
}

// ---------- Auth handlers ----------

async function handleGetAvatars(env) {
  const avatars = await readJsonKey(env, "avatars", {});
  return jsonResponse({ avatars: sanitizeAvatars(avatars) });
}

async function handleAuthCheck(request, env) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const role = body.role;
  if (!isValidRole(role)) return jsonResponse({ error: "invalid_role" }, 400);

  const stored = await env.DAYCARE_KV.get(authKey(role));
  return jsonResponse({ exists: stored !== null });
}

async function handleAuthSetup(request, env) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const role = body.role;
  const password = body.password;
  if (!isValidRole(role)) return jsonResponse({ error: "invalid_role" }, 400);
  if (typeof password !== "string" || password.length === 0) {
    return jsonResponse({ error: "invalid_password" }, 400);
  }

  const existing = await env.DAYCARE_KV.get(authKey(role));
  if (existing !== null) return jsonResponse({ error: "already_set" }, 409);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashBytes = await derivePbkdf2(password, salt);
  const record = {
    hash: bytesToBase64(hashBytes),
    salt: bytesToBase64(salt),
    iterations: PBKDF2_ITERATIONS,
  };
  await env.DAYCARE_KV.put(authKey(role), JSON.stringify(record));

  return jsonResponse({ ok: true });
}

async function handleAuthLogin(request, env) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const role = body.role;
  const password = body.password;
  if (!isValidRole(role)) return jsonResponse({ error: "invalid_role" }, 400);
  if (typeof password !== "string" || password.length === 0) {
    return jsonResponse({ error: "invalid_password" }, 400);
  }

  const raw = await env.DAYCARE_KV.get(authKey(role));
  if (raw === null) return jsonResponse({ error: "not_set" }, 401);

  const record = safeParseJson(raw);
  if (!record || typeof record.hash !== "string" || typeof record.salt !== "string" || typeof record.iterations !== "number") {
    return jsonResponse({ error: "corrupt_auth_record" }, 500);
  }

  const salt = base64ToBytes(record.salt);
  const computed = await derivePbkdf2(password, salt, record.iterations);
  const computedB64 = bytesToBase64(computed);
  if (!constantTimeEqual(computedB64, record.hash)) {
    return jsonResponse({ error: "invalid_credentials" }, 401);
  }

  const token = crypto.randomUUID();
  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.DAYCARE_KV.put(
    sessionKey(token),
    JSON.stringify({ role, expires }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );

  return jsonResponse({ token, role, expires });
}

// ---------- Session-gated handlers ----------

async function handleGetDashboard(request, env) {
  const now = Date.now();
  const [streaks, affirmations, scheduleStatuses, pending, avatars, chores, rawEggs] = await Promise.all([
    readJsonKey(env, "streaks", {}),
    readJsonKey(env, "affirmations", []),
    readScheduleStatuses(env),
    readJsonKey(env, "pending", []),
    readJsonKey(env, "avatars", {}),
    readChores(env),
    readJsonKey(env, "active_eggs", []),
  ]);
  const tokenEntries = await Promise.all(
    [...KID_ROLES].map(async r => [r, await readNumber(env, tokensKey(r))])
  );
  const tokens = Object.fromEntries(tokenEntries);
  const twentyFourHoursAgo = now - 86400000;

  // Expire stale eggs (same logic as handleGetState, write-back if changed)
  const activeEggs = rawEggs.filter(e => e.display_end >= now);
  if (activeEggs.length !== rawEggs.length) {
    await env.DAYCARE_KV.put("active_eggs", JSON.stringify(activeEggs));
  }

  return jsonResponse({
    tokens,
    streaks,
    affirmations: affirmations.filter(a => a.ts > twentyFourHoursAgo),
    scheduleStatuses,
    pendingCount: pending.length,
    avatars: sanitizeAvatars(avatars),
    chores,
    active_eggs: activeEggs,
  });
}

async function handleGetState(request, env, session) {
  const kidRoles = [...KID_ROLES];
  const now = Date.now();

  // ── Egg: auto-expire stale active_eggs ──────────────────────────────────
  let activeEggs = await readJsonKey(env, "active_eggs", []);
  const beforeCount = activeEggs.length;
  activeEggs = activeEggs.filter(e => e.display_end >= now);
  if (activeEggs.length !== beforeCount) {
    await env.DAYCARE_KV.put("active_eggs", JSON.stringify(activeEggs));
  }

  // ── Egg: auto-activate if schedule says it's time ────────────────────────
  const eggSchedule = await readJsonKey(env, "egg_schedule", {});
  if (eggSchedule.enabled !== false && activeEggs.length < 3) {
    const nextActivation = eggSchedule.next_activation || 0;
    if (now >= nextActivation) {
      const eggChallenges = await readJsonKey(env, "egg_challenges", []);
      const approved = eggChallenges.filter(c => c.approved);
      if (approved.length > 0) {
        const chosen = approved[Math.floor(Math.random() * approved.length)];
        const newEgg = {
          id: crypto.randomUUID(),
          challenge_id: chosen.id,
          display_start: now,
          display_end: now + 15 * 60 * 1000,
          challenge_title: chosen.title,
          challenge_description: chosen.description || "",
          token_reward: chosen.token_reward,
          time_limit_minutes: chosen.time_limit_minutes,
        };
        activeEggs.push(newEgg);
        const cooldownMs = (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
        eggSchedule.last_activated = now;
        eggSchedule.next_activation = now + cooldownMs;
        await Promise.all([
          env.DAYCARE_KV.put("active_eggs", JSON.stringify(activeEggs)),
          env.DAYCARE_KV.put("egg_schedule", JSON.stringify(eggSchedule)),
        ]);
      }
    }
  }

  const [
    tokenValues,
    pending,
    approvedKeys,
    denied,
    streaks,
    spendNotifications,
    chores,
    scheduleStatuses,
    affirmations,
    rewards,
    eggAcceptsRaw,
    eggChallengesRaw,
  ] = await Promise.all([
    Promise.all(kidRoles.map(r => readNumber(env, tokensKey(r)))),
    readJsonKey(env, "pending", []),
    readJsonKey(env, "approved", []),
    readJsonKey(env, "denied", []),
    readJsonKey(env, "streaks", {}),
    readJsonKey(env, "spend_notifications", []),
    readChores(env),
    readScheduleStatuses(env),
    readJsonKey(env, "affirmations", []),
    readRewards(env),
    readJsonKey(env, "egg_accepts", []),
    readJsonKey(env, "egg_challenges", []),
  ]);

  const tokens = Object.fromEntries(kidRoles.map((r, i) => [r, tokenValues[i]]));
  const twentyFourHoursAgo = now - 86400000;
  const recentAffirmations = affirmations.filter(a => a.ts > twentyFourHoursAgo);

  // ── Egg: filter accepts by role ──────────────────────────────────────────
  const isParent = isParentRole(session.role);
  const eggAccepts = isParent
    ? eggAcceptsRaw
    : eggAcceptsRaw.filter(a => a.kid_role === session.role);

  const poolSize = eggChallengesRaw.filter(c => c.approved).length;
  const pendingApproval = eggChallengesRaw.filter(c => !c.approved).length;
  const pendingCompletion = eggAcceptsRaw.filter(a => a.completed_at && !a.approved).length;

  return jsonResponse({
    role: session.role,
    tokens,
    pending,
    approved: approvedKeys,
    denied,
    streaks,
    chores,
    scheduleStatuses,
    spendNotifications,
    affirmations: recentAffirmations,
    rewards,
    active_eggs: activeEggs,
    egg_accepts: eggAccepts,
    egg_challenges_meta: {
      pool_size: poolSize,
      pending_approval: pendingApproval,
      pending_completion: pendingCompletion,
      last_activated: eggSchedule.last_activated || null,
      enabled: eggSchedule.enabled !== false,
    },
    ...(isParent ? {
      egg_challenges_pending: eggChallengesRaw.filter(c => !c.approved),
      egg_challenges_approved: eggChallengesRaw.filter(c => c.approved),
    } : {}),
  });
}

async function handleSetAvatar(request, env, session) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const avatarDataUrl = body.avatarDataUrl;
  if (avatarDataUrl !== null && !isValidAvatarDataUrl(avatarDataUrl)) {
    return jsonResponse({ error: "invalid_avatar" }, 400);
  }

  const avatars = sanitizeAvatars(await readJsonKey(env, "avatars", {}));
  if (avatarDataUrl === null) {
    delete avatars[session.role];
  } else {
    avatars[session.role] = avatarDataUrl;
  }

  await env.DAYCARE_KV.put("avatars", JSON.stringify(avatars));
  return jsonResponse({ ok: true, avatars });
}

async function handleSetChores(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const chores = sanitizeChoreList(body.chores);
  if (!chores) return jsonResponse({ error: "invalid_chores" }, 400);

  await env.DAYCARE_KV.put("chores", JSON.stringify(chores));
  return jsonResponse({ ok: true, chores });
}

async function handleSetScheduleStatus(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const dayKey = body.dayKey;
  const blockId = body.blockId;
  const status = body.status;

  if (!isValidDayKey(dayKey)) return jsonResponse({ error: "invalid_day_key" }, 400);
  if (!isValidScheduleBlockId(blockId)) return jsonResponse({ error: "invalid_block_id" }, 400);
  if (!VALID_SCHEDULE_STATUSES.has(status)) return jsonResponse({ error: "invalid_status" }, 400);

  const scheduleStatuses = await readScheduleStatuses(env);
  if (!scheduleStatuses[dayKey]) {
    scheduleStatuses[dayKey] = {};
  }
  scheduleStatuses[dayKey][blockId] = status;

  await env.DAYCARE_KV.put("schedule_statuses", JSON.stringify(scheduleStatuses));
  return jsonResponse({ ok: true, scheduleStatuses });
}

async function handleSubmit(request, env, session) {
  if (!KID_ROLES.has(session.role)) {
    return jsonResponse({ error: "kids_only" }, 403);
  }

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const item = body.item || body;
  const normalizedItem = await normalizePendingItem(env, item);
  if (!normalizedItem || !isValidPendingItem(normalizedItem)) {
    return jsonResponse({ error: "invalid_item" }, 400);
  }
  if (normalizedItem.user !== session.role) return jsonResponse({ error: "user_role_mismatch" }, 403);

  const pending = await readJsonKey(env, "pending", []);
  if (pending.some(existing => existing && existing.key === normalizedItem.key)) {
    return jsonResponse({ ok: true, deduped: true, pending });
  }

  pending.push(normalizedItem);
  await env.DAYCARE_KV.put("pending", JSON.stringify(pending));

  return jsonResponse({ ok: true, pending });
}

async function handleApprove(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const key = body.key;
  if (typeof key !== "string" || key.length === 0) {
    return jsonResponse({ error: "invalid_key" }, 400);
  }

  const pending = await readJsonKey(env, "pending", []);
  const target = pending.find(item => item && item.key === key);
  if (!target) return jsonResponse({ error: "pending_not_found" }, 404);

  const remainingPending = pending.filter(item => !item || item.key !== key);

  if (target.type === "chore") {
    const amount = target.isAdHoc ? Number(body.amount) : Number(target.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
      return jsonResponse({ error: "invalid_chore_amount" }, 400);
    }
    if (!KID_ROLES.has(target.user)) {
      return jsonResponse({ error: "invalid_chore_user" }, 400);
    }

    const approved = await readJsonKey(env, "approved", []);
    if (!approved.includes(key)) approved.push(key);

    const currentBalance = await readNumber(env, tokensKey(target.user));
    const approvedAmount = Math.trunc(amount);
    const nextBalance = currentBalance + approvedAmount;

    const writes = [
      env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending)),
      env.DAYCARE_KV.put("approved", JSON.stringify(approved)),
      env.DAYCARE_KV.put(tokensKey(target.user), String(nextBalance)),
    ];

    const mappedStreak = CHORE_STREAK_MAP[target.id];
    let streakRecord = null;
    if (mappedStreak) {
      const dayKey = target.dayKey || getTodayKeyUtc();
      const streaks = await readJsonKey(env, "streaks", {});
      streakRecord = advanceStreak(streaks, target.user, mappedStreak, dayKey);
      writes.push(env.DAYCARE_KV.put("streaks", JSON.stringify(streaks)));
    }

    await Promise.all(writes);

    return jsonResponse({
      ok: true,
      type: "chore",
      user: target.user,
      balance: nextBalance,
      amount: approvedAmount,
      ...(streakRecord && { streakAdvanced: mappedStreak, streakRecord }),
    });
  }

  if (target.type === "streak") {
    if (!KID_ROLES.has(target.user)) {
      return jsonResponse({ error: "invalid_streak_user" }, 400);
    }
    if (typeof target.id !== "string" || typeof target.dayKey !== "string") {
      return jsonResponse({ error: "invalid_streak_payload" }, 400);
    }

    const streaks = await readJsonKey(env, "streaks", {});
    const nextRecord = target.mode === "vacation-hold"
      ? pauseStreak(streaks, target.user, target.id, target.dayKey)
      : advanceStreak(streaks, target.user, target.id, target.dayKey);

    await Promise.all([
      env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending)),
      env.DAYCARE_KV.put("streaks", JSON.stringify(streaks)),
    ]);

    return jsonResponse({
      ok: true,
      type: "streak",
      user: target.user,
      streakId: target.id,
      record: nextRecord,
    });
  }

  return jsonResponse({ error: "unknown_item_type" }, 400);
}

async function handleDeny(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const key = body.key;
  if (typeof key !== "string" || key.length === 0) {
    return jsonResponse({ error: "invalid_key" }, 400);
  }

  const pending = await readJsonKey(env, "pending", []);
  const target = pending.find(item => item && item.key === key);
  if (!target) return jsonResponse({ error: "pending_not_found" }, 404);

  const remainingPending = pending.filter(item => !item || item.key !== key);

  if (target.type === "chore") {
    const denied = await readJsonKey(env, "denied", []);
    if (!denied.includes(key)) denied.push(key);
    await Promise.all([
      env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending)),
      env.DAYCARE_KV.put("denied", JSON.stringify(denied)),
    ]);
    return jsonResponse({ ok: true, type: "chore", denied: true });
  }

  // Streak denials drop from pending without recording a denial key —
  // matches existing app.js denyPending behavior for type === "streak".
  await env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending));
  return jsonResponse({ ok: true, type: target.type || "unknown", denied: true });
}

async function handleSpend(request, env, session) {
  if (!KID_ROLES.has(session.role)) {
    return jsonResponse({ error: "kids_only" }, 403);
  }

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const rewardId = typeof body.rewardId === "string" ? body.rewardId.trim().toLowerCase() : "";
  if (!rewardId) return jsonResponse({ error: "invalid_reward_id" }, 400);

  const rewards = await readRewards(env);
  const reward = rewards.find(item => item.id === rewardId);
  if (!reward) return jsonResponse({ error: "reward_not_found" }, 400);

  const cost = reward.cost;
  const rewardName = reward.label;

  const balance = await readNumber(env, tokensKey(session.role));
  if (balance < cost) {
    return jsonResponse({ error: "insufficient_balance", balance, cost }, 400);
  }

  const nextBalance = balance - cost;
  const notifications = await readJsonKey(env, "spend_notifications", []);
  notifications.unshift({
    user: session.role,
    rewardName,
    cost,
    time: Date.now(),
  });
  const trimmed = notifications.slice(0, SPEND_NOTIFICATIONS_MAX);

  await Promise.all([
    env.DAYCARE_KV.put(tokensKey(session.role), String(nextBalance)),
    env.DAYCARE_KV.put("spend_notifications", JSON.stringify(trimmed)),
  ]);

  return jsonResponse({ ok: true, balance: nextBalance, reward });
}

async function handleTokenAdjust(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const user = body.user;
  const amount = Number(body.amount);
  const direction = Number(body.direction);
  if (!KID_ROLES.has(user)) return jsonResponse({ error: "invalid_user" }, 400);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    return jsonResponse({ error: "invalid_amount" }, 400);
  }
  if (direction !== 1 && direction !== -1) {
    return jsonResponse({ error: "invalid_direction" }, 400);
  }

  const current = await readNumber(env, tokensKey(user));
  const next = direction === 1 ? current + amount : Math.max(0, current - amount);
  await env.DAYCARE_KV.put(tokensKey(user), String(next));

  return jsonResponse({ ok: true, user, balance: next });
}

async function handleAffirmation(request, env, session) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const toRole = body.toRole;
  if (!text) return jsonResponse({ error: "text_required" }, 400);
  if (!VALID_ROLES.has(toRole)) return jsonResponse({ error: "invalid_to_role" }, 400);

  const todayKey = getTodayKeyUtc();
  const affirmations = await readJsonKey(env, "affirmations", []);

  const todayByWriter = affirmations.filter(a => a.from === session.role && a.dayKey === todayKey).length;

  const entry = {
    id: crypto.randomUUID(),
    from: session.role,
    to: toRole,
    text,
    dayKey: todayKey,
    ts: Date.now(),
  };

  const updated = [entry, ...affirmations].slice(0, AFFIRMATIONS_MAX);
  await env.DAYCARE_KV.put("affirmations", JSON.stringify(updated));

  // Unlimited submissions, but only credit tokens for the first N per day.
  if (KID_ROLES.has(session.role) && todayByWriter < MAX_AFFIRMATIONS_PER_DAY) {
    const current = await readNumber(env, tokensKey(session.role));
    await env.DAYCARE_KV.put(tokensKey(session.role), String(current + AFFIRMATION_POINTS));
  }

  return jsonResponse({ ok: true, affirmation: entry });
}

// ---------- Easter Egg Challenge handlers ----------

async function handleEggChallengeSubmit(request, env, session) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 300) : "";
  const tokenReward = Number(body.token_reward);
  const timeLimitMinutes = Number(body.time_limit_minutes);
  const repeatable = body.repeatable !== false;

  if (!title) return jsonResponse({ error: "title_required" }, 400);
  if (!Number.isInteger(tokenReward) || tokenReward <= 0) return jsonResponse({ error: "invalid_token_reward" }, 400);
  if (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes < 5) return jsonResponse({ error: "invalid_time_limit" }, 400);

  const challenges = await readJsonKey(env, "egg_challenges", []);
  const newChallenge = {
    id: crypto.randomUUID(),
    title: title.slice(0, 80),
    description,
    created_by: session.role,
    approved: isParentRole(session.role),
    token_reward: tokenReward,
    time_limit_minutes: timeLimitMinutes,
    repeatable,
    created_at: Date.now(),
  };
  challenges.push(newChallenge);
  await env.DAYCARE_KV.put("egg_challenges", JSON.stringify(challenges));
  return jsonResponse({ success: true, id: newChallenge.id });
}

async function handleEggChallengeApprove(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.id !== "string") return jsonResponse({ error: "invalid_id" }, 400);

  const challenges = await readJsonKey(env, "egg_challenges", []);
  const idx = challenges.findIndex(c => c.id === body.id);
  if (idx === -1) return jsonResponse({ error: "not_found" }, 404);
  challenges[idx].approved = true;
  await env.DAYCARE_KV.put("egg_challenges", JSON.stringify(challenges));
  return jsonResponse({ success: true });
}

async function handleEggChallengeReject(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.id !== "string") return jsonResponse({ error: "invalid_id" }, 400);

  const challenges = await readJsonKey(env, "egg_challenges", []);
  const filtered = challenges.filter(c => c.id !== body.id);
  await env.DAYCARE_KV.put("egg_challenges", JSON.stringify(filtered));
  return jsonResponse({ success: true });
}

async function handleEggAccept(request, env, session) {
  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const challengeId = typeof body.challenge_id === "string" ? body.challenge_id : "";
  const kidRole = typeof body.kid_role === "string" ? body.kid_role : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!challengeId || !kidRole || !password) return jsonResponse({ error: "missing_fields" }, 400);
  if (!KID_ROLES.has(kidRole)) return jsonResponse({ error: "invalid_kid_role" }, 400);

  // Re-verify kid's password
  const authRaw = await env.DAYCARE_KV.get(authKey(kidRole));
  if (!authRaw) return jsonResponse({ error: "no_auth_for_kid" }, 400);
  const authRecord = safeParseJson(authRaw);
  if (!authRecord) return jsonResponse({ error: "corrupt_auth" }, 500);
  const salt = base64ToBytes(authRecord.salt);
  const computed = await derivePbkdf2(password, salt, authRecord.iterations);
  if (!constantTimeEqual(bytesToBase64(computed), authRecord.hash)) {
    return jsonResponse({ error: "wrong_password" }, 401);
  }

  // Validate active egg
  const now = Date.now();
  const activeEggs = await readJsonKey(env, "active_eggs", []);
  const egg = activeEggs.find(e => e.challenge_id === challengeId);
  if (!egg) return jsonResponse({ error: "egg_not_found" }, 404);
  if (now > egg.display_end + 60000) return jsonResponse({ error: "egg_expired" }, 400);

  // Dedup check
  const eggAccepts = await readJsonKey(env, "egg_accepts", []);
  const existing = eggAccepts.find(a => a.challenge_id === challengeId && a.kid_role === kidRole && !a.completed_at);
  if (existing) return jsonResponse({ error: "already_accepted" }, 409);

  const newAccept = {
    id: crypto.randomUUID(),
    challenge_id: challengeId,
    challenge_title: egg.challenge_title,
    kid_role: kidRole,
    accepted_at: now,
    expires_at: egg.display_end + 60000,
    time_limit_minutes: egg.time_limit_minutes,
    token_reward: egg.token_reward,
    completed_at: null,
    approved: false,
    tokens_awarded: 0,
  };
  eggAccepts.push(newAccept);
  await env.DAYCARE_KV.put("egg_accepts", JSON.stringify(eggAccepts));
  return jsonResponse({ success: true, challenge_title: egg.challenge_title, token_reward: egg.token_reward, time_limit_minutes: egg.time_limit_minutes });
}

async function handleEggActivate(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const now = Date.now();
  const [activeEggs, eggChallenges, eggSchedule] = await Promise.all([
    readJsonKey(env, "active_eggs", []),
    readJsonKey(env, "egg_challenges", []),
    readJsonKey(env, "egg_schedule", {}),
  ]);

  if (eggSchedule.enabled === false) return jsonResponse({ error: "eggs_disabled" }, 400);
  const current = activeEggs.filter(e => e.display_end >= now);
  if (current.length >= 3) return jsonResponse({ error: "max_eggs_active" }, 400);

  const pool = eggChallenges.filter(c => c.approved);
  if (!pool.length) return jsonResponse({ error: "no_approved_challenges" }, 400);

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const newEgg = {
    id: crypto.randomUUID(),
    challenge_id: chosen.id,
    display_start: now,
    display_end: now + 15 * 60 * 1000,
    challenge_title: chosen.title,
    challenge_description: chosen.description || "",
    token_reward: chosen.token_reward,
    time_limit_minutes: chosen.time_limit_minutes,
  };
  current.push(newEgg);

  const cooldownMs = (30 + Math.floor(Math.random() * 60)) * 60 * 1000;
  eggSchedule.last_activated = now;
  eggSchedule.next_activation = now + cooldownMs;

  await Promise.all([
    env.DAYCARE_KV.put("active_eggs", JSON.stringify(current)),
    env.DAYCARE_KV.put("egg_schedule", JSON.stringify(eggSchedule)),
  ]);
  return jsonResponse({ success: true });
}

async function handleEggToggle(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.enabled !== "boolean") return jsonResponse({ error: "invalid_body" }, 400);

  const eggSchedule = await readJsonKey(env, "egg_schedule", {});
  eggSchedule.enabled = body.enabled;
  await env.DAYCARE_KV.put("egg_schedule", JSON.stringify(eggSchedule));
  return jsonResponse({ success: true });
}

async function handleEggChallengeComplete(request, env, session) {
  if (isParentRole(session.role)) return jsonResponse({ error: "kids_only" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.accept_id !== "string") return jsonResponse({ error: "invalid_accept_id" }, 400);

  const now = Date.now();
  const eggAccepts = await readJsonKey(env, "egg_accepts", []);
  const idx = eggAccepts.findIndex(a => a.id === body.accept_id);
  if (idx === -1) return jsonResponse({ error: "accept_not_found" }, 404);

  const accept = eggAccepts[idx];
  if (accept.kid_role !== session.role) return jsonResponse({ error: "not_your_challenge" }, 403);
  if (accept.completed_at !== null) return jsonResponse({ error: "already_completed" }, 409);
  if (now > accept.expires_at) return jsonResponse({ error: "window_expired" }, 400);

  accept.completed_at = now;
  eggAccepts[idx] = accept;

  const pending = await readJsonKey(env, "pending", []);
  const pendingKey = `egg-complete-${accept.id}`;
  if (!pending.some(p => p.key === pendingKey)) {
    pending.push({
      key: pendingKey,
      type: "egg_challenge",
      accept_id: accept.id,
      kid_role: session.role,
      challenge_id: accept.challenge_id,
      challenge_title: accept.challenge_title,
      token_reward: accept.token_reward,
      time_limit_minutes: accept.time_limit_minutes,
      accepted_at: accept.accepted_at,
      completed_at: now,
      ts: now,
    });
  }

  await Promise.all([
    env.DAYCARE_KV.put("egg_accepts", JSON.stringify(eggAccepts)),
    env.DAYCARE_KV.put("pending", JSON.stringify(pending)),
  ]);
  return jsonResponse({ success: true });
}

async function handleEggChallengeVerify(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.accept_id !== "string" || !["approve", "deny"].includes(body.action)) {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const eggAccepts = await readJsonKey(env, "egg_accepts", []);
  const pending = await readJsonKey(env, "pending", []);
  const pendingKey = `egg-complete-${body.accept_id}`;
  const acceptIdx = eggAccepts.findIndex(a => a.id === body.accept_id);
  if (acceptIdx === -1) return jsonResponse({ error: "accept_not_found" }, 404);

  const accept = eggAccepts[acceptIdx];
  const remainingPending = pending.filter(p => p.key !== pendingKey);

  if (body.action === "deny") {
    await env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending));
    return jsonResponse({ success: true });
  }

  // Compute multiplier
  const timeUsedMinutes = (accept.completed_at - accept.accepted_at) / 60000;
  const pct = timeUsedMinutes / accept.time_limit_minutes;
  let multiplier = pct <= 0.25 ? 2.0 : pct <= 0.50 ? 1.6 : pct <= 0.75 ? 1.4 : pct <= 1.00 ? 1.2 : 1.0;

  // Option A: cap at 1.2 if kid hasn't completed any chores today
  const todayKey = getTodayKeyUtc();
  const approvedKeys = await readJsonKey(env, "approved", []);
  const chores = await readChores(env);
  const kidChoresDoneToday = chores.some(ch => approvedKeys.includes(`${accept.kid_role}:${ch.id}:${todayKey}`));
  if (!kidChoresDoneToday) multiplier = Math.min(multiplier, 1.2);

  const tokens = Math.round(accept.token_reward * multiplier);
  const currentBalance = await readNumber(env, tokensKey(accept.kid_role));
  accept.approved = true;
  accept.tokens_awarded = tokens;
  eggAccepts[acceptIdx] = accept;

  await Promise.all([
    env.DAYCARE_KV.put("egg_accepts", JSON.stringify(eggAccepts)),
    env.DAYCARE_KV.put("pending", JSON.stringify(remainingPending)),
    env.DAYCARE_KV.put(tokensKey(accept.kid_role), String(currentBalance + tokens)),
  ]);
  return jsonResponse({ success: true, tokens_awarded: tokens, multiplier });
}

// ---------- Session middleware ----------

async function withSession(request, env, handler) {
  const session = await loadSession(request, env);
  if (!session) return jsonResponse({ error: "unauthorized" }, 401);
  return handler(request, env, session);
}

async function loadSession(request, env) {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) return null;

  const raw = await env.DAYCARE_KV.get(sessionKey(token));
  if (raw === null) return null;

  const parsed = safeParseJson(raw);
  if (!parsed || !isValidRole(parsed.role) || typeof parsed.expires !== "number") {
    return null;
  }
  if (parsed.expires <= Date.now()) return null;

  return parsed;
}

// ---------- Streak logic (mirrors app.js advanceStreak) ----------

function advanceStreak(streaks, user, streakId, approvedDay) {
  const userStreaks = streaks[user] || {};
  const existing = userStreaks[streakId] || {};
  const record = {
    current: typeof existing.current === "number" ? existing.current : 0,
    best: typeof existing.best === "number" ? existing.best : 0,
    lastApprovedDay: typeof existing.lastApprovedDay === "string" ? existing.lastApprovedDay : null,
  };

  if (record.lastApprovedDay === approvedDay) {
    // Already approved for that day — no-op, return current record without re-writing.
    streaks[user] = userStreaks;
    userStreaks[streakId] = record;
    return record;
  }

  const expectedPreviousDay = shiftDayKey(approvedDay, -1);
  const nextCurrent = record.lastApprovedDay === expectedPreviousDay ? record.current + 1 : 1;
  const nextRecord = {
    current: nextCurrent,
    best: Math.max(record.best, nextCurrent),
    lastApprovedDay: approvedDay,
  };

  userStreaks[streakId] = nextRecord;
  streaks[user] = userStreaks;
  return nextRecord;
}

function pauseStreak(streaks, user, streakId, approvedDay) {
  const userStreaks = streaks[user] || {};
  const existing = userStreaks[streakId] || {};
  const record = {
    current: typeof existing.current === "number" ? existing.current : 0,
    best: typeof existing.best === "number" ? existing.best : 0,
    lastApprovedDay: typeof existing.lastApprovedDay === "string" ? existing.lastApprovedDay : null,
  };

  if (record.lastApprovedDay === approvedDay) {
    streaks[user] = userStreaks;
    userStreaks[streakId] = record;
    return record;
  }

  const nextRecord = {
    current: record.current,
    best: record.best,
    lastApprovedDay: approvedDay,
  };

  userStreaks[streakId] = nextRecord;
  streaks[user] = userStreaks;
  return nextRecord;
}

function getTodayKeyUtc() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function shiftDayKey(dayKey, amount) {
  const parts = dayKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) {
    // Bad dayKey — fall back to a value that will never match record.lastApprovedDay,
    // forcing streak reset rather than corrupting state.
    return "__invalid__";
  }
  const [year, month, day] = parts;
  const shifted = new Date(year, month - 1, day + amount);
  const shiftedYear = shifted.getFullYear();
  const shiftedMonth = String(shifted.getMonth() + 1).padStart(2, "0");
  const shiftedDay = String(shifted.getDate()).padStart(2, "0");
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`;
}

// ---------- Crypto helpers ----------

async function derivePbkdf2(password, salt, iterations = PBKDF2_ITERATIONS) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: PBKDF2_HASH,
    },
    baseKey,
    PBKDF2_KEY_LENGTH_BITS,
  );
  return new Uint8Array(derived);
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ---------- KV / response helpers ----------

function authKey(role) {
  return `auth:${role}`;
}

function tokensKey(user) {
  return `tokens:${user}`;
}

function sessionKey(token) {
  return `session:${token}`;
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJsonKey(env, key, fallback) {
  const raw = await env.DAYCARE_KV.get(key);
  if (raw === null) return fallback;
  const parsed = safeParseJson(raw);
  return parsed === null ? fallback : parsed;
}

async function readNumber(env, key) {
  const raw = await env.DAYCARE_KV.get(key);
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

async function readChores(env) {
  const stored = await readJsonKey(env, "chores", null);
  return sanitizeChoreList(stored) || DEFAULT_CHORES;
}

async function readRewards(env) {
  const stored = await readJsonKey(env, "rewards", null);
  return sanitizeRewardList(stored) || DEFAULT_REWARDS;
}

async function handleSetRewards(request, env, session) {
  if (!isParentRole(session.role)) return jsonResponse({ error: "dad_only" }, 403);

  const body = await readJson(request);
  if (!body) return jsonResponse({ error: "invalid_json" }, 400);

  const rewards = sanitizeRewardList(body.rewards);
  if (!rewards) return jsonResponse({ error: "invalid_rewards" }, 400);

  await env.DAYCARE_KV.put("rewards", JSON.stringify(rewards));
  return jsonResponse({ ok: true, rewards });
}

function sanitizeRewardList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REWARDS) return null;

  const seen = new Set();
  const rewards = [];

  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const id = typeof item.id === "string" ? item.id.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const cost = Number(item.cost);
    if (!id || !label || !Number.isInteger(cost) || cost <= 0 || cost > 100000) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    rewards.push({ id, label, cost });
  }

  return rewards;
}

async function readScheduleStatuses(env) {
  const stored = await readJsonKey(env, "schedule_statuses", {});
  return sanitizeScheduleStatuses(stored);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function isValidRole(role) {
  return typeof role === "string" && VALID_ROLES.has(role);
}

function isParentRole(role) {
  return typeof role === "string" && PARENT_ROLES.has(role);
}

function isValidPendingItem(item) {
  if (!item || typeof item !== "object") return false;
  if (typeof item.key !== "string" || !/^[A-Za-z0-9_:.-]{1,128}$/.test(item.key)) return false;
  if (typeof item.user !== "string" || !KID_ROLES.has(item.user)) return false;

  if (item.type === "chore") {
    if (typeof item.id !== "string" || item.id.length === 0) return false;
    if (typeof item.label !== "string" || item.label.length === 0) return false;
    if (item.isAdHoc === true) {
      return true;
    }
    const amount = Number(item.amount);
    return Number.isFinite(amount) && amount > 0 && Number.isInteger(amount);
  }

  if (item.type === "streak") {
    if (typeof item.id !== "string" || item.id.length === 0) return false;
    if (typeof item.dayKey !== "string" || item.dayKey.length === 0) return false;
    if (typeof item.mode !== "undefined" && item.mode !== "vacation-hold") return false;
    return true;
  }

  return false;
}

async function normalizePendingItem(env, item) {
  if (!item || typeof item !== "object") return null;

  if (item.type === "streak") {
    return {
      key: item.key,
      type: "streak",
      user: item.user,
      id: item.id,
      dayKey: item.dayKey,
      ...(item.mode === "vacation-hold" ? { mode: "vacation-hold" } : {}),
    };
  }

  if (item.type !== "chore") {
    return null;
  }

  const chores = await readChores(env);
  const chore = chores.find(entry => entry.id === item.id);
  if (chore) {
    return {
      key: item.key,
      type: "chore",
      user: item.user,
      id: chore.id,
      label: chore.label,
      amount: chore.amount,
      dayKey: typeof item.dayKey === "string" ? item.dayKey : getTodayKeyUtc(),
    };
  }

  if (item.isAdHoc !== true) return null;

  const label = typeof item.label === "string" ? item.label.trim().replace(/[<>&"']/g, "").slice(0, 80) : "";
  const id = sanitizeChoreId(typeof item.id === "string" && item.id ? item.id : `adhoc-${slugifyValue(label).slice(0, 34)}`);
  if (!label || !id.startsWith("adhoc-")) return null;

  return {
    key: item.key,
    type: "chore",
    user: item.user,
    id,
    label,
    isAdHoc: true,
    dayKey: typeof item.dayKey === "string" ? item.dayKey : getTodayKeyUtc(),
  };
}

function slugifyValue(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeChoreList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHORES) {
    return null;
  }

  const seen = new Set();
  const chores = [];

  for (const item of value) {
    if (!item || typeof item !== "object") return null;

    const id = sanitizeChoreId(item.id);
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const amount = Number(item.amount);

    if (!id || !label || !Number.isInteger(amount) || amount <= 0 || amount > 1000) {
      return null;
    }
    if (seen.has(id)) return null;

    seen.add(id);
    chores.push({ id, label, amount });
  }

  return chores;
}

function sanitizeChoreId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!/^[a-z0-9-]{2,40}$/.test(trimmed)) return "";
  return trimmed;
}

function sanitizeScheduleStatuses(value) {
  if (!value || typeof value !== "object") return {};

  const clean = {};
  for (const [dayKey, dayStatuses] of Object.entries(value)) {
    if (!isValidDayKey(dayKey) || !dayStatuses || typeof dayStatuses !== "object") {
      continue;
    }

    const nextDayStatuses = {};
    for (const [blockId, status] of Object.entries(dayStatuses)) {
      if (isValidScheduleBlockId(blockId) && VALID_SCHEDULE_STATUSES.has(status)) {
        nextDayStatuses[blockId] = status;
      }
    }

    if (Object.keys(nextDayStatuses).length > 0) {
      clean[dayKey] = nextDayStatuses;
    }
  }

  return clean;
}

function isValidDayKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidScheduleBlockId(value) {
  return typeof value === "string" && /^[a-z0-9-]{2,40}$/.test(value);
}

function isValidAvatarDataUrl(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 350000) return false;
  return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value);
}

function sanitizeAvatars(value) {
  if (!value || typeof value !== "object") return {};

  const clean = {};
  for (const role of VALID_ROLES) {
    const candidate = value[role];
    if (isValidAvatarDataUrl(candidate)) {
      clean[role] = candidate;
    }
  }
  return clean;
}
