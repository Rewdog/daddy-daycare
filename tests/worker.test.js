import { describe, it, expect, beforeEach } from "bun:test";
import worker from "../worker.js";

// ---- Test fixtures ----

const TEST_IP = "1.2.3.4";
const BLOCKED_IP = "9.9.9.9";

function makeEnv(kvStore = {}) {
  const store = new Map(Object.entries(kvStore));
  return {
    DAYCARE_KV: {
      get: async (key, _opts) => (store.has(key) ? store.get(key) : null),
      put: async (key, value, _opts) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
    },
    ASSETS: {
      fetch: async () => new Response("asset", { status: 200 }),
    },
    APP_NAME: "Test Daycare",
    PARENT_ROLES: '["Dad","Mom"]',
    KID_ROLES: '["Child1","Child2"]',
    ALLOWED_IP: TEST_IP,
    // Exposed for tests that need to assert side effects on the underlying map.
    __store: store,
  };
}

function makeRequest(path, options = {}) {
  const headers = {
    "CF-Connecting-IP": TEST_IP,
    ...(options.headers || {}),
  };
  return new Request(`https://daycare.workers.dev${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });
}

async function call(path, options, env) {
  return worker.fetch(makeRequest(path, options), env || makeEnv());
}

function withKidSession(role, env) {
  const token = crypto.randomUUID();
  env.__store.set(
    `session:${token}`,
    JSON.stringify({ role, expires: Date.now() + 86_400_000 }),
  );
  return token;
}

// ---- Tests ----

describe("worker.fetch — IP restriction", () => {
  it("returns 403 for a disallowed IP", async () => {
    const res = await call("/api/state", {
      headers: { "CF-Connecting-IP": BLOCKED_IP },
    });
    expect(res.status).toBe(403);
  });

  it("does not return 403 for the allowed IP", async () => {
    const res = await call("/api/state");
    expect(res.status).not.toBe(403);
  });
});

describe("worker.fetch — CORS preflight", () => {
  it("returns 200 for OPTIONS from the allowed IP", async () => {
    const res = await call("/api/state", { method: "OPTIONS" });
    expect(res.status).toBe(200);
  });

  it("returns 200 for OPTIONS on any path from the allowed IP", async () => {
    const res = await call("/api/literally-anything", { method: "OPTIONS" });
    expect(res.status).toBe(200);
  });
});

describe("worker.fetch — auth gating", () => {
  it("returns 401 for GET /api/state without Authorization", async () => {
    const res = await call("/api/state");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown API route", async () => {
    const res = await call("/api/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("worker.fetch — auth setup/check/login", () => {
  let env;

  beforeEach(() => {
    env = makeEnv();
  });

  it("POST /api/auth/check on empty KV returns { exists: false }", async () => {
    const res = await call(
      "/api/auth/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Child1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ exists: false });
  });

  it("POST /api/auth/setup succeeds, then a second call returns 409", async () => {
    const first = await call(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Child1", password: "test123" }),
      },
      env,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);

    const second = await call(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Child1", password: "test123" }),
      },
      env,
    );
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error).toBe("already_set");
  });

  it("POST /api/auth/login with wrong password returns non-200 with error body", async () => {
    const setup = await call(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Child1", password: "correct-horse" }),
      },
      env,
    );
    expect(setup.status).toBe(200);

    const login = await call(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Child1", password: "wrong-password" }),
      },
      env,
    );
    expect(login.status).not.toBe(200);
    const body = await login.json();
    expect(body.error).toBeDefined();
  });

  it("accepts Mom as a valid auth role", async () => {
    const res = await call(
      "/api/auth/check",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Mom" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ exists: false });
  });
});

describe("worker.fetch — Dad-only routes reject kid sessions", () => {
  it("POST /api/tokens/adjust with a kid session returns 403", async () => {
    const env = makeEnv();
    const token = withKidSession("Child1", env);

    const res = await call(
      "/api/tokens/adjust",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user: "Child1", amount: 5, direction: 1 }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("dad_only");
  });

  it("POST /api/approve with a kid session returns 403", async () => {
    const env = makeEnv();
    const token = withKidSession("Child1", env);

    const res = await call(
      "/api/approve",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ key: "some-key" }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("dad_only");
  });

  it("POST /api/tokens/adjust with a Mom session is allowed", async () => {
    const env = makeEnv({ "tokens:Child1": "10" });
    const token = withKidSession("Mom", env);

    const res = await call(
      "/api/tokens/adjust",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user: "Child1", amount: 5, direction: 1 }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(15);
  });
});

describe("worker.fetch — rewards spending", () => {
  it("rejects forged reward prices and leaves the balance unchanged", async () => {
    const env = makeEnv({
      "tokens:Child1": "50",
      rewards: JSON.stringify([
        { id: "special-outing", label: "Special outing", cost: 60 },
      ]),
    });
    const token = withKidSession("Child1", env);

    const res = await call(
      "/api/spend",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rewardId: "special-outing", cost: 1, rewardName: "Special outing" }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("insufficient_balance");
    expect(env.__store.get("tokens:Child1")).toBe("50");
    expect(env.__store.get("spend_notifications")).toBeUndefined();
  });
});

describe("worker.fetch — ad-hoc chore submissions", () => {
  it("lets a kid submit an ad-hoc chore and a parent approve it with a chosen amount", async () => {
    const env = makeEnv({
      "tokens:Child2": "20",
      pending: JSON.stringify([
        {
          key: "Child2:adhoc:cleaned-the-kitchen:2026-07-20",
          type: "chore",
          user: "Child2",
          id: "adhoc-cleaned-the-kitchen",
          label: "Cleaned the kitchen",
          dayKey: "2026-07-20",
          isAdHoc: true,
        },
      ]),
    });
    const token = withKidSession("Dad", env);

    const res = await call(
      "/api/approve",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          key: "Child2:adhoc:cleaned-the-kitchen:2026-07-20",
          amount: 35,
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("chore");
    expect(body.amount).toBe(35);
    expect(body.balance).toBe(55);

    expect(env.__store.get("tokens:Child2")).toBe("55");
    expect(JSON.parse(env.__store.get("pending"))).toEqual([]);
  });
});

describe("worker.fetch — streak vacation keep-alive", () => {
  it("lets a kid request a vacation keep-alive and a parent approval pauses the streak without increasing it", async () => {
    const env = makeEnv({
      pending: JSON.stringify([
        {
          key: "Child1:streak:pup-entertainer:2026-07-20:vacation-hold",
          type: "streak",
          user: "Child1",
          id: "pup-entertainer",
          dayKey: "2026-07-20",
          mode: "vacation-hold",
        },
      ]),
      streaks: JSON.stringify({
        Child1: {
          "pup-entertainer": {
            current: 4,
            best: 4,
            lastApprovedDay: "2026-07-19",
          },
        },
      }),
    });
    const token = withKidSession("Mom", env);

    const res = await call(
      "/api/approve",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ key: "Child1:streak:pup-entertainer:2026-07-20:vacation-hold" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("streak");
    expect(body.record.current).toBe(4);

    const streaks = JSON.parse(env.__store.get("streaks"));
    expect(streaks.Child1["pup-entertainer"].current).toBe(4);
    expect(streaks.Child1["pup-entertainer"].lastApprovedDay).toBe("2026-07-20");
  });
});

// ---- Easter Egg Challenge tests ----

// Generic env for new tests — no family-specific role names in committed code.
function makeGenericEnv(kvStore = {}) {
  const store = new Map(Object.entries(kvStore));
  return {
    DAYCARE_KV: {
      get: async (key) => (store.has(key) ? store.get(key) : null),
      put: async (key, value) => { store.set(key, value); },
      delete: async (key) => { store.delete(key); },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    APP_NAME: "Test Daycare",
    PARENT_ROLES: '["Parent1","Parent2"]',
    KID_ROLES: '["Child1","Child2"]',
    ALLOWED_IP: TEST_IP,
    __store: store,
  };
}

function withGenericKidSession(role, env) {
  const token = crypto.randomUUID();
  env.__store.set(`session:${token}`, JSON.stringify({ role, expires: Date.now() + 86_400_000 }));
  return token;
}

function withGenericParentSession(role, env) {
  const token = crypto.randomUUID();
  env.__store.set(`session:${token}`, JSON.stringify({ role, expires: Date.now() + 86_400_000 }));
  return token;
}

function todayKeyUtc() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function setupKidAuth(role, password, env) {
  await call(
    "/api/auth/setup",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, password }) },
    env,
  );
}

describe("Easter Egg Challenges — submit idea", () => {
  let env, kidToken;

  beforeEach(() => {
    env = makeGenericEnv();
    kidToken = withGenericKidSession("Child1", env);
  });

  it("kid can submit a challenge idea (goes to pending, approved:false)", async () => {
    const res = await call(
      "/api/egg-challenges/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ title: "Clean the garage", description: "It needs it", token_reward: 40, time_limit_minutes: 120 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe("string");

    const challenges = JSON.parse(env.__store.get("egg_challenges"));
    expect(challenges).toHaveLength(1);
    expect(challenges[0].approved).toBe(false);
    expect(challenges[0].title).toBe("Clean the garage");
    expect(challenges[0].created_by).toBe("Child1");
  });

  it("parent-submitted idea is auto-approved", async () => {
    const parentToken = withGenericParentSession("Parent1", env);
    const res = await call(
      "/api/egg-challenges/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` },
        body: JSON.stringify({ title: "Tidy the backyard", token_reward: 50, time_limit_minutes: 60 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const challenges = JSON.parse(env.__store.get("egg_challenges"));
    expect(challenges[0].approved).toBe(true);
  });

  it("rejects submission missing title", async () => {
    const res = await call(
      "/api/egg-challenges/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ token_reward: 40, time_limit_minutes: 60 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("title_required");
  });

  it("rejects submission with token_reward of 0", async () => {
    const res = await call(
      "/api/egg-challenges/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ title: "Do something", token_reward: 0, time_limit_minutes: 60 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_token_reward");
  });

  it("rejects submission with time_limit_minutes below 5", async () => {
    const res = await call(
      "/api/egg-challenges/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ title: "Too quick", token_reward: 10, time_limit_minutes: 3 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_time_limit");
  });
});

describe("Easter Egg Challenges — approve and reject", () => {
  let env, parentToken;

  beforeEach(() => {
    env = makeGenericEnv({
      egg_challenges: JSON.stringify([
        { id: "c1", title: "Clean the garage", approved: false, token_reward: 40, time_limit_minutes: 120, repeatable: true, created_by: "Child1", created_at: Date.now() },
      ]),
    });
    parentToken = withGenericParentSession("Parent1", env);
  });

  it("parent can approve a pending challenge", async () => {
    const res = await call(
      "/api/egg-challenges/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` },
        body: JSON.stringify({ id: "c1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const challenges = JSON.parse(env.__store.get("egg_challenges"));
    expect(challenges[0].approved).toBe(true);
  });

  it("kid cannot approve a challenge", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/egg-challenges/approve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ id: "c1" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("parent can reject a challenge idea (removes it)", async () => {
    const res = await call(
      "/api/egg-challenges/reject",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` },
        body: JSON.stringify({ id: "c1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const challenges = JSON.parse(env.__store.get("egg_challenges"));
    expect(challenges).toHaveLength(0);
  });
});

describe("Easter Egg Challenges — activate and toggle", () => {
  let env, parentToken;

  beforeEach(() => {
    env = makeGenericEnv({
      egg_challenges: JSON.stringify([
        { id: "c1", title: "Clean the garage", approved: true, token_reward: 40, time_limit_minutes: 120, repeatable: true, created_by: "Parent1", created_at: Date.now() },
      ]),
    });
    parentToken = withGenericParentSession("Parent1", env);
  });

  it("parent can activate an egg (creates active_eggs entry)", async () => {
    const res = await call(
      "/api/eggs/activate",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` }, body: "{}" },
      env,
    );
    expect(res.status).toBe(200);
    const eggs = JSON.parse(env.__store.get("active_eggs") || "[]");
    expect(eggs).toHaveLength(1);
    expect(eggs[0].challenge_id).toBe("c1");
    expect(typeof eggs[0].display_end).toBe("number");
  });

  it("activate returns 400 when no approved challenges exist", async () => {
    env = makeGenericEnv({ egg_challenges: JSON.stringify([]) });
    parentToken = withGenericParentSession("Parent1", env);
    const res = await call(
      "/api/eggs/activate",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` }, body: "{}" },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("no_approved_challenges");
  });

  it("kid cannot activate an egg", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/eggs/activate",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` }, body: "{}" },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("parent can disable and re-enable eggs via toggle", async () => {
    const disable = await call(
      "/api/eggs/toggle",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` }, body: JSON.stringify({ enabled: false }) },
      env,
    );
    expect(disable.status).toBe(200);
    const schedule = JSON.parse(env.__store.get("egg_schedule") || "{}");
    expect(schedule.enabled).toBe(false);

    await call(
      "/api/eggs/toggle",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` }, body: JSON.stringify({ enabled: true }) },
      env,
    );
    const scheduleAfter = JSON.parse(env.__store.get("egg_schedule") || "{}");
    expect(scheduleAfter.enabled).toBe(true);
  });
});

describe("Easter Egg Challenges — accept", () => {
  let env, password;

  beforeEach(async () => {
    env = makeGenericEnv({
      // active_eggs use challenge_id to reference the challenge pool entry.
      // The accept endpoint finds eggs by e.challenge_id === request.challenge_id.
      active_eggs: JSON.stringify([
        { id: "e1", challenge_id: "c1", challenge_title: "Clean the garage", challenge_description: "", token_reward: 40, time_limit_minutes: 120, display_end: Date.now() + 900_000, expires_at: Date.now() + 960_000 },
      ]),
    });
    password = "test-secret";
    await setupKidAuth("Child1", password, env);
  });

  it("kid can accept an active egg with correct password", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/eggs/accept",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ challenge_id: "c1", kid_role: "Child1", password }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const accepts = JSON.parse(env.__store.get("egg_accepts") || "[]");
    expect(accepts).toHaveLength(1);
    expect(accepts[0].kid_role).toBe("Child1");
    expect(accepts[0].challenge_id).toBe("c1");
  });

  it("returns 401 when wrong password supplied", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/eggs/accept",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ challenge_id: "c1", kid_role: "Child1", password: "wrong-password" }),
      },
      env,
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("wrong_password");
  });

  it("returns 409 if same kid tries to accept same egg twice", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const payload = { challenge_id: "c1", kid_role: "Child1", password };
    const opts = { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` }, body: JSON.stringify(payload) };
    await call("/api/eggs/accept", opts, env);
    const second = await call("/api/eggs/accept", { ...opts, body: JSON.stringify(payload) }, env);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("already_accepted");
  });

  it("returns 404 when challenge_id does not exist in active_eggs", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/eggs/accept",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ challenge_id: "no-such-challenge", kid_role: "Child1", password }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("Easter Egg Challenges — complete and verify", () => {
  let env, parentToken, acceptId;

  beforeEach(() => {
    acceptId = "a1";
    // Include a chore + today's approved entry so the chore cap doesn't apply (tests full multiplier).
    const choreId = "chore-test";
    const today = todayKeyUtc();
    env = makeGenericEnv({
      egg_accepts: JSON.stringify([
        {
          id: acceptId,
          egg_id: "e1",
          challenge_id: "c1",
          challenge_title: "Clean the garage",
          kid_role: "Child1",
          accepted_at: Date.now() - 1_800_000, // 30 min ago → 25% of 120 min → 2.0x
          expires_at: Date.now() + 60_000,
          time_limit_minutes: 120,
          token_reward: 40,
          completed_at: null,
          status: "active",
        },
      ]),
      chores: JSON.stringify([{ id: choreId, label: "Test chore", amount: 10 }]),
      approved: JSON.stringify([`Child1:${choreId}:${today}`]),
      "tokens:Child1": "10",
    });
    parentToken = withGenericParentSession("Parent1", env);
  });

  it("kid can mark a challenge complete (moves to pending)", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    const res = await call(
      "/api/egg-challenges/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ accept_id: acceptId }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const accepts = JSON.parse(env.__store.get("egg_accepts"));
    const a = accepts.find(x => x.id === acceptId);
    expect(typeof a.completed_at).toBe("number");

    const pending = JSON.parse(env.__store.get("pending") || "[]");
    expect(pending.some(p => p.accept_id === acceptId && p.type === "egg_challenge")).toBe(true);
  });

  it("parent can verify/award tokens with speed multiplier applied", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    await call(
      "/api/egg-challenges/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ accept_id: acceptId }),
      },
      env,
    );

    // Kid used 30 min of 120 min limit = 25% → 2.0x multiplier → 80 tokens
    const res = await call(
      "/api/egg-challenges/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` },
        body: JSON.stringify({ accept_id: acceptId, action: "approve" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.tokens_awarded).toBe(80); // 40 base × 2.0x
    expect(Number(env.__store.get("tokens:Child1"))).toBe(90); // 10 existing + 80
  });

  it("parent can deny a completion (removes from pending, no tokens awarded)", async () => {
    const kidToken = withGenericKidSession("Child1", env);
    await call(
      "/api/egg-challenges/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${kidToken}` },
        body: JSON.stringify({ accept_id: acceptId }),
      },
      env,
    );

    const res = await call(
      "/api/egg-challenges/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentToken}` },
        body: JSON.stringify({ accept_id: acceptId, action: "deny" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(Number(env.__store.get("tokens:Child1"))).toBe(10); // unchanged
    const pending = JSON.parse(env.__store.get("pending") || "[]");
    expect(pending.some(p => p.accept_id === acceptId)).toBe(false);
  });

  it("chore cap: multiplier capped at 1.2x when no chores approved today", async () => {
    // 10 min of 120 min used → normally 2.0x, but no chores → capped at 1.2x → 48 tokens
    const env2 = makeGenericEnv({
      egg_accepts: JSON.stringify([
        {
          id: "a2",
          egg_id: "e1",
          challenge_id: "c1",
          challenge_title: "Clean the garage",
          kid_role: "Child1",
          accepted_at: Date.now() - 600_000, // 10 min ago
          expires_at: Date.now() + 60_000,
          time_limit_minutes: 120,
          token_reward: 40,
          completed_at: Date.now() - 60_000,
          status: "active",
        },
      ]),
      pending: JSON.stringify([
        { accept_id: "a2", type: "egg_challenge", kid_role: "Child1", challenge_title: "Clean the garage", time_limit_minutes: 120, token_reward: 40 },
      ]),
      "tokens:Child1": "0",
    });
    const parent2 = withGenericParentSession("Parent1", env2);

    const res = await call(
      "/api/egg-challenges/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${parent2}` },
        body: JSON.stringify({ accept_id: "a2", action: "approve" }),
      },
      env2,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).tokens_awarded).toBe(48); // 40 * 1.2x chore cap
  });
});
