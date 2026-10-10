import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { CalibrationJobQueue } from "../../dist/calibration/job-queue.js";

const root = process.argv[2];
const queue = await CalibrationJobQueue.open(root, 1);
const run = (i) => ({ id: `run-${i}`, workspaceId: `workspace-${i}`, status: "approved", requestDigest: `digest-${i}`,
  configurationIdentity: `config-${i}`, approval: { consumedAt: null, expiresAt: new Date(Date.now() + 600_000).toISOString() } });
const identity = (i) => ({ userId: `user-${i}`, tenantId: `tenant-${i}`, workspaceId: `workspace-${i}` });
let started;
const executing = new Promise((resolve) => { started = resolve; });
await queue.enqueue(identity(0), run(0), async () => ({ getRun: async () => run(0), execute: async () => {
  await appendFile(join(root, "provider-receipts.txt"), "simulated-response\n");
  started();
  await new Promise(() => {});
} }));
await executing;
await queue.enqueue(identity(1), run(1), async () => { throw new Error("must remain queued"); });
process.send({ ready: true });
setInterval(() => {}, 1000);
