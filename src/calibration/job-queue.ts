import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertWorkspaceId, type CalibrationRun } from "./domain.js";
import type { CalibrationEngine } from "./engine-manager.js";
import { assertNoSymlinkWithin, withFileLock, writeJson } from "./local-store.js";
import { ConflictError } from "./ports.js";

export interface JobIdentity {
  userId: string;
  tenantId: string;
  workspaceId: string;
}
export interface CalibrationJob extends JobIdentity {
  runId: string;
  requestDigest: string;
  configurationIdentity: string | null;
  status: "queued" | "awaiting_authentication" | "running" | "finished" | "execution_unknown";
  updatedAt: string;
}
type Authorization = () => Promise<CalibrationEngine>;

// shortcut: one supervised API process owns the queue, use a broker before scaling API replicas.
export class CalibrationJobQueue {
  private active = 0;
  private activeWorkspaces = new Set<string>();
  private closed = false;
  private pending: { job: CalibrationJob; authorize: Authorization }[] = [];
  private tasks = new Set<Promise<void>>();
  private serial: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private closing?: Promise<void>;
  private constructor(
    private readonly root: string,
    readonly maxConcurrentJobs: number,
  ) {}

  static async open(dataDir: string, maxConcurrentJobs = 4): Promise<CalibrationJobQueue> {
    if (typeof dataDir !== "string" || !dataDir.trim()) throw new TypeError("Explicit queue directory required");
    if (!Number.isSafeInteger(maxConcurrentJobs) || maxConcurrentJobs < 1)
      throw new TypeError("maxConcurrentJobs must be a positive integer");
    const root = resolve(dataDir);
    await assertNoSymlinkWithin(root, root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Never steal a lock: a supervisor must confirm process/engine termination after a crash.
    const owner = await open(join(root, "owner.lock"), "wx", 0o600);
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid }));
      await owner.sync();
    } finally {
      await owner.close();
    }
    const queue = new CalibrationJobQueue(root, maxConcurrentJobs);
    try {
      for (const name of await readdir(root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const job = await queue.read(join(root, name));
        if (job.status === "running") job.status = "execution_unknown";
        else if (job.status === "queued") job.status = "awaiting_authentication";
        await queue.save(job);
      }
      return queue;
    } catch (error) {
      await rm(join(root, "owner.lock"));
      throw error;
    }
  }

  private path(workspaceId: string, runId: string): string {
    assertWorkspaceId(workspaceId);
    if (typeof runId !== "string" || !runId || runId.length > 512) throw new TypeError("Invalid run ID");
    return join(
      this.root,
      `${createHash("sha256")
        .update(JSON.stringify([workspaceId, runId]))
        .digest("hex")}.json`,
    );
  }
  private async read(path: string): Promise<CalibrationJob> {
    await assertNoSymlinkWithin(this.root, path);
    // Windows cannot replace a file held open by a concurrent status read.
    return withFileLock(
      path,
      async () => {
        const job: CalibrationJob = JSON.parse(await readFile(path, "utf8"));
        if (
          !job ||
          this.path(job.workspaceId, job.runId) !== path ||
          typeof job.userId !== "string" ||
          !job.userId ||
          typeof job.tenantId !== "string" ||
          !job.tenantId ||
          typeof job.requestDigest !== "string" ||
          (job.configurationIdentity !== null && typeof job.configurationIdentity !== "string") ||
          !["queued", "awaiting_authentication", "running", "finished", "execution_unknown"].includes(job.status)
        )
          throw new Error("Invalid durable job");
        return job;
      },
      30_000,
    );
  }
  private async save(job: CalibrationJob): Promise<void> {
    const path = this.path(job.workspaceId, job.runId);
    await assertNoSymlinkWithin(this.root, path);
    await withFileLock(path, () => writeJson(path, { ...job, updatedAt: new Date().toISOString() }), 30_000);
  }
  async get(identity: JobIdentity, runId: string): Promise<CalibrationJob | null> {
    if (this.failure) throw new ConflictError("Queue storage failure; supervision required");
    try {
      const job = await this.read(this.path(identity.workspaceId, runId));
      if (job.tenantId !== identity.tenantId || job.userId !== identity.userId) return null;
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  enqueue(identity: JobIdentity, run: CalibrationRun, authorize: Authorization): Promise<CalibrationJob> {
    const operation = this.serial.then(async () => {
      if (this.closed) throw new ConflictError("Queue is closed");
      if (this.failure) throw new ConflictError("Queue storage failure; supervision required");
      assertWorkspaceId(identity.tenantId);
      if (typeof identity.userId !== "string" || !identity.userId) throw new TypeError("Verified user required");
      if (run.workspaceId !== identity.workspaceId) throw new ConflictError("Job workspace mismatch");
      const path = this.path(identity.workspaceId, run.id);
      let previous: CalibrationJob | null = null;
      try {
        previous = await this.read(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        previous &&
        (previous.userId !== identity.userId ||
          previous.tenantId !== identity.tenantId ||
          previous.requestDigest !== run.requestDigest ||
          previous.configurationIdentity !== (run.configurationIdentity ?? null))
      )
        throw new ConflictError("Job identity mismatch");
      if (previous && previous.status !== "awaiting_authentication") return previous;
      if (
        run.status !== "approved" ||
        !run.approval ||
        run.approval.consumedAt ||
        !Number.isFinite(Date.parse(run.approval.expiresAt)) ||
        Date.parse(run.approval.expiresAt) <= Date.now()
      )
        throw new ConflictError("Unexpired approval required before queue admission");
      const job: CalibrationJob = {
        userId: identity.userId,
        tenantId: identity.tenantId,
        workspaceId: identity.workspaceId,
        runId: run.id,
        requestDigest: run.requestDigest,
        configurationIdentity: run.configurationIdentity ?? null,
        status: "queued",
        updatedAt: new Date().toISOString(),
      };
      try {
        await this.save(job);
      } catch (error) {
        this.failure = error;
        throw error;
      }
      this.pending.push({ job, authorize });
      this.pump();
      return { ...job };
    });
    this.serial = operation.catch(() => undefined);
    return operation;
  }
  private pump(): void {
    while (!this.closed && !this.failure && this.active < this.maxConcurrentJobs && this.pending.length) {
      const index = this.pending.findIndex(({ job }) => !this.activeWorkspaces.has(job.workspaceId));
      if (index < 0) break;
      const [item] = this.pending.splice(index, 1);
      this.active++;
      this.activeWorkspaces.add(item.job.workspaceId);
      const task = this.dispatch(item.job, item.authorize)
        .catch((error) => {
          // A persistence failure leaves the durable running marker; never retry execution.
          this.failure = error;
        })
        .finally(() => {
          this.active--;
          this.activeWorkspaces.delete(item.job.workspaceId);
          this.tasks.delete(task);
          this.pump();
        });
      this.tasks.add(task);
    }
  }
  private async dispatch(job: CalibrationJob, authorize: Authorization): Promise<void> {
    let engine: CalibrationEngine;
    try {
      engine = await authorize();
      const current = await engine.getRun(job.workspaceId, job.runId);
      if (
        !current ||
        current.requestDigest !== job.requestDigest ||
        (current.configurationIdentity ?? null) !== job.configurationIdentity
      )
        throw new ConflictError("Queued run changed");
    } catch {
      job.status = "awaiting_authentication";
      await this.save(job);
      return;
    }
    job.status = "running";
    await this.save(job);
    try {
      const result = await engine.execute(job.workspaceId, job.runId);
      job.status = result.status === "execution_unknown" ? "execution_unknown" : "finished";
    } catch {
      job.status = "execution_unknown";
    }
    await this.save(job);
  }
  close(beforeRelease?: () => Promise<void>): Promise<void> {
    this.closing ??= this.shutdown(beforeRelease);
    return this.closing;
  }
  private async shutdown(beforeRelease?: () => Promise<void>): Promise<void> {
    this.closed = true;
    await this.serial;
    await Promise.all([...this.tasks]);
    for (const { job } of this.pending) {
      job.status = "awaiting_authentication";
      await this.save(job);
    }
    this.pending = [];
    if (this.failure) throw new Error("Queue storage failure; owner lock retained for supervision");
    // Keep ownership until the supervisor confirms all workspace engines have exited.
    await beforeRelease?.();
    await rm(join(this.root, "owner.lock"));
  }
}
