import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanonicalProfilePort } from "../dist/calibration/bridge.js";
import { findVaultRoot } from "../dist/calibration/credentials.js";

test("canonical corpus uses the same vault discovery as credentials outside the vault", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const corpusDir = join(vault, "Shared", "voice-calibration");
  mkdirSync(join(vault, "Projects"), { recursive: true });
  mkdirSync(corpusDir, { recursive: true });
  writeFileSync(join(corpusDir, "voice_wpm.json"), JSON.stringify({
    "voice-test": { observed_runs: [{ postproc: "raw", verified: true, words: 10, duration_s: 5 }] },
  }));

  const resolvedVault = findVaultRoot(join(root, "checkout"), vault);
  strictEqual(resolvedVault, vault);
  strictEqual(findVaultRoot(join(vault, "Projects", "consumer"), join(root, "missing")), vault);
  const canonical = createCanonicalProfilePort({ wpmPath: join(resolvedVault, "Shared", "voice-calibration", "voice_wpm.json") });
  const summary = await canonical.getObservationSummary();
  deepStrictEqual(summary, { sourceAvailable: true, voices: [{
    voiceRef: "voice-test", total: 1, raw: 1, rawClean: 1, trim: 0, cut: 0, other: 0, unknown: 0,
  }] });
});
