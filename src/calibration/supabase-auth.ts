import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { type CalibrationEngine, EngineManager, type EngineManagerOptions } from "./engine-manager.js";
import { assertWorkspaceId } from "./domain.js";
import { type CalibrationUiOptions, createVoiceCalibrationApplication } from "./entrypoint.js";
import { type CalibrationUiHandle, HttpError, isLoopbackHost, startCalibrationUi } from "./http-server.js";
import { canonicalLocalPath } from "./local-store.js";
import { CalibrationJobQueue } from "./job-queue.js";
import { DockerMcpStdioTransport } from "./docker-transport.js";

export interface SupabaseAuthOptions {
  url: string;
  publishableKey: string;
  fetch?: typeof fetch;
}

export type TenantWorkspaceOptions = Required<Pick<CalibrationUiOptions,
  "tenantId" | "workspaceId" | "dataDir" | "stateDir" | "wpmPath" | "credentials">> &
  Pick<CalibrationUiOptions, "mcpTransport">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

// The operator registry owns filesystem paths and secrets; Supabase rows own membership only.
export function validateTenantWorkspaces(workspaces: readonly TenantWorkspaceOptions[]): TenantWorkspaceOptions[] {
  if (workspaces.length === 0) throw new Error("At least one tenant workspace is required");
  const fixed = workspaces.map((workspace) => {
    assertWorkspaceId(workspace.tenantId);
    assertWorkspaceId(workspace.workspaceId);
    if (workspace.workspaceId === "local-default") throw new Error("Tenant requires a named workspace");
    for (const field of ["dataDir", "stateDir", "wpmPath"] as const)
      if (typeof workspace[field] !== "string" || !workspace[field].trim()) throw new Error(`Explicit ${field} required`);
    if (!workspace.credentials) throw new Error("Explicit credentials required");
    return { ...workspace, dataDir: canonicalLocalPath(workspace.dataDir),
      stateDir: canonicalLocalPath(workspace.stateDir), wpmPath: canonicalLocalPath(workspace.wpmPath),
      credentials: { ...workspace.credentials,
        ...(workspace.credentials.env ? { env: { ...workspace.credentials.env } } : {}) } };
  });
  const resources = fixed.map((workspace) => {
    const corpusDir = dirname(workspace.wpmPath);
    // Reserve the corpus directory, including journals, locks and atomic-write temporary files.
    for (const sidecar of [`${workspace.wpmPath}.lock`, `${workspace.wpmPath}.runs.jsonl`,
      `${workspace.wpmPath}.runs.jsonl.lock`, join(corpusDir, "runs.jsonl"), join(corpusDir, "runs.jsonl.lock")])
      if (!contains(corpusDir, canonicalLocalPath(sidecar))) throw new Error("Corpus sidecar escapes private directory");
    return [workspace.dataDir, workspace.stateDir, corpusDir];
  });
  for (let index = 0; index < fixed.length; index++) {
    const current = fixed[index];
    for (const [otherIndex, other] of fixed.slice(0, index).entries()) {
      if (current.workspaceId === other.workspaceId) throw new Error("Workspace has multiple registrations");
      for (const a of resources[index])
        for (const b of resources[otherIndex])
          if (contains(a, b) || contains(b, a)) throw new Error("Tenant workspace paths overlap");
    }
  }
  return fixed;
}

export function createSupabaseWorkspaceResolver(
  options: SupabaseAuthOptions,
  workspaces: readonly { tenantId: string; workspaceId: string;
    application: CalibrationEngine | (() => Promise<CalibrationEngine>) }[],
): (request: IncomingMessage) => Promise<{ application: CalibrationEngine; workspaceId: string;
  identity: { userId: string; tenantId: string } }> {
  const url = new URL(options.url);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/u.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    throw new Error("A hosted Supabase project URL is required");
  // V1 deliberately requires the new public key; elevated keys must never bypass RLS here.
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/u.test(options.publishableKey))
    throw new Error("A Supabase publishable key is required (no secret/service-role key)");
  const publicKey = options.publishableKey;
  const requestFetch = options.fetch ?? fetch;
  const registry = new Map<string, { tenantId: string;
    application: CalibrationEngine | (() => Promise<CalibrationEngine>) }>();
  for (const item of workspaces) {
    assertWorkspaceId(item.tenantId);
    assertWorkspaceId(item.workspaceId);
    if (registry.has(item.workspaceId)) throw new Error("Duplicate workspace registration");
    registry.set(item.workspaceId, { tenantId: item.tenantId, application: item.application });
  }
  async function get(path: string, token: string): Promise<unknown> {
    try {
      const response = await requestFetch(new URL(path, url), { headers: { apikey: publicKey,
        authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000), redirect: "error" });
      if (response.status === 401 || response.status === 403)
        throw new HttpError(401, "unauthenticated", "Supabase authentication required");
      if (!response.ok) throw new HttpError(503, "auth_unavailable", "Supabase authorization unavailable");
      return await response.json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "auth_unavailable", "Supabase authorization unavailable");
    }
  }
  return async (request) => {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string" && /^Bearer ([^\s,]+)$/iu.exec(authorization);
    if (!match) throw new HttpError(401, "unauthenticated", "Bearer session required");
    const token = match[1];
    const user = await get("/auth/v1/user", token);
    if (!record(user) || typeof user.id !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(user.id) ||
        user.is_anonymous === true || user.role !== "authenticated" ||
        typeof user.email_confirmed_at !== "string" || !user.email_confirmed_at)
      throw new HttpError(401, "unauthenticated", "Confirmed non-anonymous account required");
    // No cache: revoking the DB membership takes effect on the next request, even with a valid JWT.
    const rows = await get("/rest/v1/calibration_workspaces?select=id,tenant_id&limit=2", token);
    if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0]) ||
        typeof rows[0].id !== "string" || typeof rows[0].tenant_id !== "string")
      throw new HttpError(403, "workspace_forbidden", "Exactly one authorized workspace required");
    const selected = registry.get(rows[0].id);
    if (!selected || selected.tenantId !== rows[0].tenant_id)
      throw new HttpError(403, "workspace_forbidden", "Workspace is not provisioned for this tenant");
    const application = typeof selected.application === "function" ? await selected.application() : selected.application;
    return { application, workspaceId: rows[0].id,
      identity: { userId: user.id, tenantId: selected.tenantId } };
  };
}

export async function startSupabaseCalibrationApi(options: {
  supabase: SupabaseAuthOptions;
  workspaces: readonly TenantWorkspaceOptions[];
  host?: string;
  port?: number;
  publicOrigin?: string;
  allowUnisolatedLocal?: boolean;
  jobQueue?: { dataDir: string; maxConcurrentJobs?: number };
} & EngineManagerOptions): Promise<CalibrationUiHandle> {
  const host = options.host ?? "127.0.0.1";
  if (options.publicOrigin) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin)
      throw new Error("publicOrigin must be an HTTPS origin");
  } else if (!isLoopbackHost(host)) throw new Error("Network API requires an explicit HTTPS publicOrigin");
  const fixed = validateTenantWorkspaces(options.workspaces);
  for (const workspace of fixed) {
    const transport = workspace.mcpTransport;
    if (!(transport instanceof DockerMcpStdioTransport) &&
        !(options.allowUnisolatedLocal === true && !options.publicOrigin && isLoopbackHost(host)))
      throw new Error("API requires isolated Docker engines; unisolated local development must be explicit");
    if (transport instanceof DockerMcpStdioTransport) {
      const binding = transport.binding;
      if (binding.tenantId !== workspace.tenantId || binding.workspaceId !== workspace.workspaceId ||
          binding.wpmPath !== workspace.wpmPath || binding.stateDir !== workspace.stateDir ||
          binding.uiWorkspaceDir !== canonicalLocalPath(join(workspace.dataDir, "workspaces", workspace.workspaceId)))
        throw new Error("Isolated engine binding mismatch");
      for (const other of fixed.filter((item) => item.workspaceId !== workspace.workspaceId))
        for (const path of [other.dataDir, other.stateDir, dirname(other.wpmPath)])
          if (contains(transport.hostRoot, path) || contains(path, transport.hostRoot))
            throw new Error("Engine mount overlaps another workspace");
    }
  }
  if (options.jobQueue) {
    if (typeof options.jobQueue.dataDir !== "string" || !options.jobQueue.dataDir.trim())
      throw new Error("Explicit queue directory required");
    const queueDir = canonicalLocalPath(options.jobQueue.dataDir);
    for (const workspace of fixed)
      for (const path of [workspace.dataDir, workspace.stateDir, dirname(workspace.wpmPath)])
        if (contains(queueDir, path) || contains(path, queueDir))
          throw new Error("Queue directory overlaps workspace resources");
  }
  // Validate auth configuration before any credentials, files or child processes are opened.
  createSupabaseWorkspaceResolver(options.supabase, []);
  const engines = new EngineManager(fixed.map((workspace) => ({ workspaceId: workspace.workspaceId,
    create: () => createVoiceCalibrationApplication(workspace) })), {
    maxConcurrentStarts: options.maxConcurrentStarts, idleTimeoutMs: options.idleTimeoutMs,
  });
  const applications = fixed.map(({ tenantId, workspaceId }) => ({ tenantId, workspaceId,
    application: async () => {
      await engines.start(workspaceId);
      return engines.application(workspaceId);
    } }));
  const queue = options.jobQueue ? await CalibrationJobQueue.open(options.jobQueue.dataDir,
    options.jobQueue.maxConcurrentJobs) : undefined;
  const closeApplications = () => queue ? queue.close(() => engines.close()) : engines.close();
  try {
    return await startCalibrationUi({ host, port: options.port ?? 0, allowNetwork: true,
      publicOrigin: options.publicOrigin, closeApplications, jobQueue: queue,
      resolveApplication: createSupabaseWorkspaceResolver(options.supabase, applications) });
  } catch (error) { await closeApplications(); throw error; }
}
