import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { assertWorkspaceId, type ResolvedCalibrationRequest } from "./domain.js";

export interface ConfigStatus {
  configured: boolean;
}
export interface CredentialProvider {
  status(): Promise<ConfigStatus>;
  forRun(): Promise<{ provider: string; secret: string }>;
  redact?(value: unknown): unknown;
}
export interface DryRunResult {
  accepted: boolean;
  plan: unknown[];
  raw: unknown;
  status?: string;
  runId?: string;
  workspaceId?: string;
  requestDigest?: string;
  proposal?: unknown;
  approval?: unknown;
}
export interface ExecutionResult {
  status: "succeeded" | "failed" | "unknown";
  metrics: Record<string, unknown>;
  artifacts: string[];
  raw: unknown;
  coreRun?: CoreRunRecord;
  error?: { code: string; message: string };
}
export interface PublicationResult {
  voiceAlias?: string;
  canonicalRef: string;
  wpm: number;
  runsPublished?: number;
}
export interface CoreRunRecord {
  runId: string;
  workspaceId: string;
  revision: number;
  status: string;
  context: Record<string, unknown>;
  request: Record<string, unknown>;
  requestDigest: string;
  proposal: unknown;
  approval: {
    approvedAt: string;
    expiresAt: string;
    consumedAt: string | null;
  } | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  raw: unknown;
}
export interface CanonicalProfilePort {
  ensurePublished(input: {
    voiceRef: string;
    wpm: number;
    runId: string;
    corpusVersionId: string;
    language?: "fr" | "en";
  }): Promise<{ canonicalRef: string }>;
  findPublished?(input: {
    voiceRef: string;
    language?: "fr" | "en";
  }): Promise<{ canonicalRef: string; wpm: number } | null>;
  getObservationSummary?(): Promise<ObservationSummary>;
}
export interface ObservationSummary {
  voices: Array<{
    voiceRef: string;
    total: number;
    raw: number;
    rawClean: number;
    trim: number;
    cut: number;
    other: number;
    unknown: number;
  }>;
  sourceAvailable: boolean;
}
export interface CalibrationBridge {
  prepareProject?(input: {
    workspaceId: string;
    identity: { userId: string; tenantId: string };
    operation: "create" | "inspect" | "select" | "readiness" | "predict" | "verify" | "produce"
      | `calibration-${"propose" | "inspect" | "approve" | "decline" | "execute" | "publish" | "reconcile"}`;
    payload: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  reusableProfiles?(input: {
    workspaceId: string;
    identity: { userId: string; tenantId: string };
    operation: "catalog" | "publish" | "revoke" | "source-read";
    target: string;
  }): Promise<Record<string, unknown>>;
  publishLiveProfile?(input: { workspaceId: string; runId: string }): Promise<Record<string, unknown>>;
  getLiveProfiles?(workspaceId: string): Promise<Record<string, unknown>>;
  recordTikTokObservation?(input: {
    workspaceId: string;
    profileId: string;
    observation: unknown;
  }): Promise<Record<string, unknown>>;
  onExit?(listener: () => void): void;
  getSchema(): Promise<unknown>;
  dryRun(input: { runId: string; request: ResolvedCalibrationRequest }): Promise<DryRunResult>;
  propose?(input: { workspaceId: string; request: ResolvedCalibrationRequest }): Promise<DryRunResult>;
  approve?(input: { workspaceId: string; runId: string; requestDigest: string }): Promise<CoreRunRecord>;
  getRun?(input: { workspaceId: string; runId: string }): Promise<CoreRunRecord>;
  publish?(input: { workspaceId: string; runId: string }): Promise<PublicationResult>;
  execute(input: {
    runId: string;
    idempotencyKey: string;
    snapshot: ResolvedCalibrationRequest;
    workspaceId?: string;
    coreRunId?: string;
  }): Promise<ExecutionResult>;
  reconcile(input: {
    runId: string;
    idempotencyKey: string;
    workspaceId?: string;
    coreRunId?: string;
  }): Promise<ExecutionResult | CoreRunRecord | { status: "unknown" }>;
  close?(): Promise<void>;
}

interface TransportResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}
interface TransportCall {
  response: unknown;
  emitted: boolean;
  stderr: string;
  toolError?: boolean;
  remoteError?: { code?: number; message?: string; data?: unknown };
}
export interface CalibrationTransport {
  readonly instanceStateDir?: string;
  onExit?(listener: () => void): void;
  schema(secret: string, timeoutMs: number): Promise<unknown>;
  call(args: Record<string, unknown>, secret: string, timeoutMs: number): Promise<TransportCall>;
  callTool?(name: string, args: Record<string, unknown>, secret: string, timeoutMs: number): Promise<TransportCall>;
  close(): Promise<void>;
}

class BridgeTransportError extends Error {
  constructor(
    message: string,
    readonly emitted: boolean,
    readonly stderr = "",
    readonly code = "MCP_TRANSPORT_ERROR",
  ) {
    super(message);
    this.name = "BridgeTransportError";
  }
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string") return secret ? value.split(secret).join("[REDACTED]") : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

function resultObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function unwrapToolResult(response: unknown): unknown {
  const result = resultObject(response);
  if ("structuredContent" in result) return result.structuredContent;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((item) => resultObject(item).type === "text");
    if (text && typeof resultObject(text).text === "string") {
      try {
        return JSON.parse(resultObject(text).text as string);
      } catch {
        return resultObject(text).text;
      }
    }
  }
  return response;
}

function makeRequest(snapshot: ResolvedCalibrationRequest, dryRun: boolean): Record<string, unknown> {
  const params = { ...snapshot.params };
  return {
    ...params,
    voice: snapshot.voiceRef,
    voice_id: params.voice_id ?? snapshot.voiceRef,
    corpus_key: params.corpus_key ?? snapshot.voiceRef,
    postproc: snapshot.postproc,
    dry_run: dryRun,
  };
}

function makeGateRequest(snapshot: ResolvedCalibrationRequest): Record<string, unknown> {
  const request = makeRequest(snapshot, false);
  delete request.dry_run;
  return request;
}

class NodeMcpStdioTransport implements CalibrationTransport {
  readonly instanceStateDir?: string;
  private exitListener?: () => void;
  private terminalError?: BridgeTransportError;
  private readonly boundInstance: boolean;
  private readonly launchEnv: NodeJS.ProcessEnv;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (response: TransportResponse) => void; reject: (error: Error) => void }
  >();
  private initialized: Promise<void> | null = null;
  private closing?: Promise<void>;
  private secret = "";

  constructor(
    private readonly command = "voice-calibration-mcp",
    private readonly args: string[] = [],
    private readonly cwd?: string,
    launch?: { tenantId?: string; wpmPath?: string; workspaceId?: string; stateDir?: string; uiWorkspaceDir?: string },
  ) {
    this.boundInstance = launch?.workspaceId !== undefined;
    this.launchEnv = this.boundInstance
      ? Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            [
              "PATH",
              "Path",
              "PATHEXT",
              "SystemRoot",
              "SYSTEMROOT",
              "WINDIR",
              "TEMP",
              "TMP",
              "HOME",
              "USERPROFILE",
              "APPDATA",
              "LOCALAPPDATA",
              "LANG",
              "LC_ALL",
              "PYTHONPATH",
              "PYTHONNOUSERSITE",
            ].includes(name),
          ),
        )
      : { ...process.env };
    if (launch !== undefined) {
      delete this.launchEnv.VOICE_WPM_PATH;
      delete this.launchEnv.VOICE_CALIBRATION_WORKSPACE_ID;
      delete this.launchEnv.VOICE_CALIBRATION_TENANT_ID;
      delete this.launchEnv.VOICE_CALIBRATION_UI_WORKSPACE_DIR;
      if (launch.wpmPath !== undefined) this.launchEnv.VOICE_WPM_PATH = launch.wpmPath;
      if (launch.workspaceId !== undefined) {
        assertWorkspaceId(launch.workspaceId);
        delete this.launchEnv.VOICE_CALIBRATION_GATE_DIR;
        delete this.launchEnv.VOICE_CALIBRATION_STATE_DIR;
        this.launchEnv.VOICE_CALIBRATION_WORKSPACE_ID = launch.workspaceId;
        if (launch.tenantId !== undefined) this.launchEnv.VOICE_CALIBRATION_TENANT_ID = launch.tenantId;
        if (launch.stateDir !== undefined) this.launchEnv.VOICE_CALIBRATION_STATE_DIR = launch.stateDir;
        if (launch.uiWorkspaceDir !== undefined)
          this.launchEnv.VOICE_CALIBRATION_UI_WORKSPACE_DIR = launch.uiWorkspaceDir;
      }
    }
  }

  private diagnostic(): string {
    return String(redact(this.stderrBuffer, this.secret));
  }

  protected ensureChild(secret = ""): ChildProcessWithoutNullStreams {
    if (this.closing) throw new BridgeTransportError("MCP process closing; restart calibration bridge", false);
    if (this.terminalError) throw this.terminalError;
    if (this.child) {
      if (secret && secret !== this.secret)
        throw new BridgeTransportError("credential changed; restart calibration bridge", false, this.diagnostic());
      if (secret) this.secret = secret;
      return this.child;
    }
    this.secret = secret;
    this.buffer = "";
    this.stderrBuffer = "";
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...this.launchEnv, ...(secret ? { ELEVENLABS_API_KEY: secret } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    child.on("error", (error) => this.failPending(new BridgeTransportError(error.message, false, this.diagnostic())));
    child.on("exit", (code, signal) => {
      const unexpected = this.child === child;
      if (this.child === child) this.child = null;
      if (this.initialized) this.initialized = null;
      const error = new BridgeTransportError(
        `MCP process exited (${code ?? signal ?? "unknown"})`,
        true,
        this.diagnostic(),
      );
      if (unexpected && this.boundInstance) this.terminalError = error;
      this.failPending(error);
      if (unexpected) this.exitListener?.();
    });
    return child;
  }

  protected async start(secret: string): Promise<void> {
    this.ensureChild(secret);
  }

  private consumeStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: TransportResponse & { id?: number };
      try {
        message = JSON.parse(line) as TransportResponse & { id?: number };
      } catch {
        this.failPending(new BridgeTransportError("malformed MCP JSON-RPC response", true, this.diagnostic()));
        continue;
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<TransportResponse> {
    const child = this.ensureChild(this.secret);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let emitted = false;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeTransportError(
            `MCP request timed out: ${method}`,
            emitted,
            this.diagnostic(),
            method === "initialize" ? "MCP_INITIALIZE_TIMEOUT" : "MCP_RESPONSE_TIMEOUT",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        emitted = true;
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
          "utf8",
          () => {
            emitted = true;
          },
        );
      } catch (error) {
        emitted = false;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeTransportError((error as Error).message, false, this.diagnostic()));
      }
    });
  }

  private async initialize(timeoutMs: number): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      const response = await this.request(
        "initialize",
        {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "voice-calibration", version: "1.0.0" },
        },
        timeoutMs,
      );
      if (response.error)
        throw new BridgeTransportError(response.error.message ?? "MCP initialize failed", false, this.diagnostic());
      const child = this.ensureChild(this.secret);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
        "utf8",
      );
    })();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = null;
      throw error;
    }
  }

  async schema(secret: string, timeoutMs: number): Promise<unknown> {
    await this.start(secret);
    await this.initialize(timeoutMs);
    const response = await this.request("tools/list", {}, timeoutMs);
    if (response.error)
      throw new BridgeTransportError(response.error.message ?? "MCP tools/list failed", false, this.diagnostic());
    const tools = resultObject(response.result).tools;
    return Array.isArray(tools)
      ? resultObject(tools.find((tool) => resultObject(tool).name === "calibrate_voice")).inputSchema
      : undefined;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    secret: string,
    timeoutMs: number,
  ): Promise<TransportCall> {
    await this.start(secret);
    try {
      await this.initialize(timeoutMs);
    } catch (error) {
      if (error instanceof BridgeTransportError) {
        throw new BridgeTransportError(error.message, false, error.stderr, error.code);
      }
      throw error;
    }
    try {
      const response = await this.request("tools/call", { name, arguments: args }, timeoutMs);
      if (response.error)
        return { response: undefined, emitted: true, stderr: this.diagnostic(), remoteError: response.error };
      const toolResult = resultObject(response.result);
      return {
        response: unwrapToolResult(response.result),
        emitted: true,
        stderr: this.diagnostic(),
        toolError: toolResult.isError === true,
      };
    } catch (error) {
      if (error instanceof BridgeTransportError) throw error;
      throw new BridgeTransportError((error as Error).message, true, this.diagnostic());
    }
  }

  async call(args: Record<string, unknown>, secret: string, timeoutMs: number): Promise<TransportCall> {
    return this.callTool("calibrate_voice", args, secret, timeoutMs);
  }

  onExit(listener: () => void): void {
    this.exitListener = listener;
    if (this.terminalError) listener();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.initialized = null;
    this.closing = new Promise<void>((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        child.kill();
        // A kill request is not proof of exit; replacement must wait for the exit event.
        killTimer = setTimeout(() => reject(new BridgeTransportError("MCP process did not exit", false)), 2_000);
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve();
      });
      child.stdin.end();
    });
    return this.closing;
  }
}

function parseCoreRun(value: unknown): CoreRunRecord {
  const raw = resultObject(value);
  const approval = raw.approval;
  const approvalObject = approval && typeof approval === "object" ? resultObject(approval) : null;
  if (
    typeof raw.run_id !== "string" ||
    typeof raw.workspace_id !== "string" ||
    typeof raw.revision !== "number" ||
    typeof raw.status !== "string" ||
    typeof raw.request_digest !== "string" ||
    typeof raw.created_at !== "string" ||
    typeof raw.updated_at !== "string"
  ) {
    throw new Error("invalid calibration core run response");
  }
  return {
    runId: raw.run_id,
    workspaceId: raw.workspace_id,
    revision: raw.revision,
    status: raw.status,
    context: resultObject(raw.context),
    request: resultObject(raw.request),
    requestDigest: raw.request_digest,
    proposal: raw.proposal ?? null,
    approval:
      approvalObject && typeof approvalObject.approved_at === "string" && typeof approvalObject.expires_at === "string"
        ? {
            approvedAt: approvalObject.approved_at,
            expiresAt: approvalObject.expires_at,
            consumedAt: typeof approvalObject.consumed_at === "string" ? approvalObject.consumed_at : null,
          }
        : null,
    result: raw.result ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    raw: value,
  };
}

function parseScopedCoreRun(value: unknown, workspaceId: string): CoreRunRecord {
  assertWorkspaceId(workspaceId);
  const run = parseCoreRun(value);
  if (run.workspaceId !== workspaceId) throw new Error("calibration core workspace mismatch");
  return run;
}

function coreExecutionResult(run: CoreRunRecord): ExecutionResult {
  const raw = resultObject(run.result);
  if (run.status === "execution_unknown") {
    return {
      status: "unknown",
      metrics: {},
      artifacts: [],
      raw: run.result,
      coreRun: run,
      error: { code: "execution_unknown", message: "execution outcome is unknown" },
    };
  }
  if (run.status === "succeeded") {
    const metrics = Object.fromEntries(
      Object.entries(raw).filter(([key]) => !["status", "error", "reason", "details"].includes(key)),
    );
    return {
      status: "succeeded",
      metrics,
      artifacts: Array.isArray(raw.artifacts) ? [...raw.artifacts] : [],
      raw: run.result,
      coreRun: run,
    };
  }
  if (run.status === "failed") {
    return {
      status: "failed",
      metrics: {},
      artifacts: [],
      raw: run.result,
      coreRun: run,
      error: {
        code: String(raw.reason ?? raw.status ?? "calibration_failed"),
        message: String(raw.details ?? raw.error ?? "calibration failed"),
      },
    };
  }
  throw new Error(`calibration core returned non-terminal state: ${run.status}`);
}

export function createCalibrationBridge(options: {
  providerMode?: "elevenlabs" | "simulated";
  transport?: CalibrationTransport;
  credentials: CredentialProvider;
  timeoutMs?: number;
  wpmPath?: string;
  workspaceId?: string;
  tenantId?: string;
  stateDir?: string;
  uiWorkspaceDir?: string;
}): CalibrationBridge {
  const launch =
    Object.hasOwn(options, "wpmPath") || options.workspaceId !== undefined
      ? {
          wpmPath: options.wpmPath,
          workspaceId: options.workspaceId,
          tenantId: options.tenantId,
          stateDir: options.stateDir,
          uiWorkspaceDir: options.uiWorkspaceDir,
        }
      : undefined;
  const transport = options.transport ?? new NodeMcpStdioTransport(undefined, undefined, undefined, launch);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const invokeTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<TransportCall & { secret: string }> => {
    let credential: { provider: string; secret: string };
    try {
      credential = await options.credentials.forRun();
    } catch {
      throw new Error("calibration credentials unavailable");
    }
    if (credential.provider !== "elevenlabs")
      throw new Error(`unsupported credential provider: ${credential.provider}`);
    try {
      const responseTimeoutMs = name === "get_server_info" ? Math.min(timeoutMs, 10_000) : timeoutMs;
      const response = transport.callTool
        ? await transport.callTool(name, args, credential.secret, responseTimeoutMs)
        : name === "calibrate_voice"
          ? await transport.call(args, credential.secret, timeoutMs)
          : (() => {
              throw new Error("calibration transport does not support named MCP tools");
            })();
      if (response.toolError) {
        const safeResponse = redact(response.response, credential.secret);
        throw new Error(typeof safeResponse === "string" ? safeResponse : "MCP tool call failed");
      }
      return { ...response, secret: credential.secret };
    } catch (error) {
      if (error instanceof BridgeTransportError) {
        throw new BridgeTransportError(
          String(redact(error.message, credential.secret)),
          error.emitted,
          String(redact(error.stderr, credential.secret)),
          error.code,
        );
      }
      throw new Error(String(redact((error as Error).message, credential.secret)));
    }
  };
  const call = async (
    request: ResolvedCalibrationRequest,
    dryRun: boolean,
  ): Promise<TransportCall & { secret: string }> => {
    return invokeTool("calibrate_voice", makeRequest(request, dryRun));
  };

  // Engine mode is immutable for this process; never cache mutable source-data permissions.
  let sourceScope: Promise<TransportCall & { secret: string }> | undefined;
  let exitListener: (() => void) | undefined;
  let exited = false;
  transport.onExit?.(() => { sourceScope = undefined; exited = true; exitListener?.(); });

  return {
    onExit: (listener) => { exitListener = listener; if (exited) listener(); },
    async prepareProject(input) {
      const handshake = await invokeTool("get_preparation_scope", { workspace_id: input.workspaceId });
      const scope = resultObject(handshake.response);
      if (handshake.remoteError || scope.schema !== "project-preparation-scope-v1"
          || scope.tenantId !== input.identity.tenantId || scope.workspaceId !== input.workspaceId
          || typeof scope.engineId !== "string"
          || Object.keys(scope).sort().join() !== "engineId,schema,tenantId,workspaceId")
        throw new Error("Preparation engine scope mismatch");
      const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
      const claims = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, engineId: scope.engineId,
        userId: input.identity.userId, operation: input.operation,
        target: createHash("sha256").update(canonical(input.payload)).digest("hex"),
        expiresAt: Math.floor(Date.now() / 1000) + 60 };
      const signature = createHmac("sha256", handshake.secret)
        .update("project-preparation-v1\0" + canonical(claims)).digest("hex");
      const result = await invokeTool("prepare_project", { workspace_id: input.workspaceId,
        operation: input.operation, payload: input.payload, capability: { claims, signature } });
      if (result.remoteError) throw new Error("Preparation refused");
      return resultObject(redact(result.response, result.secret));
    },
    async reusableProfiles(input) {
      assertWorkspaceId(input.workspaceId);
      sourceScope ??= invokeTool("get_reuse_scope", { workspace_id: input.workspaceId }).catch(error => {
        sourceScope = undefined;
        throw error;
      });
      const handshake = await sourceScope;
      const scope = resultObject(redact(handshake.response, handshake.secret));
      if (handshake.remoteError || scope.schema !== "source-access-scope-v1"
          || scope.workspaceId !== input.workspaceId || scope.tenantId !== input.identity.tenantId)
        throw new Error("reuse engine scope mismatch");
      if (scope.mode === "legacy" && input.operation === "source-read") {
        if (Object.keys(scope).sort().join() !== ["schema", "mode", "tenantId", "workspaceId"].sort().join())
          throw new Error("invalid legacy engine attestation");
        return { authorized: true, mode: "legacy", workspaceId: scope.workspaceId, tenantId: scope.tenantId };
      }
      if (scope.mode !== "scoped"
          || Object.keys(scope).sort().join() !== ["schema", "mode", "tenantId", "workspaceId", "projectId", "datasetId", "engineId"].sort().join()
          || typeof scope.projectId !== "string" || typeof scope.datasetId !== "string" || typeof scope.engineId !== "string")
        throw new Error("reuse engine scope mismatch");
      const claims = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId,
        datasetId: scope.datasetId, engineId: scope.engineId, userId: input.identity.userId,
        operation: input.operation, target: input.target, expiresAt: Math.floor(Date.now() / 1000) + 60 };
      const encoded = JSON.stringify(claims, Object.keys(claims).sort());
      const signature = createHmac("sha256", handshake.secret).update("voice-profile-reuse-v1\0" + encoded).digest("hex");
      const tool = { catalog: "get_reusable_profiles", publish: "publish_reusable_profile", revoke: "revoke_reusable_profile",
        "source-read": "authorize_source_read" }[input.operation];
      const result = await invokeTool(tool, { workspace_id: input.workspaceId, capability: { claims, signature },
        ...(input.operation === "publish" ? { run_id: input.target } : {}),
        ...(input.operation === "source-read" ? { resource: input.target } : {}),
        ...(input.operation === "revoke" ? { grant_id: input.target } : {}) });
      if (result.remoteError) throw new Error("reuse operation refused");
      return resultObject(redact(result.response, result.secret));
    },
    async publishLiveProfile(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("publish_live_profile", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        gateway_real_provenance: true,
      });
      if (result.remoteError) throw new Error("publication du profil évolutif refusée");
      return resultObject(redact(result.response, result.secret));
    },
    async getLiveProfiles(workspaceId) {
      assertWorkspaceId(workspaceId);
      const result = await invokeTool("get_live_profiles", { workspace_id: workspaceId });
      if (result.remoteError) throw new Error("source évolutive indisponible");
      const catalog = resultObject(redact(result.response, result.secret));
      if (catalog.workspaceId !== workspaceId) throw new Error("workspace mismatch");
      return catalog;
    },
    async recordTikTokObservation(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("record_tiktok_observation", {
        workspace_id: input.workspaceId,
        profile_id: input.profileId,
        observation: input.observation,
      });
      if (result.remoteError) throw new Error("mesure TikTok refusée");
      return resultObject(redact(result.response, result.secret));
    },
    async getSchema() {
      let credential: { provider: string; secret: string };
      try {
        credential = await options.credentials.forRun();
      } catch {
        throw new Error("calibration credentials unavailable");
      }
      if (credential.provider !== "elevenlabs")
        throw new Error(`unsupported credential provider: ${credential.provider}`);
      try {
        const schema = await transport.schema(credential.secret, Math.min(timeoutMs, 10_000));
        if (options.workspaceId !== undefined) {
          const info = await invokeTool("get_server_info", {});
          const identity = resultObject(info.response);
          if (
            info.remoteError ||
            identity.workspace_id !== options.workspaceId ||
            identity.state_dir !== (transport.instanceStateDir ?? options.stateDir) ||
            (options.tenantId !== undefined && identity.tenant_id !== options.tenantId)
          ) {
            throw new Error("MCP instance configuration mismatch; use a workspace-aware Python adapter");
          }
        }
        return schema;
      } catch (error) {
        if (error instanceof BridgeTransportError)
          throw new BridgeTransportError(
            String(redact(error.message, credential.secret)),
            error.emitted,
            String(redact(error.stderr, credential.secret)),
            error.code === "MCP_RESPONSE_TIMEOUT" ? "MCP_READINESS_TIMEOUT" : error.code,
          );
        throw new Error(String(redact((error as Error).message, credential.secret)));
      }
    },
    async dryRun(input) {
      try {
        const result = await call(input.request, true);
        if (result.remoteError)
          throw new Error(String(redact(result.remoteError.message ?? "MCP tools/call failed", result.secret)));
        const safeResponse = redact(result.response, result.secret);
        const raw = resultObject(safeResponse);
        return {
          accepted: raw.status === "dry_run_success" || raw.accepted === true,
          plan: Array.isArray(raw.plan) ? raw.plan : [],
          raw: safeResponse,
          status: typeof raw.status === "string" ? raw.status : undefined,
        };
      } catch (error) {
        const message = error instanceof BridgeTransportError ? error.message : (error as Error).message;
        throw new Error(message);
      }
    },
    async propose(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("propose_calibration", {
        ...(options.providerMode && input.request.postproc === "cut" ? { profile_scope: options.providerMode } : {}),
        workspace_id: input.workspaceId,
        ...makeGateRequest(input.request),
        corpus_version_id: input.request.corpusVersionId,
        corpus_digest: input.request.corpusDigest,
        contract_digest: input.request.contractDigest,
        core_digest: input.request.coreDigest,
      });
      if (result.remoteError) {
        const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
        throw new Error(String(safeError.message ?? "MCP tools/call failed"));
      }
      const safeResponse = redact(result.response, result.secret);
      const coreRun = parseScopedCoreRun(safeResponse, input.workspaceId);
      const proposal = resultObject(coreRun.proposal);
      return {
        accepted: coreRun.status === "dry_run_ready",
        plan: Array.isArray(proposal.plan) ? proposal.plan : [],
        raw: safeResponse,
        status: coreRun.status,
        runId: coreRun.runId,
        workspaceId: coreRun.workspaceId,
        requestDigest: coreRun.requestDigest,
        proposal: coreRun.proposal,
        approval: coreRun.approval,
      };
    },
    async approve(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("approve_calibration", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
        request_digest: input.requestDigest,
      });
      if (result.remoteError) {
        const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
        throw new Error(String(safeError.message ?? "MCP tools/call failed"));
      }
      return parseScopedCoreRun(redact(result.response, result.secret), input.workspaceId);
    },
    async getRun(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("get_calibration_run", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
      });
      if (result.remoteError) {
        const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
        throw new Error(String(safeError.message ?? "MCP tools/call failed"));
      }
      return parseScopedCoreRun(redact(result.response, result.secret), input.workspaceId);
    },
    async publish(input) {
      assertWorkspaceId(input.workspaceId);
      const result = await invokeTool("publish_calibration", {
        workspace_id: input.workspaceId,
        run_id: input.runId,
      });
      if (result.remoteError) {
        const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
        throw new Error(String(safeError.message ?? "MCP tools/call failed"));
      }
      const safeResponse = redact(result.response, result.secret);
      const run = parseScopedCoreRun(safeResponse, input.workspaceId);
      const publication = resultObject(run.result).publication;
      const publicationObject = resultObject(publication);
      if (
        publicationObject.status !== "published" ||
        typeof publicationObject.canonical_ref !== "string" ||
        typeof publicationObject.wpm !== "number"
      ) {
        throw new Error("calibration publication was not confirmed");
      }
      return {
        canonicalRef: publicationObject.canonical_ref,
        ...(typeof publicationObject.voice === "string" ? { voiceAlias: publicationObject.voice } : {}),
        wpm: publicationObject.wpm,
        runsPublished:
          typeof publicationObject.runs_published === "number" ? publicationObject.runs_published : undefined,
      };
    },
    async execute(input) {
      if (input.workspaceId !== undefined) assertWorkspaceId(input.workspaceId);
      if (input.workspaceId && input.coreRunId) {
        const result = await invokeTool("execute_calibration", {
          workspace_id: input.workspaceId,
          run_id: input.coreRunId,
        });
        if (result.remoteError) {
          const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
          throw new Error(String(safeError.message ?? "MCP tools/call failed"));
        }
        return coreExecutionResult(parseScopedCoreRun(redact(result.response, result.secret), input.workspaceId));
      }
      try {
        const result = await invokeTool("calibrate_voice", makeRequest(input.snapshot, false));
        if (result.remoteError) {
          const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
          return {
            status: "failed",
            metrics: {},
            artifacts: [],
            raw: safeError,
            error: {
              code: String(safeError.code ?? "mcp_error"),
              message: String(safeError.message ?? "MCP tools/call failed"),
            },
          };
        }
        const safeResponse = redact(result.response, result.secret);
        const raw = resultObject(safeResponse);
        if (raw.status === "ok") {
          const metrics = Object.fromEntries(
            Object.entries(raw).filter(([key]) => !["status", "error", "reason", "details"].includes(key)),
          );
          return { status: "succeeded", metrics, artifacts: [], raw: safeResponse };
        }
        return {
          status: "failed",
          metrics: {},
          artifacts: [],
          raw: safeResponse,
          error: {
            code: String(raw.reason ?? raw.status ?? "calibration_failed"),
            message: String(raw.details ?? raw.error ?? "calibration failed"),
          },
        };
      } catch (error) {
        if (error instanceof BridgeTransportError && error.emitted) throw new Error("execution_unknown");
        throw new Error(error instanceof BridgeTransportError ? error.message : (error as Error).message);
      }
    },
    async reconcile(input) {
      if (input.workspaceId !== undefined) assertWorkspaceId(input.workspaceId);
      if (input.workspaceId && input.coreRunId) {
        const result = await invokeTool("reconcile_calibration", {
          workspace_id: input.workspaceId,
          run_id: input.coreRunId,
        });
        if (result.remoteError) {
          const safeError = redact(result.remoteError, result.secret) as Record<string, unknown>;
          throw new Error(String(safeError.message ?? "MCP tools/call failed"));
        }
        return parseScopedCoreRun(redact(result.response, result.secret), input.workspaceId);
      }
      return { status: "unknown" };
    },
    close: () => { sourceScope = undefined; return transport.close(); },
  };
}

export function createCanonicalProfilePort(
  options: {
    verify?: (input: {
      voiceRef: string;
      wpm: number;
      runId: string;
      corpusVersionId: string;
      language?: "fr" | "en";
    }) => Promise<{ canonicalRef: string; wpm: number }>;
    wpmPath?: string;
    language?: "fr" | "en";
    referenceBase?: string;
    readCorpus?: () => Promise<string>;
  } = {},
): CanonicalProfilePort {
  const wpmPath = Object.hasOwn(options, "wpmPath") ? options.wpmPath : process.env.VOICE_WPM_PATH;
  const referenceBase = options.referenceBase ?? (wpmPath ? pathToFileURL(wpmPath).href : undefined);
  const readCorpus = options.readCorpus ?? (() => readFile(wpmPath!, "utf8"));
  return {
    async getObservationSummary() {
      return readObservationSummary(wpmPath, readCorpus);
    },
    async findPublished(input) {
      return readPublishedWpm(input, wpmPath, options.language ?? "fr", referenceBase, readCorpus);
    },
    async ensurePublished(input) {
      const result = options.verify
        ? await options.verify(input)
        : await verifyWpmFile(input, wpmPath, options.language ?? "fr", referenceBase, readCorpus);
      if (Math.abs(result.wpm - input.wpm) > 0.001) throw new Error("canonical_wpm_mismatch");
      return { canonicalRef: result.canonicalRef };
    },
  };
}

async function readObservationSummary(
  wpmPath: string | undefined,
  readCorpus: () => Promise<string>,
): Promise<ObservationSummary> {
  if (!wpmPath) return { voices: [], sourceAvailable: false };
  try {
    const data = JSON.parse(await readCorpus()) as Record<string, unknown>;
    const voices = Object.entries(data)
      .filter(
        ([voiceRef, value]) =>
          voiceRef !== "_default" && value !== null && typeof value === "object" && !Array.isArray(value),
      )
      .map(([voiceRef, value]) => {
        const record = resultObject(value);
        const runs = Array.isArray(record.observed_runs) ? record.observed_runs : [];
        const counts = { voiceRef, total: runs.length, raw: 0, rawClean: 0, trim: 0, cut: 0, other: 0, unknown: 0 };
        for (const value of runs) {
          const run = resultObject(value);
          const postproc = typeof run.postproc === "string" ? run.postproc.trim().toLowerCase() : "";
          const rawDuration = run.duration_raw_s ?? (postproc === "raw" ? run.duration_s : undefined);
          if (
            run.verified === true &&
            run.outlier_excluded !== true &&
            typeof run.words === "number" &&
            Number.isFinite(run.words) &&
            run.words > 0 &&
            typeof rawDuration === "number" &&
            Number.isFinite(rawDuration) &&
            rawDuration > 0
          ) {
            counts.rawClean += 1;
          }
          if (postproc === "raw") {
            counts.raw += 1;
          } else if (postproc === "trim") counts.trim += 1;
          else if (postproc === "cut") counts.cut += 1;
          else if (postproc) counts.other += 1;
          else counts.unknown += 1;
        }
        return counts;
      });
    return { voices, sourceAvailable: true };
  } catch {
    return { voices: [], sourceAvailable: false };
  }
}

async function verifyWpmFile(
  input: { voiceRef: string; wpm: number; language?: "fr" | "en" },
  wpmPath: string | undefined,
  language: "fr" | "en",
  referenceBase?: string,
  readCorpus?: () => Promise<string>,
): Promise<{ canonicalRef: string; wpm: number }> {
  const published = await readPublishedWpm(input, wpmPath, language, referenceBase, readCorpus);
  if (!published) throw new Error("canonical_wpm_unavailable");
  return published;
}

async function readPublishedWpm(
  input: { voiceRef: string; language?: "fr" | "en" },
  wpmPath: string | undefined,
  language: "fr" | "en",
  referenceBase?: string,
  readCorpus?: () => Promise<string>,
): Promise<{ canonicalRef: string; wpm: number } | null> {
  if (!wpmPath) throw new Error("canonical_wpm_unavailable");
  language = input.language ?? language;
  const data = JSON.parse(await (readCorpus ? readCorpus() : readFile(wpmPath, "utf8"))) as Record<
    string,
    Record<string, unknown>
  >;
  const record = data[input.voiceRef];
  if (!record || typeof record !== "object") return null;
  const profile =
    language === "en" ? resultObject(resultObject(record.profiles_by_lang).en) : resultObject(record.profile);
  if (Object.keys(profile).length === 0) return null;
  const key = language === "en" ? "wpm_calibrated_by_lang" : "wpm_calibrated";
  const wpm = language === "en" ? resultObject(record?.[key]).en : record?.[key];
  if (typeof wpm !== "number") return null;
  const suffix = language === "en" ? "wpm_calibrated_by_lang.en" : "wpm_calibrated";
  return { canonicalRef: `${referenceBase}#${encodeURIComponent(`${input.voiceRef}.${suffix}`)}`, wpm };
}

export { BridgeTransportError, NodeMcpStdioTransport };
