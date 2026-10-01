import { existsSync, mkdirSync, statSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deepStrictEqual, rejects, strictEqual, match } from "node:assert";
import { test } from "node:test";

import { createLocalStore } from "../dist/calibration/local-store.js";

const runFixture = {
  id: "run-1",
  workspaceId: "local-default",
  status: "draft",
  idempotencyKey: "run-1",
  request: {
    contractDigest: "contract",
    coreDigest: "core",
    corpusVersionId: "version",
    corpusDigest: "corpus",
    voiceRef: "voice-1",
    params: { mode: "precision" },
    postproc: "cut",
  },
  requestDigest: "digest",
  approval: null,
  reportId: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

test("workspaces partition every local resource", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createLocalStore(root);
  const refs = {};
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    const draft = await store.corpus.getDraft(workspaceId);
    const saved = await store.corpus.saveDraft(workspaceId, {
      ...draft, items: [{ id: "t1", order: 0, text: workspaceId }],
    }, draft.revision);
    const version = await store.corpus.publishDraft(workspaceId, saved.revision);
    const run = { ...runFixture, workspaceId, status: "approved", approval: {
      approvedAt: "2026-09-02T10:00:00Z", expiresAt: "2026-09-02T10:15:00Z", consumedAt: null,
    } };
    await store.runs.create(run);
    refs[workspaceId] = await store.artifacts.put(workspaceId, run.id, "report.json", Buffer.from(workspaceId));
    await store.profiles.publish({
      id: "profile-1", workspaceId, voiceRef: "voice-1", wpmSnapshot: 148,
      wpmAuthority: "python-voice-wpm", canonicalRef: "python://wpm", sourceRunId: run.id,
      corpusVersionId: version.id, reportId: refs[workspaceId], publishedAt: run.createdAt,
    });
  }
  const reloaded = createLocalStore(root);
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    strictEqual((await reloaded.runs.get(workspaceId, "run-1")).workspaceId, workspaceId);
    strictEqual((await reloaded.runs.list(workspaceId)).length, 1);
    strictEqual((await reloaded.corpus.getActiveVersion(workspaceId)).items[0].text, workspaceId);
    strictEqual((await reloaded.profiles.list(workspaceId))[0].workspaceId, workspaceId);
    strictEqual(Buffer.from(await reloaded.artifacts.get(workspaceId, refs[workspaceId])).toString(), workspaceId);
  }
  await rejects(reloaded.artifacts.get("workspace-a", refs["workspace-b"]), /invalid artifact reference/);
  await reloaded.runs.consumeApproval("workspace-a", "run-1", "2026-09-02T10:01:00Z");
  await reloaded.runs.recoverRunning("workspace-a", "run-1", "2026-09-02T10:02:00Z");
  strictEqual((await reloaded.runs.get("workspace-a", "run-1")).status, "execution_unknown");
  strictEqual((await reloaded.runs.get("workspace-b", "run-1")).status, "approved");
});

function makeStore() {
  return createLocalStore(mkdtempSync(join(tmpdir(), "calibration-")));
}

test("noncanonical workspace is rejected before storage IO", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "workspace-validation-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "not-created");
  const store = createLocalStore(root);
  await rejects(store.corpus.getDraft("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(store.runs.create({ ...runFixture, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  await rejects(store.runs.save({ ...runFixture, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  await rejects(store.profiles.publish({ workspaceId: "WORKSPACE-A", id: "p" }), /invalid workspaceId/);
  await rejects(store.runs.list("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(store.runs.get("WORKSPACE-A", "run-1"), /invalid workspaceId/);
  await rejects(store.runs.recoverRunning("WORKSPACE-A", "run-1", runFixture.createdAt), /invalid workspaceId/);
  await rejects(store.runs.consumeApproval("WORKSPACE-A", "run-1", runFixture.createdAt), /invalid workspaceId/);
  await rejects(store.artifacts.put("WORKSPACE-A", "run-1", "report.json", new Uint8Array()), /invalid workspaceId/);
  await rejects(store.artifacts.get("WORKSPACE-A", "report.json"), /invalid workspaceId/);
  await rejects(store.corpus.publishDraft("WORKSPACE-A", 0), /invalid workspaceId/);
  await rejects(store.corpus.saveDraft("WORKSPACE-A", { workspaceId: "WORKSPACE-A", items: [] }, 0), /invalid workspaceId/);
  await rejects(store.corpus.saveDraft("workspace-a", { workspaceId: "WORKSPACE-A", items: [] }, 0), /invalid workspaceId/);
  await rejects(store.corpus.saveDraft("workspace-a", { workspaceId: "workspace-b", items: [] }, 0), /draft workspace mismatch/);
  strictEqual(existsSync(root), false);
});

test("draft save uses revision and rejects stale writers", async () => {
  const store = makeStore();
  const first = await store.corpus.getDraft("local-default");
  const saved = await store.corpus.saveDraft(
    "local-default",
    { ...first, items: [{ id: "t1", order: 0, text: "Bonjour." }] },
    first.revision,
  );
  strictEqual(saved.revision, first.revision + 1);
  await rejects(
    store.corpus.saveDraft("local-default", { ...saved, items: [] }, first.revision),
    /revision conflict/,
  );
});

test("separate store instances serialize draft writers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-"));
  const firstStore = createLocalStore(dataDir);
  const secondStore = createLocalStore(dataDir);
  const first = await firstStore.corpus.getDraft("local-default");
  const results = await Promise.allSettled([
    firstStore.corpus.saveDraft(
      "local-default",
      { ...first, items: [{ id: "t1", order: 0, text: "Un." }] },
      first.revision,
    ),
    secondStore.corpus.saveDraft(
      "local-default",
      { ...first, items: [{ id: "t2", order: 0, text: "Deux." }] },
      first.revision,
    ),
  ]);
  strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
  strictEqual(results.filter((result) => result.status === "rejected")[0].reason.message, "revision conflict");
});

test("lock timeout is configurable and fails closed for a held corpus lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-"));
  const draftPath = join(dataDir, "workspaces", "local-default", "corpus", "draft.json");
  const lockPath = `${draftPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquiredAt: "2026-09-02T00:00:00.000Z" }));

  const store = createLocalStore(dataDir, { lockTimeoutMs: 20 });
  await rejects(
    store.corpus.saveDraft("local-default", { workspaceId: "local-default", revision: 0, items: [] }, 0),
    /lock timeout/,
  );
});

test("run create and save are protected by the same on-disk lock", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-"));
  const runPath = join(dataDir, "workspaces", "local-default", "runs", "run-1.json");
  const lockPath = `${runPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquiredAt: "2026-09-02T00:00:00.000Z" }));

  const store = createLocalStore(dataDir, { lockTimeoutMs: 20 });
  await rejects(store.runs.create(runFixture), /lock timeout/);
  rmSync(lockPath, { force: true });
  await store.runs.create(runFixture);
  writeFileSync(lockPath, JSON.stringify({ pid: 99999, acquiredAt: "2026-09-02T00:00:00.000Z" }));
  await rejects(store.runs.save({ ...runFixture, updatedAt: "2026-09-02T00:01:00.000Z" }), /lock timeout/);
});

test("publishing creates an immutable active version", async () => {
  const store = makeStore();
  const first = await store.corpus.getDraft("local-default");
  const saved = await store.corpus.saveDraft(
    "local-default",
    { ...first, items: [{ id: "t1", order: 0, text: "Bonjour." }] },
    first.revision,
  );
  const version = await store.corpus.publishDraft("local-default", saved.revision);
  strictEqual(version.status, "active");
  const edited = await store.corpus.saveDraft(
    "local-default",
    { ...saved, items: [{ id: "t1", order: 0, text: "Au revoir." }] },
    saved.revision,
  );
  strictEqual((await store.corpus.getActiveVersion("local-default")).items[0].text, "Bonjour.");
  strictEqual(edited.revision, saved.revision + 1);
  strictEqual((await store.corpus.listVersions("local-default"))[0].status, "active");
});

test("publishing a second snapshot supersedes only the derived status", async () => {
  const store = makeStore();
  const first = await store.corpus.getDraft("local-default");
  const firstSaved = await store.corpus.saveDraft(
    "local-default",
    { ...first, items: [{ id: "t1", order: 0, text: "Un." }] },
    first.revision,
  );
  const firstVersion = await store.corpus.publishDraft("local-default", firstSaved.revision);
  const secondSaved = await store.corpus.saveDraft(
    "local-default",
    { ...firstSaved, items: [{ id: "t1", order: 0, text: "Deux." }] },
    firstSaved.revision,
  );
  await store.corpus.publishDraft("local-default", secondSaved.revision);
  const versions = await store.corpus.listVersions("local-default");
  strictEqual(versions.filter((version) => version.status === "active").length, 1);
  strictEqual(versions.find((version) => version.id === firstVersion.id).status, "superseded");
});

test("writes survive reload and use the expected layout", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "calibration-"));
  const store = createLocalStore(dataDir);
  await store.runs.save(runFixture);
  strictEqual(
    statSync(join(dataDir, "workspaces", "local-default", "runs", "run-1.json")).isFile(),
    true,
  );
  const reloaded = createLocalStore(dataDir);
  deepStrictEqual(await reloaded.runs.get("local-default", runFixture.id), runFixture);
  const ref = "workspaces/local-default/artifacts/run-1/report.json";
  mkdirSync(dirname(join(dataDir, ref)), { recursive: true });
  writeFileSync(join(dataDir, ref), JSON.stringify({ legacy: true }));
  await store.runs.save({ ...runFixture, reportId: ref });
  strictEqual((await reloaded.runs.get("local-default", runFixture.id)).reportId, ref);
  deepStrictEqual(JSON.parse(Buffer.from(await reloaded.artifacts.get("local-default", ref)).toString()), { legacy: true });
  await rejects(reloaded.artifacts.get("workspace-a", ref), /invalid artifact reference/);
});

test("artifacts round-trip and reject traversal", async () => {
  const store = makeStore();
  const ref = await store.artifacts.put("local-default", "run-1", "audio/sample.mp3", new Uint8Array([1, 2, 3]));
  match(ref, /^workspaces\/local-default\/artifacts\/run-1\/audio\/sample\.mp3$/);
  deepStrictEqual([...await store.artifacts.get("local-default", ref)], [1, 2, 3]);
  await rejects(store.artifacts.put("local-default", "run-1", "../secret", new Uint8Array([1])), /invalid artifact path/);
  await rejects(store.artifacts.get("local-default", "workspaces/local-default/runs/run-1.json"), /invalid artifact reference/);
});

test("artifact symlink checks stop at the artifact root and still reject links inside it", async () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const realParent = mkdtempSync(join(tmpdir(), "calibration-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "calibration-parent-"));
  const parentLink = join(linkParent, "data-link");
  symlinkSync(realParent, parentLink, linkType);

  const dataDir = join(parentLink, "calibration");
  const store = createLocalStore(dataDir);
  const ref = await store.artifacts.put("local-default", "run-1", "audio.mp3", new Uint8Array([7]));
  deepStrictEqual([...await store.artifacts.get("local-default", ref)], [7]);

  const internalLink = join(dataDir, "workspaces", "local-default", "artifacts", "run-2");
  mkdirSync(dirname(internalLink), { recursive: true });
  symlinkSync(realParent, internalLink, linkType);
  await rejects(store.artifacts.put("local-default", "run-2", "audio.mp3", new Uint8Array([8])), /symbolic links/);
});
