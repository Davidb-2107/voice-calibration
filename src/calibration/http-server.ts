import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { ContractValidationError, NotFoundError, UnavailableError } from "./application.js";
import { bootstrapFailure, bootstrapRequest, bootstrapStage } from "./bootstrap-diagnostics.js";
import { BridgeTransportError } from "./bridge.js";
import { assertWorkspaceId, InvalidWorkspaceIdError } from "./domain.js";
import type { CalibrationEngine } from "./engine-manager.js";
import type { CalibrationJobQueue } from "./job-queue.js";
import { ConflictError } from "./ports.js";
import { redactSensitive } from "./redaction.js";

const DEFAULT_WORKSPACE = "local-default";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const CALIBRATION_HTML = fileURLToPath(new URL("../ui/calibration.html", import.meta.url));
const CALIBRATION_CLIENT = fileURLToPath(new URL("../ui/calibration-client.js", import.meta.url));

export type CalibrationHttpServerOptions = {
  workspaceId?: string;
  host?: string;
  port?: number;
  allowNetwork?: boolean;
  publicOrigin?: string;
  jobQueue?: CalibrationJobQueue;
  browserAuth?: { url: string; publishableKey: string };
} & (
  | { application: CalibrationEngine; resolveApplication?: never; closeApplications?: never }
  | {
      application?: never;
      resolveApplication(request: IncomingMessage): Promise<{
        application: CalibrationEngine;
        workspaceId: string;
        identity?: { userId: string; tenantId: string };
      }>;
      closeApplications(): Promise<void>;
    }
);

export interface CalibrationUiHandle {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorPayload(error: unknown): { code: string; message: string } {
  const readiness = engineReadinessError(error);
  if (readiness) return readiness;
  if (error instanceof InvalidWorkspaceIdError) return { code: error.code, message: error.message };
  if (error instanceof HttpError) return { code: error.code, message: error.message };
  if (error instanceof NotFoundError) return { code: "not_found", message: error.message };
  if (error instanceof ContractValidationError) return { code: error.code, message: error.message };
  if (error instanceof UnavailableError) return { code: error.code, message: error.message };
  if (error instanceof ConflictError) return { code: error.code, message: error.message };
  if (error instanceof Error && /revision conflict/i.test(error.message))
    return { code: "if_match_failed", message: error.message };
  return { code: "internal_error", message: "unexpected local failure" };
}

function engineReadinessError(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof BridgeTransportError)) return;
  switch (error.code) {
    case "ENGINE_STARTUP_TIMEOUT":
      return {
        code: error.code,
        message: "Le moteur n’a pas démarré dans le délai prévu. Réessayez le chargement de votre espace.",
      };
    case "ENGINE_STARTUP_FAILED":
      return {
        code: error.code,
        message:
          "Le démarrage du moteur a échoué. Réessayez le chargement de votre espace ; si le problème persiste, contactez l’administrateur.",
      };
    case "MCP_INITIALIZE_TIMEOUT":
    case "MCP_READINESS_TIMEOUT":
      return {
        code: error.code,
        message: "Le moteur a démarré mais ne répond pas dans le délai prévu. Réessayez le chargement de votre espace.",
      };
  }
}

function executionHttpError(report: { error: { code: string; message: string } | null } | null): HttpError | null {
  if (!report?.error) return null;
  const { code, message } = report.error;
  if (
    [
      "invalid_request",
      "unsupported_input_feature",
      "profile_mismatch",
      "domain_error",
      "contract_validation",
    ].includes(code)
  ) {
    return new HttpError(422, code, message);
  }
  if (
    ["quota_exceeded", "unavailable", "credentials_unavailable", "provider_unavailable"].includes(code) ||
    /not configured|credential|provider unavailable|core unavailable/i.test(message)
  ) {
    return new HttpError(503, code, message);
  }
  return null;
}

function statusForError(error: unknown): number {
  if (engineReadinessError(error)) return 503;
  if (error instanceof InvalidWorkspaceIdError) return 400;
  if (error instanceof HttpError) return error.status;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ContractValidationError) return 422;
  if (error instanceof UnavailableError) return 503;
  if (error instanceof Error && /revision conflict/i.test(error.message)) return 412;
  if (error instanceof ConflictError) return 409;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /revision conflict|approval|required|expired|digest|state|execution_unknown|reconcile|already consumed/i.test(
      message,
    )
  )
    return 409;
  if (/invalid_request|validation|unsupported_input_feature|profile_mismatch|domain_error/i.test(message)) return 422;
  if (
    /not configured|credential|canonical_wpm_unavailable|mcp process|provider unavailable|core unavailable/i.test(
      message,
    )
  )
    return 503;
  return 500;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(redactSensitive(body)), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(bytes.byteLength),
    ...headers,
  });
  response.end(bytes);
}

async function parseBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_BODY_BYTES) throw new HttpError(400, "malformed_json", "request body is too large");
    chunks.push(bytes);
  }
  if (length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed_json", "malformed JSON");
  }
  if (!isRecord(value)) throw new HttpError(400, "malformed_json", "JSON body must be an object");
  return value;
}

function assertRequestWorkspace(url: URL, body: Record<string, unknown> | undefined, workspaceId: string): void {
  const supplied: unknown[] = url.searchParams.getAll("workspaceId");
  for (const candidate of [body, body?.input, body?.draft]) {
    if (isRecord(candidate) && Object.hasOwn(candidate, "workspaceId")) supplied.push(candidate.workspaceId);
  }
  for (const value of supplied) {
    assertWorkspaceId(value);
    if (value !== workspaceId)
      throw new HttpError(400, "workspace_mismatch", "workspace does not match server instance");
  }
}

function requireNonce(request: IncomingMessage, application: CalibrationEngine): void {
  if (stringHeader(request.headers["x-calibration-nonce"]) !== application.getSessionNonce()) {
    throw new HttpError(409, "nonce_required", "calibration session nonce required");
  }
}

function parseRevision(value: string | undefined): number {
  if (!value) throw new HttpError(412, "if_match_required", "If-Match is required");
  const match = /^W\/"corpus-draft-(\d+)"$/.exec(value) ?? /^"?(\d+)"?$/.exec(value);
  if (!match) throw new HttpError(412, "if_match_failed", "If-Match does not match the current draft");
  return Number(match[1]);
}

function idFromPath(pathname: string, action = true): string {
  const encoded = pathname.split("/").at(action ? -2 : -1);
  if (!encoded) throw new HttpError(404, "not_found", "route not found");
  try {
    const id = decodeURIComponent(encoded);
    if (!id || id.includes("/") || id.includes("\\") || id === "." || id === "..") throw new Error();
    return id;
  } catch {
    throw new HttpError(404, "not_found", "route not found");
  }
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  options: CalibrationHttpServerOptions,
): Promise<void> {
  const configuredHost = options.host ?? "127.0.0.1";
  const localPort = request.socket.localPort ?? options.port ?? 0;
  const expectedOrigin = options.publicOrigin ?? `http://${urlHost(configuredHost)}:${localPort}`;
  const host = stringHeader(request.headers.host);
  const origin = stringHeader(request.headers.origin);
  if (origin && origin !== expectedOrigin) {
    sendJson(response, 403, { error: { code: "cross_origin", message: "cross-origin requests are not allowed" } });
    return;
  }

  const method = request.method ?? "GET";
  try {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${host ?? "localhost"}`);
    } catch {
      throw new HttpError(400, "malformed_url", "Invalid request URL or Host");
    }
    // Only public UI assets precede authentication; business routes still resolve server-owned membership.
    if (
      method === "GET" &&
      ["/", "/calibration.html", "/calibration-client.js", "/calibration-auth.js"].includes(url.pathname)
    ) {
      const html = url.pathname === "/" || url.pathname === "/calibration.html";
      const body =
        url.pathname === "/calibration-auth.js"
          ? Buffer.from(
              `const CALIBRATION_AUTH = ${JSON.stringify(options.browserAuth ?? null).replaceAll("<", "\\u003c")};`,
            )
          : await readFile(html ? CALIBRATION_HTML : CALIBRATION_CLIENT);
      response.writeHead(200, {
        "content-type": html ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }
    const selected = options.resolveApplication
      ? await options.resolveApplication(request)
      : {
          application: options.application,
          workspaceId: options.workspaceId ?? DEFAULT_WORKSPACE,
          identity: undefined,
        };
    const { application, workspaceId } = selected;
    assertWorkspaceId(workspaceId);
    assertRequestWorkspace(url, undefined, workspaceId);
    if (options.resolveApplication && !url.pathname.startsWith("/api/v1/"))
      throw new HttpError(404, "not_found", "API route not found");
    const reusePublish = /^\/api\/v1\/calibration-runs\/[^/]+\/reuse-publication$/.test(url.pathname);
    const reuseRevoke = /^\/api\/v1\/reusable-voice-profiles\/[^/]+\/revoke$/.test(url.pathname);
    const projectVoice = url.pathname === "/api/v1/projects/voice";
    const projectCalibration = url.pathname === "/api/v1/projects/calibration";
    const projectProduction = url.pathname === "/api/v1/projects/production";
    const preparation = url.pathname === "/api/v1/projects/preparation";
    const metadataOnly =
      projectProduction ||
      projectCalibration ||
      projectVoice ||
      preparation ||
      url.pathname.startsWith("/api/v1/reusable-voice-profiles") ||
      reusePublish ||
      (method === "GET" && url.pathname === "/api/v1/calibration/schema");
    let sourceAccess = false;
    if (options.resolveApplication && !metadataOnly) {
      if (!selected.identity)
        throw new HttpError(403, "source_data_forbidden", "Authenticated source identity required");
      try {
        await application.authorizeSourceRead(workspaceId, selected.identity, `${method} ${url.pathname}`);
        sourceAccess = true;
      } catch {
        if (!(method === "GET" && url.pathname === "/api/v1/bootstrap"))
          throw new HttpError(403, "source_data_forbidden", "Explicit project/dataset source-data rights required");
      }
    }
    if (projectProduction && method === "POST") {
      if (!options.resolveApplication || !selected.identity)
        throw new HttpError(403, "authenticated_project_required", "Authenticated project required");
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const { action, ...payload } = body;
      if (!["propose", "inspect", "approve", "decline", "execute", "reconcile"].includes(action as string))
        throw new HttpError(400, "invalid_production_action", "Production action refused");
      const expected = [
        "binding",
        "voice",
        "text",
        "receiptId",
        ...(action === "propose" && Object.hasOwn(payload, "financialOperationKey") ? ["financialOperationKey"] : []),
        ...(action === "propose" ? [] : ["runId", "requestDigest"]),
        ...(action === "approve" ? ["agreement"] : action === "decline" ? ["decision"] : []),
      ]
        .sort()
        .join();
      if (Object.keys(payload).sort().join() !== expected)
        throw new HttpError(400, "invalid_production_scope", "Unexpected production fields");
      sendJson(
        response,
        200,
        await application.projectProduction(
          workspaceId,
          selected.identity,
          action as "propose" | "inspect" | "approve" | "decline" | "execute" | "reconcile",
          payload,
        ),
      );
      return;
    }
    if (projectCalibration && method === "POST") {
      if (!options.resolveApplication || !selected.identity)
        throw new HttpError(403, "authenticated_project_required", "Authenticated project required");
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const { action, ...payload } = body;
      if (!["propose", "inspect", "approve", "decline", "execute", "publish", "reconcile"].includes(action as string))
        throw new HttpError(400, "invalid_calibration_action", "Calibration action refused");
      let expected =
        action === "propose"
          ? "binding,request"
          : action === "approve"
            ? "agreement,binding,request,requestDigest,runId"
            : action === "decline"
              ? "binding,decision,request,requestDigest,runId"
              : "binding,request,requestDigest,runId";
      if (action === "propose" && Object.hasOwn(payload, "financialOperationKey")) {
        expected = `${expected},financialOperationKey`.split(",").sort().join();
      }
      if (Object.keys(payload).sort().join() !== expected)
        throw new HttpError(400, "invalid_calibration_scope", "Unexpected calibration fields");
      sendJson(
        response,
        200,
        await application.projectCalibration(
          workspaceId,
          selected.identity,
          action as "propose" | "inspect" | "approve" | "decline" | "execute" | "publish" | "reconcile",
          payload,
        ),
      );
      return;
    }
    if (projectVoice && method === "POST") {
      if (!options.resolveApplication || !selected.identity)
        throw new HttpError(403, "authenticated_project_required", "Authenticated project required");
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const { operation, ...payload } = body;
      if (!["select", "readiness", "predict", "verify", "produce"].includes(operation as string))
        throw new HttpError(400, "invalid_project_operation", "Project operation refused");
      const expected =
        operation === "select"
          ? "binding,profile"
          : operation === "readiness"
            ? "binding,voice"
            : operation === "predict"
              ? "binding,text,voice"
              : "binding,receiptId,text,voice";
      if (Object.keys(payload).sort().join() !== expected)
        throw new HttpError(400, "invalid_project_scope", "Unexpected project fields");
      sendJson(
        response,
        200,
        await application.projectVoice(
          workspaceId,
          selected.identity,
          operation as "select" | "readiness" | "predict" | "verify" | "produce",
          payload,
        ),
      );
      return;
    }
    if (preparation && method === "POST") {
      if (!options.resolveApplication || !selected.identity)
        throw new HttpError(403, "authenticated_preparation_required", "Authenticated preparation required");
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const operation = body.operation;
      const tracked = Object.hasOwn(body, "operationId");
      const expected =
        operation === "create"
          ? tracked
            ? "expectedGeneration,name,operation,operationId,root"
            : "name,operation"
          : tracked
            ? "operation,operationId"
            : "binding,operation";
      if ((operation !== "create" && operation !== "inspect") || Object.keys(body).sort().join() !== expected)
        throw new HttpError(400, "invalid_preparation", "Only creation or inspection payloads are accepted");
      const { operation: _operation, ...payload } = body;
      sendJson(response, 200, await application.prepareProject(workspaceId, selected.identity, operation, payload));
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/bootstrap") {
      const bootstrap =
        options.resolveApplication && !sourceAccess
          ? {
              sessionNonce: application.getSessionNonce(),
              config: { configured: false },
              activeCorpus: null,
              profiles: [],
              recentRuns: [],
            }
          : await bootstrapStage("bootstrap", () => application.getBootstrap(workspaceId));
      sendJson(
        response,
        200,
        selected.identity ? { ...bootstrap, workspaceId, identity: selected.identity } : bootstrap,
      );
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/corpus") {
      const corpus = await application.getCorpus(workspaceId);
      sendJson(response, 200, corpus, { etag: `W/"corpus-draft-${corpus.draft.revision}"` });
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/corpus/draft") {
      const result = await application.getDraft(workspaceId);
      sendJson(response, 200, result.draft, { etag: result.etag });
      return;
    }
    if (method === "PUT" && url.pathname === "/api/v1/corpus/draft") {
      requireNonce(request, application);
      const expectedRevision = parseRevision(stringHeader(request.headers["if-match"]));
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const draft = isRecord(body.draft) ? body.draft : body;
      const saved = await application.saveDraft(workspaceId, draft as never, expectedRevision);
      sendJson(response, 200, saved, { etag: `W/"corpus-draft-${saved.revision}"` });
      return;
    }
    if (method === "POST" && url.pathname === "/api/v1/corpus/versions") {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const ifMatch = stringHeader(request.headers["if-match"]);
      const expectedRevision = ifMatch ? parseRevision(ifMatch) : body.expectedRevision;
      if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new HttpError(400, "expected_revision_required", "expectedRevision is required");
      }
      const version = await application.publishCorpusVersion(workspaceId, expectedRevision);
      sendJson(response, 201, version);
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/calibration/schema") {
      sendJson(response, 200, await application.getCalibrationSchema());
      return;
    }
    const voiceMatch = /^\/api\/v1\/voices\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && voiceMatch) {
      // Audit VC-MAJOR1: this route triggers a billable ElevenLabs lookup, so
      // it requires the session nonce like every other credential-consuming route.
      requireNonce(request, application);
      let voiceRef: string;
      try {
        voiceRef = decodeURIComponent(voiceMatch[1]);
      } catch {
        throw new HttpError(422, "invalid_voice_id", "invalid ElevenLabs voice ID");
      }
      sendJson(response, 200, await application.getVoiceName(voiceRef));
      return;
    }
    if (method === "POST" && url.pathname === "/api/v1/calibration-runs/dry-run") {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const input = isRecord(body.input) ? body.input : body;
      const run = await application.prepareDryRun({ ...input, workspaceId } as never);
      sendJson(response, 201, run);
      return;
    }

    const approveMatch = /^\/api\/v1\/calibration-runs\/[^/]+\/approve$/.test(url.pathname);
    if (method === "POST" && approveMatch) {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      if (typeof body.requestDigest !== "string")
        throw new HttpError(400, "request_digest_required", "requestDigest is required");
      sendJson(
        response,
        200,
        await application.approve(workspaceId, idFromPath(url.pathname), { requestDigest: body.requestDigest }),
      );
      return;
    }
    const executeMatch = /^\/api\/v1\/calibration-runs\/[^/]+\/execute$/.test(url.pathname);
    const enqueueMatch = /^\/api\/v1\/calibration-runs\/[^/]+\/enqueue$/.test(url.pathname);
    const jobMatch = /^\/api\/v1\/calibration-runs\/[^/]+\/job$/.test(url.pathname);
    if (options.jobQueue && (enqueueMatch || jobMatch || executeMatch)) {
      if (!selected.identity || !options.resolveApplication)
        throw new HttpError(403, "authenticated_queue_required", "Authenticated queue required");
      const identity = { ...selected.identity, workspaceId };
      const runId = idFromPath(url.pathname);
      if (method === "GET" && jobMatch) {
        const job = await options.jobQueue.get(identity, runId);
        if (!job) throw new NotFoundError("calibration job not found");
        sendJson(response, 200, job);
        return;
      }
      if (method === "POST" && (enqueueMatch || executeMatch)) {
        requireNonce(request, application);
        const body = await parseBody(request);
        assertRequestWorkspace(url, body, workspaceId);
        // Existing jobs need no MCP read: duplicates must remain responsive during calibration.
        let job = await options.jobQueue.get(identity, runId);
        if (!job || job.status === "awaiting_authentication") {
          const run = await application.getRun(workspaceId, runId);
          if (!run) throw new NotFoundError("calibration run not found");
          job = await options.jobQueue.enqueue(identity, run, async () => {
            const fresh = await options.resolveApplication!(request);
            if (
              fresh.workspaceId !== workspaceId ||
              fresh.identity?.tenantId !== identity.tenantId ||
              fresh.identity?.userId !== identity.userId
            )
              throw new HttpError(403, "workspace_forbidden", "Queued identity no longer authorized");
            return fresh.application;
          });
        }
        if (enqueueMatch) {
          sendJson(response, 202, job);
          return;
        }
        let status = job.status;
        while (status === "queued" || status === "running") {
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = (await options.jobQueue.get(identity, runId))!.status;
        }
        if (status === "awaiting_authentication")
          throw new HttpError(403, "queue_reauthentication_required", "Fresh authorization required for queued job");
        if (status === "execution_unknown")
          throw new HttpError(409, "execution_unknown", "Reconcile required; execution retry forbidden");
        const fresh = await options.resolveApplication(request);
        if (
          fresh.workspaceId !== workspaceId ||
          fresh.identity?.tenantId !== identity.tenantId ||
          fresh.identity?.userId !== identity.userId
        )
          throw new HttpError(403, "workspace_forbidden", "Queued identity no longer authorized");
        const result = await fresh.application.getRun(workspaceId, runId);
        if (!result) throw new NotFoundError("calibration run not found");
        const failure =
          result.status === "failed" ? executionHttpError(await fresh.application.getReport(workspaceId, runId)) : null;
        if (failure) throw failure;
        sendJson(response, 200, result);
        return;
      }
    }
    if (method === "POST" && executeMatch) {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const runId = idFromPath(url.pathname);
      const run = await application.execute(workspaceId, runId);
      const failure =
        run.status === "failed" ? executionHttpError(await application.getReport(workspaceId, runId)) : null;
      if (failure) throw failure;
      sendJson(response, 200, run);
      return;
    }
    const reconcileMatch = /^\/api\/v1\/calibration-runs\/[^/]+\/reconcile$/.test(url.pathname);
    if (method === "POST" && reconcileMatch) {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      sendJson(response, 200, await application.reconcile(workspaceId, idFromPath(url.pathname)));
      return;
    }
    const runMatch = /^\/api\/v1\/calibration-runs\/[^/]+$/.test(url.pathname);
    if (method === "GET" && runMatch) {
      const runId = idFromPath(url.pathname, false);
      const run = await application.getRun(workspaceId, runId);
      if (!run) throw new NotFoundError("calibration run not found");
      sendJson(response, 200, { ...run, report: await application.getReport(workspaceId, runId) });
      return;
    }
    if (
      (method === "GET" && url.pathname === "/api/v1/reusable-voice-profiles") ||
      (method === "POST" && (reusePublish || reuseRevoke))
    ) {
      if (!options.resolveApplication || !selected.identity)
        throw new HttpError(403, "authenticated_reuse_required", "Authenticated reuse identity required");
      if ([...url.searchParams.keys()].some((key) => key !== "workspaceId"))
        throw new HttpError(400, "invalid_reuse_scope", "Client reuse scope is forbidden");
      if (method === "POST") {
        requireNonce(request, application);
        const body = await parseBody(request);
        if (Object.keys(body).length !== 0)
          throw new HttpError(400, "invalid_reuse_scope", "Publication and revocation accept an empty object only");
      }
      const operation = reusePublish ? "publish" : reuseRevoke ? "revoke" : "catalog";
      const target = operation === "catalog" ? "" : idFromPath(url.pathname);
      sendJson(response, 200, await application.reusableProfiles(workspaceId, selected.identity, operation, target));
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/live-voice-profiles") {
      sendJson(response, 200, await application.getLiveProfiles(workspaceId));
      return;
    }
    if (method === "POST" && /^\/api\/v1\/live-voice-profiles\/[^/]+\/observations$/.test(url.pathname)) {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      sendJson(response, 200, await application.recordTikTokObservation(workspaceId, idFromPath(url.pathname), body));
      return;
    }
    if (method === "POST" && /^\/api\/v1\/calibration-runs\/[^/]+\/project-reference$/.test(url.pathname)) {
      requireNonce(request, application);
      assertRequestWorkspace(url, await parseBody(request), workspaceId);
      sendJson(response, 200, await application.projectVoiceReference(workspaceId, idFromPath(url.pathname)));
      return;
    }
    if (method === "GET" && url.pathname === "/api/v1/voice-profiles") {
      sendJson(response, 200, await application.listVoiceProfiles(workspaceId));
      return;
    }
    if (method === "POST" && url.pathname === "/api/v1/voice-profiles") {
      requireNonce(request, application);
      const body = await parseBody(request);
      assertRequestWorkspace(url, body, workspaceId);
      const runId = typeof body.runId === "string" ? body.runId : body.sourceRunId;
      if (typeof runId !== "string" || !runId) throw new HttpError(400, "run_id_required", "runId is required");
      sendJson(response, 201, await application.publishProfile(workspaceId, runId));
      return;
    }

    throw new HttpError(404, "not_found", "route not found");
  } catch (error) {
    bootstrapFailure("request", error);
    const status = statusForError(error);
    sendJson(response, status, { error: errorPayload(error) });
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function createCalibrationServer(options: CalibrationHttpServerOptions): Server {
  if (Boolean(options.application) === Boolean(options.resolveApplication))
    throw new Error("Exactly one application source is required");
  const workspaceId = options.workspaceId === undefined ? DEFAULT_WORKSPACE : options.workspaceId;
  assertWorkspaceId(workspaceId);
  const fixedOptions = { ...options, workspaceId };
  return createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/api/v1/bootstrap") {
      void bootstrapRequest(request.headers.authorization, (id) => {
        response.setHeader("x-correlation-id", id);
        return dispatch(request, response, fixedOptions);
      });
    } else void dispatch(request, response, fixedOptions);
  });
}

export const createCalibrationHttpServer = createCalibrationServer;

function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startCalibrationUi(options: CalibrationHttpServerOptions): Promise<CalibrationUiHandle> {
  assertWorkspaceId(options.workspaceId === undefined ? DEFAULT_WORKSPACE : options.workspaceId);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!isLoopbackHost(host) && !options.allowNetwork) {
    throw new Error(
      "non-loopback host requires --allow-network; this exposes an unauthenticated local credential consumer",
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("port must be an integer from 0 to 65535");
  const server = createCalibrationServer({ ...options, host, port });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("unable to determine calibration UI address");
  }
  const url = `http://${urlHost(host)}:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    server,
    url,
    async close() {
      closing ??= (async () => {
        const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        const applicationsClosed = (async () => {
          if (!options.jobQueue) await httpClosed;
          if (options.resolveApplication) await options.closeApplications();
          else await options.application.close();
        })();
        const results = await Promise.allSettled([httpClosed, applicationsClosed]);
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "API shutdown failed",
          );
      })();
      return closing;
    },
  };
}
