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
