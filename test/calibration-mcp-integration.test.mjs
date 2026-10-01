import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { once } from "node:events";

import { NodeMcpStdioTransport } from "../dist/calibration/bridge.js";
import { startVoiceCalibrationUi } from "../dist/calibration/entrypoint.js";

test("real HTTP/MCP named instances isolate proposals, enforce ownership and resume", {
  skip: !process.env.VOICE_CALIBRATION_TEST_PYTHON || !process.env.VOICE_CALIBRATION_TEST_MCP_ROOT,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-real-mcp-"));
  const dataDir = join(root, "ui");
  const stateDir = join(root, "state");
  const handles = [];
  const transports = new Map();
  const previousPythonPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = process.env.VOICE_CALIBRATION_TEST_MCP_ROOT;
  t.after(async () => {
    for (const handle of handles) await handle.close();
    if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = previousPythonPath;
    rmSync(root, { recursive: true, force: true });
  });
  async function launch(workspaceId, selectedStateDir = stateDir) {
    const wpmPath = join(root, `${workspaceId}.json`);
    if (!existsSync(wpmPath)) writeFileSync(wpmPath, "{}");
    const transport = new NodeMcpStdioTransport(process.env.VOICE_CALIBRATION_TEST_PYTHON,
        ["-B", "-m", "voice_calibration.mcp_server.server"], undefined, {
          workspaceId, stateDir: selectedStateDir, wpmPath,
          uiWorkspaceDir: join(dataDir, "workspaces", workspaceId),
        });
    const ui = await startVoiceCalibrationUi({
      workspaceId, dataDir, stateDir: selectedStateDir, wpmPath,
      credentials: { env: { ELEVENLABS_API_KEY: `fake-${workspaceId}` } }, mcpTransport: transport,
    });
    transports.set(workspaceId, transport);
    return ui;
  }
  const a = await launch("staging");
  handles.push(a);
  const b = await launch("production");
  handles.push(b);
  const runs = [];
  for (const [ui, workspaceId] of [[a, "staging"], [b, "production"]]) {
    const bootstrap = await (await fetch(`${ui.url}/api/v1/bootstrap`)).json();
    const headers = { "content-type": "application/json", "x-calibration-nonce": bootstrap.sessionNonce };
    const draft = await fetch(`${ui.url}/api/v1/corpus/draft`);
    const saved = await fetch(`${ui.url}/api/v1/corpus/draft`, {
      method: "PUT", headers: { ...headers, "if-match": draft.headers.get("etag") },
      body: JSON.stringify({ ...(await draft.json()), items: [
        { id: "sample", order: 0, text: `Bonjour au workspace ${workspaceId}.` },
      ] }),
    });
    strictEqual(saved.status, 200);
    const published = await fetch(`${ui.url}/api/v1/corpus/versions`, {
      method: "POST", headers, body: JSON.stringify({ expectedRevision: (await saved.json()).revision }),
    });
    strictEqual(published.status, 201);
    const response = await fetch(`${ui.url}/api/v1/calibration-runs/dry-run`, {
      method: "POST", headers, body: JSON.stringify({ voiceRef: "test-voice", postproc: "cut", params: {
        model_id: "eleven_v3", voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0, use_speaker_boost: true },
        mode: "precision", language: "fr", runs: 5,
      } }),
    });
    const run = await response.json();
    strictEqual(response.status, 201, JSON.stringify(run));
    strictEqual(run.workspaceId, workspaceId);
    strictEqual(existsSync(join(stateDir, "gate", "workspaces", workspaceId, "runs", `${run.id}.json`)), true);
    const approved = await fetch(`${ui.url}/api/v1/calibration-runs/${run.id}/approve`, {
      method: "POST", headers, body: JSON.stringify({ requestDigest: run.requestDigest }),
    });
    strictEqual(approved.status, 200);
    strictEqual((await approved.json()).status, "approved");
    deepStrictEqual(JSON.parse(readFileSync(join(root, `${workspaceId}.json`), "utf8")), {});
    runs.push(run);
  }
  strictEqual((await fetch(`${a.url}/api/v1/calibration-runs/${runs[1].id}`)).status, 404);
  await rejects(launch("staging"));
  await rejects(launch("staging", join(root, "other-state")));
  strictEqual((await (await fetch(`${a.url}/api/v1/calibration-runs/${runs[0].id}`)).json()).status, "approved");
  await a.close();
  handles.splice(handles.indexOf(a), 1);
  const resumed = await launch("staging");
  handles.push(resumed);
  strictEqual((await (await fetch(`${resumed.url}/api/v1/calibration-runs/${runs[0].id}`)).json()).status, "approved");
  const closing = once(resumed.server, "close");
  const crashedTransport = transports.get("staging");
  crashedTransport.child.kill();
  await closing;
  await rejects(fetch(`${resumed.url}/api/v1/corpus`));
  await rejects(crashedTransport.schema("fake-staging", 5000), /MCP process exited/);
  const replacement = await launch("staging");
  handles.push(replacement);
  strictEqual((await fetch(`${replacement.url}/api/v1/bootstrap`)).status, 200);
});
