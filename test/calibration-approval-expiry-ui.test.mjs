import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import vm from "node:vm";
import { FakeElement, FakeHeaders } from "./calibration-ui-client.test.mjs";

const client = readFileSync(new URL("../dist/ui/calibration-client.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(status = "approved") {
  const ids = ["status", "config-status", "observation-summary-status", "observation-summary-rows", "observation-summary-total", "corpus-items", "corpus-version", "dry-run-state", "dry-run-summary", "execution-progress", "result-preview", "refresh", "prepare-form", "approve", "execute", "publish-profile", "provider-banner", "execution-notice"];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  let time = Date.parse("2026-10-13T00:16:00Z");
  const run = { id: "same-run", status, requestDigest: "same-digest", request: { voiceRef: "voice-a" },
    proposal: { raw: { requests_planned: 5, estimated_cost_usd: 0.218 } },
    approval: { approvedAt: "2026-10-13T00:00:00Z", expiresAt: "2026-10-13T00:15:00Z", consumedAt: null } };
  const calls = []; const ticks = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) ?? null, querySelectorAll: () => [], createElement: () => new FakeElement() },
    Headers: FakeHeaders, crypto: { randomUUID: () => "nonce" }, console,
    Date: class extends Date { static now() { return time; } }, setInterval: (callback) => { ticks.push(callback); },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      let body;
      if (url === "/api/v1/bootstrap") body = { sessionNonce: "nonce", config: { configured: true, providerMode: "simulated" }, recentRuns: [run], profiles: [] };
      else if (url === "/api/v1/corpus") body = { draft: { revision: 1, items: [] }, activeVersion: { revision: 1, items: [] } };
      else if (url.endsWith("/approve")) body = { ...run, approval: { ...run.approval, expiresAt: "2026-10-13T00:31:00Z" } };
      else if (url.endsWith("/same-run")) body = run;
      else throw new Error("Unexpected action " + url);
      return { ok: true, status: 200, json: async () => body };
    },
  });
  vm.runInContext(client, context); await flush(); await flush();
  return { elements, calls, ticks, context, advance: () => { time += 16 * 60 * 1000; } };
}

test("expired approval is explicit, renews the same run once, and cannot execute before renewal", async () => {
  const f = await fixture();
  ok(f.elements.get("dry-run-state").textContent.includes("Approbation expirée"));
  strictEqual(f.elements.get("approve").textContent, "Renouveler l’approbation");
  strictEqual(f.elements.get("approve").disabled, false);
  strictEqual(f.elements.get("execute").disabled, true);
  strictEqual(f.elements.get("provider-banner").hidden, false);
  ok(f.elements.get("dry-run-summary").textContent.includes("dépense réelle : 0 USD"));
  f.elements.get("execute").dispatch("click"); await flush();
  strictEqual(f.calls.filter((call) => call.url.endsWith("/execute")).length, 0);
  f.elements.get("approve").dispatch("click"); f.elements.get("approve").dispatch("click");
  await flush(); await flush();
  const approvals = f.calls.filter((call) => call.url.endsWith("/approve"));
  strictEqual(approvals.length, 1);
  strictEqual(approvals[0].url, "/api/v1/calibration-runs/same-run/approve");
  strictEqual(JSON.parse(approvals[0].init.body).requestDigest, "same-digest");
  strictEqual(f.elements.get("execute").disabled, false);
  f.advance(); f.ticks.forEach((tick) => tick());
  strictEqual(f.elements.get("execute").disabled, true);
  ok(f.elements.get("dry-run-state").textContent.includes("Approbation expirée"));
});

test("uncertain operations stay disabled and technical expiry errors have actionable French text", async () => {
  const f = await fixture("execution_unknown");
  strictEqual(f.elements.get("approve").disabled, true);
  strictEqual(f.elements.get("execute").disabled, true);
  f.elements.get("approve").dispatch("click"); f.elements.get("execute").dispatch("click"); await flush();
  strictEqual(f.calls.filter((call) => /\/(approve|execute)$/.test(call.url)).length, 0);
  const message = vm.runInContext('actionError("Unexpired approval required before queue admission",409)', f.context);
  ok(message.includes("approbation a expiré") && message.includes("Renouveler"));
});

test("published voice conflicts explain reuse without exposing the technical error", async () => {
  const f = await fixture();
  const expected = "Cette voix possède déjà un profil de calibration publié. Vous pouvez l’utiliser dans vos projets. Aucune nouvelle synthèse ne sera lancée.";
  for (const message of [
    'La voix "voice-a" possède déjà un calibrage publié. Aucune nouvelle synthèse ne sera lancée.',
    'La voix "voice-a" possède déjà un profil de calibrage publié. Aucune nouvelle synthèse ne sera lancée.',
  ]) {
    strictEqual(vm.runInContext(`actionError(${JSON.stringify(message)},409)`, f.context), expected);
  }
  ok(vm.runInContext('actionError("execution_unknown",409)', f.context).includes("Ne la relancez pas"));
});
