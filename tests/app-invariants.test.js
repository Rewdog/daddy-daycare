import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const APP_JS_PATH = resolve(import.meta.dir, "..", "app.js");
const WORKER_JS_PATH = resolve(import.meta.dir, "..", "worker.js");
const appJs = readFileSync(APP_JS_PATH, "utf-8");
const workerJs = readFileSync(WORKER_JS_PATH, "utf-8");

// ---- Helpers ----

/**
 * Extracts the body of a `function <name>(...)` declaration by matching
 * balanced braces from the first `{` AFTER the parameter list.
 *
 * Important: the parameter list itself can contain `{}` (default values,
 * destructuring), so we first scan from the header to the closing `)` of
 * the parameter list, then look for the body's opening `{`.
 */
function extractFunctionBody(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;

  // Find the `(` that opens the parameter list (after the function name).
  const parenStart = source.indexOf("(", start + header.length);
  if (parenStart === -1) return null;

  // Walk paren depth to find the matching `)`.
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  if (parenEnd === -1) return null;

  // Now find the body's opening `{` and match braces.
  const braceStart = source.indexOf("{", parenEnd);
  if (braceStart === -1) return null;

  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  return null;
}

/**
 * Extracts the keys from the first object literal inside a function body.
 * Assumes a simple `appState = { key1: ..., key2: ... }` style.
 */
function extractObjectLiteralKeys(body) {
  if (!body) return [];
  const start = body.indexOf("{");
  if (start === -1) return [];

  let depth = 0;
  let end = -1;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];

  const literal = body.slice(start + 1, end);
  // Match top-level `key:` tokens — not perfect for deeply nested commentary,
  // but adequate for the flat appState shape used in this codebase.
  const keys = new Set();
  const keyPattern = /(^|[\s,{])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g;
  let m;
  while ((m = keyPattern.exec(literal))) {
    keys.add(m[2]);
  }
  return [...keys];
}

// ---- Invariant tests ----

describe("app.js — appState shape", () => {
  it("initial `let appState = {` declaration includes the `avatars` key", () => {
    expect(appJs).toMatch(/let appState\s*=\s*\{[^;]*avatars:/s);
  });

  it("refreshState preserves appState.avatars — REGRESSION GUARD", () => {
    // The bug: refreshState replaced appState entirely without `avatars`, so
    // appState.avatars became undefined and renderParentView crashed.
    // The fix: `avatars: appState.avatars || {}` inside the refreshState assignment.
    const refreshBody = extractFunctionBody(appJs, "async function refreshState");
    expect(refreshBody).not.toBeNull();
    expect(refreshBody).toMatch(/appState\.avatars\s*\|\|\s*\{\}/);
    // Belt-and-suspenders: assert the literal exists somewhere in the file too,
    // so accidental rename of refreshState doesn't silently lose coverage.
    expect(appJs).toMatch(/appState\.avatars\s*\|\|\s*\{\}/);
  });

  it("resetAppState function body includes `avatars:`", () => {
    const body = extractFunctionBody(appJs, "function resetAppState");
    expect(body).not.toBeNull();
    expect(body).toMatch(/avatars:/);
  });

  it("every appState field in resetAppState is also written by refreshState", () => {
    const resetBody = extractFunctionBody(appJs, "function resetAppState");
    const refreshBody = extractFunctionBody(appJs, "async function refreshState");
    expect(resetBody).not.toBeNull();
    expect(refreshBody).not.toBeNull();

    const resetKeys = extractObjectLiteralKeys(resetBody);
    const expected = [
      "tokens",
      "pending",
      "approved",
      "denied",
      "streaks",
      "avatars",
      "chores",
      "scheduleStatuses",
      "spendNotifications",
    ];

    // Confirm resetAppState declares every expected field (catches drift in either
    // direction — if either function loses a field, the test fires).
    for (const key of expected) {
      expect(resetKeys).toContain(key);
    }

    // Now the actual invariant: refreshState must write all the same fields.
    for (const key of resetKeys) {
      const pattern = new RegExp(`\\b${key}\\s*:`);
      if (!pattern.test(refreshBody)) {
        throw new Error(
          `refreshState is missing field '${key}' that resetAppState declares — appState shape drift will crash renderers`,
        );
      }
    }
  });
});

describe("app.js — storage and auth invariants", () => {
  it("does not store game state in localStorage", () => {
    // The intent is: tokens, chores, pending, streaks, etc. must go through KV
    // via the API — never localStorage. UI-preference keys (dashboard mode,
    // theme mode) are allowed because they are not game state.
    const ALLOWED_LOCALSTORAGE_KEYS = new Set([
      "DASHBOARD_MODE_STORAGE_KEY",
      "DASHBOARD_THEME_MODE_STORAGE_KEY",
      "AUTH_TOKEN_KEY",
      "AUTH_ROLE_KEY",
    ]);

    const usagePattern = /localStorage\.(?:getItem|setItem|removeItem)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const violations = [];
    let m;
    while ((m = usagePattern.exec(appJs))) {
      const argName = m[1];
      if (!ALLOWED_LOCALSTORAGE_KEYS.has(argName)) {
        violations.push(argName);
      }
    }

    // Also flag any localStorage call that doesn't pass a bare identifier
    // (e.g. a string literal) — that's exactly the regression we want to catch.
    const literalPattern = /localStorage\.(?:getItem|setItem|removeItem)\(\s*["'`]/g;
    if (literalPattern.test(appJs)) {
      violations.push("<string-literal-key>");
    }

    expect(violations).toEqual([]);
  });

  it("apiFetch never passes the auth token via URL query string", () => {
    // Tokens must travel in the Authorization header, not in URLs (which leak
    // through referer, server logs, browser history, etc.).
    const body = extractFunctionBody(appJs, "async function apiFetch");
    expect(body).not.toBeNull();
    expect(body).not.toMatch(/[?&]token=/);
  });
});

describe("app.js — required functions exist", () => {
  it("defines apiFetch", () => {
    expect(appJs).toMatch(/(?:async\s+)?function apiFetch\s*\(/);
  });

  it("defines refreshState as an async function", () => {
    expect(appJs).toMatch(/async function refreshState\s*\(/);
  });

  it("defines renderParentView", () => {
    expect(appJs).toMatch(/function renderParentView\s*\(/);
  });

  it("login calls refreshState", () => {
    const body = extractFunctionBody(appJs, "async function login");
    expect(body).not.toBeNull();
    expect(body).toMatch(/\brefreshState\s*\(/);
  });
});

describe("app.js — parent role invariants", () => {
  it("populates DEFAULT_AVATARS dynamically from familyConfig in loadFamilyConfig", () => {
    expect(appJs).toMatch(/DEFAULT_AVATARS\[r\]/);
    expect(appJs).toMatch(/loadFamilyConfig/);
  });

  it("defines a parent/admin role helper used by admin gating", () => {
    expect(appJs).toMatch(/function isParentUser\s*\(/);
    expect(appJs).toMatch(/isParentUser\s*\(/);
  });
});

describe("app.js — streak and rewards invariants", () => {
  it("defines core streaks and a vacation keep-alive request path", () => {
    expect(appJs).toMatch(/["']?helping["']?\s*:/);
    expect(appJs).toMatch(/["']?kindness["']?\s*:/);
    expect(appJs).toMatch(/["']?workout["']?\s*:/);
    expect(appJs).toMatch(/vacation keep-alive|Vacation Keep-Alive/i);
  });

  it("defines an ad-hoc chore request path for kids and parent point entry", () => {
    expect(appJs).toMatch(/function showAdHocChoreModal\s*\(/);
    expect(appJs).toMatch(/function submitAdHocChore\s*\(/);
    expect(appJs).toMatch(/pending-amount-input/);
  });

  it("includes generic default rewards in worker", () => {
    expect(workerJs).toMatch(/screen-time-30|snack-run|solo-time-parent/);
  });
});

describe("app.js — affirmation time invariants", () => {
  it("defines a UTC day-key helper for client-side affirmation credit math", () => {
    expect(appJs).toMatch(/function getTodayKeyUtc\s*\(/);
    expect(appJs).toMatch(/getUTCFullYear\s*\(/);
  });

  it("uses the UTC day-key helper when calculating affirmation credits", () => {
    const body = extractFunctionBody(appJs, "function renderKidView");
    expect(body).not.toBeNull();
    expect(body).toMatch(/getTodayKeyUtc\s*\(/);
  });
});
