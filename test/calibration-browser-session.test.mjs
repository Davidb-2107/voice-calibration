import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import vm from "node:vm";
import { FakeElement, FakeHeaders } from "./calibration-ui-client.test.mjs";

const client = readFileSync(new URL("../dist/ui/calibration-client.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser(stored = null, hash = "", intercept = () => undefined) {
  const ids = ["status", "workspace", "account", "account-email", "login", "login-form", "login-email", "login-password",
    "login-submit", "logout", "refresh", "prepare-form", "approve", "execute", "publish-profile", "result-preview",
    "dry-run-state", "dry-run-summary", "execution-progress", "config-status", "corpus-items", "corpus-version",
    "password-setup", "password-form", "password-submit", "new-password", "confirm-password"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const storage = new Map(stored ? [["voice-calibration-session:https://example.supabase.co", JSON.stringify(stored)]] : []);
  const calls = [];
  let reloads = 0;
  const context = vm.createContext({
    CALIBRATION_AUTH: { url: "https://example.supabase.co", publishableKey: "public" },
    document: { getElementById: id => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => new FakeElement() },
    URLSearchParams, Headers: FakeHeaders, location: { hash, pathname:"/", reload() { reloads++; } },
    history: { replaceState() { hash = ""; } },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const intercepted = intercept(url, options);
      if (intercepted) return intercepted;
      let body = {};
      if (url.includes("/token?")) body = { access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { email: "a@example.test" } };
      else if (url === "/api/v1/bootstrap") body = { sessionNonce: "nonce", config: { configured: true }, recentRuns: [], profiles: [] };
      else if (url === "/api/v1/corpus") body = { items: [] };
      else if (url.endsWith("/auth/v1/user")) body = { email:"a@example.test" };
      return { ok: true, status: 200, headers: new FakeHeaders(), json: async () => body };
    },
  });
  vm.runInContext(client, context);
  return { elements, storage, calls, context, reloads: () => reloads, hash: () => hash };
}

test("anonymous browser sends no business request; login clears password and logout clears the session", async () => {
  const b = browser(); await tick();
  strictEqual(b.calls.length, 0);
  strictEqual(b.elements.get("workspace").hidden, true);
  b.elements.get("login-email").value = "a@example.test";
  b.elements.get("login-password").value = "never-store-password";
  b.elements.get("login-form").dispatch("submit"); await tick();
  strictEqual(b.reloads(), 1);
  strictEqual(b.elements.get("login-password").value, "");
  ok(![...b.storage.values()].join().includes("never-store-password"));
  b.elements.get("logout").dispatch("click"); await tick();
  strictEqual(b.storage.size, 0);
  ok(b.calls.at(-1).url.endsWith("/logout?scope=local"));
  strictEqual(b.calls.filter(c => c.url.startsWith("/api/v1")).length, 0);
});

test("invitation verifies the session, clears URL tokens and requires a matching password before business IO", async () => {
  const b = browser(null, "#access_token=invite-access&refresh_token=invite-refresh&expires_in=3600&type=invite");
  await tick(); await tick();
  strictEqual(b.hash(), "");
  strictEqual(b.calls.filter(c=>c.url.startsWith("/api/v1")).length,0);
  strictEqual(b.elements.get("password-setup").hidden,false);
  b.elements.get("new-password").value="new-safe-test-password";
  b.elements.get("confirm-password").value="different";
  b.elements.get("password-form").dispatch("submit"); await tick();
  strictEqual(b.calls.filter(c=>c.options.method==="PUT").length,0);
  b.elements.get("confirm-password").value="new-safe-test-password";
  b.elements.get("password-form").dispatch("submit"); await tick();
  strictEqual(b.calls.filter(c=>c.options.method==="PUT").length,1);
  strictEqual(b.reloads(),1);
  strictEqual(b.elements.get("new-password").value,"");
  ok(![...b.storage.values()].join().includes("new-safe-test-password"));
  strictEqual(JSON.parse([...b.storage.values()][0]).needsPassword,undefined);
});

test("expired browser session rotates once before business access and never replays an API mutation", async () => {
  const b = browser({ access_token: "old", refresh_token: "old-refresh", expires_at: 0, user: { email: "a@example.test" } });
  await tick(); await tick();
  strictEqual(b.calls.filter(c => c.url.includes("grant_type=refresh_token")).length, 1);
  const business = b.calls.filter(c => c.url.startsWith("/api/v1"));
  strictEqual(business.length, 2);
  for (const c of business) strictEqual(c.options.headers.get("authorization"), "Bearer access");
  strictEqual(b.elements.get("login").hidden, true);
  strictEqual(b.elements.get("account-email").textContent, "a@example.test");
  strictEqual(business.filter(c => c.options.method === "POST").length, 0);
});

test("logout invalidates a pending refresh even when the expired logout token is refused", async () => {
  let resolveRefresh;
  const pending = new Promise(resolve => { resolveRefresh = resolve; });
  const b = browser({ access_token: "expired", refresh_token: "old-refresh", expires_at: 0, user: { email: "a@example.test" } }, "", url => {
    if (url.includes("grant_type=refresh_token")) return pending;
    if (url.includes("/logout?")) return { ok: false, status: 401 };
  });
  await tick();
  b.elements.get("logout").dispatch("click");
  await tick();
  resolveRefresh({ ok: true, json: async () => ({ access_token: "late", refresh_token: "late-refresh", expires_in: 3600, user: { email: "a@example.test" } }) });
  await tick(); await tick();
  strictEqual(b.storage.size, 0);
  strictEqual(vm.runInContext("browserSession", b.context), null);
  strictEqual(b.elements.get("login").hidden, false);
  strictEqual(b.calls.filter(c => c.url.startsWith("/api/v1")).length, 0);
  strictEqual(b.reloads(), 1);
});

test("a rejected old refresh cannot clear a newer login", async () => {
  let rejectRefresh;
  const pending = new Promise((_, reject) => { rejectRefresh = reject; });
  const b = browser({ access_token: "expired", refresh_token: "old-refresh", expires_at: 0, user: { email: "a@example.test" } }, "", url => {
    if (url.includes("grant_type=refresh_token")) return pending;
  });
  await tick();
  b.elements.get("logout").dispatch("click"); await tick();
  b.elements.get("login-email").value = "a@example.test";
  b.elements.get("login-password").value = "new-password";
  b.elements.get("login-form").dispatch("submit"); await tick();
  const newSession = [...b.storage.values()][0];
  rejectRefresh(new Error("old refresh failed"));
  await tick(); await tick();
  strictEqual([...b.storage.values()][0], newSession);
  strictEqual(vm.runInContext("browserSession.access_token", b.context), "access");
  strictEqual(b.calls.filter(c => c.url.startsWith("/api/v1")).length, 0);
});

test("an old refresh cannot release a newer refresh shared by concurrent callers", async () => {
  const responses = [];
  const b = browser({ access_token: "expired", refresh_token: "old-refresh", expires_at: 0, user: { email: "a@example.test" } }, "", url => {
    if (url.includes("grant_type=refresh_token")) return new Promise(resolve => responses.push(resolve));
  });
  await tick();
  b.elements.get("logout").dispatch("click"); await tick();
  b.elements.get("login-form").dispatch("submit"); await tick();
  vm.runInContext("browserSession.expires_at = 0; globalThis.newRenewal = sessionToken();", b.context);
  const newRenewal = vm.runInContext("renewing", b.context);
  responses[0]({ ok: true, json: async () => ({ access_token: "obsolete", refresh_token: "obsolete", expires_in: 3600, user: { email: "a@example.test" } }) });
  await tick(); await tick();
  strictEqual(vm.runInContext("renewing", b.context), newRenewal);
  vm.runInContext("globalThis.concurrentRenewal = sessionToken();", b.context);
  strictEqual(responses.length, 2);
  responses[1]({ ok: true, json: async () => ({ access_token: "current", refresh_token: "current", expires_in: 3600, user: { email: "a@example.test" } }) });
  strictEqual(await b.context.newRenewal, "current");
  strictEqual(await b.context.concurrentRenewal, "current");
});
