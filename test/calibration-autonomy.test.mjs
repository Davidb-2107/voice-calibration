import { strictEqual, match, doesNotMatch } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

test("package identity is detached from CapCut", () => {
  strictEqual(packageJson.name, "voice-calibration");
  strictEqual(packageJson.bin?.["voice-calibration"], "dist/calibration-cli.js");
  strictEqual(packageJson.bin?.["capcut-david"], undefined);
  doesNotMatch(packageJson.description, /CapCut|JianYing|psycho-build/i);
  doesNotMatch(readFileSync(resolve(root, "src/calibration/bridge.ts"), "utf8"), /capcut/i);
  match(readFileSync(resolve(root, "src/calibration/local-store.ts"), "utf8"), /\.voice-calibration/);
});

test("standalone CLI exposes only the calibration surface", () => {
  const result = spawnSync(process.execPath, [resolve(root, "dist/calibration-cli.js"), "--help"], {
    encoding: "utf8",
    cwd: root,
  });
  strictEqual(result.status, 0, result.stderr);
  match(result.stdout, /voice-calibration/);
  match(result.stdout, /--open/);
  match(result.stdout, /--workspace-id/);
  match(result.stdout, /--env-file/);
  match(result.stdout, /--wpm-path/);
  doesNotMatch(result.stdout, /capcut-david|psycho-build/i);
});

test("CLI validates named workspace configuration and flag values", () => {
  const cli = resolve(root, "dist/calibration-cli.js");
  for (const args of [
    ["--workspace-id", "workspace-a"],
    ["--workspace-id", "Bad!"],
    ["--workspace-id"], ["--env-file"], ["--wpm-path"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: root });
    strictEqual(result.status, 1, `${args.join(" ")}: ${result.stdout}`);
    match(result.stderr, /workspace|credential|WPM|requires a value/i);
  }
});

test("CLI serves a configured workspace and its selected WPM summary", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "calibration-cli-"));
  const secret = "cli-smoke-secret";
  const envFile = join(temp, "instance.env");
  const wpmPath = join(temp, "source.json");
  writeFileSync(envFile, `ELEVENLABS_API_KEY=${secret}\n`);
  writeFileSync(wpmPath, JSON.stringify({ "voice-cli": { observed_runs: [{ postproc: "raw", verified: true, words: 10, duration_s: 5 }] } }));
  const child = spawn(process.execPath, [resolve(root, "dist/calibration-cli.js"),
    "--workspace-id", "workspace-cli", "--env-file", envFile, "--wpm-path", wpmPath,
    "--data-dir", join(temp, "data")], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise((resolveClose) => child.once("close", resolveClose));
      child.kill("SIGTERM");
      await closed;
    }
    rmSync(temp, { recursive: true, force: true });
  });
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`CLI did not start: ${stderr}`)), 10_000);
    const inspect = () => {
      const found = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) { clearTimeout(timer); resolveUrl(found[0]); }
    };
    child.stdout.on("data", inspect);
    child.once("close", (code) => { clearTimeout(timer); rejectUrl(new Error(`CLI exited ${code}: ${stderr}`)); });
    inspect();
  });
  const [bootstrapResponse, htmlResponse, clientResponse, corpusResponse] = await Promise.all([
    fetch(`${url}/api/v1/bootstrap`), fetch(`${url}/calibration.html`),
    fetch(`${url}/calibration-client.js`), fetch(`${url}/api/v1/corpus`),
  ]);
  for (const response of [bootstrapResponse, htmlResponse, clientResponse, corpusResponse]) strictEqual(response.status, 200);
  const bootstrap = await bootstrapResponse.json();
  strictEqual(bootstrap.config.configured, true);
  strictEqual(bootstrap.observationSummary.sourceAvailable, true);
  strictEqual(bootstrap.observationSummary.voices[0].voiceRef, "voice-cli");
  match(await htmlResponse.text(), /calibration-client\.js/);
  match(await clientResponse.text(), /api\/v1/);
  const corpus = await corpusResponse.json();
  strictEqual(corpus.draft.workspaceId, "workspace-cli");
  doesNotMatch(`${stdout}${stderr}${JSON.stringify(bootstrap)}`, new RegExp(secret));
});
