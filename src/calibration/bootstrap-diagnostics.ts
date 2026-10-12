import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { redactSensitive } from "./redaction.js";

interface Context {
  correlationId: string;
  started: number;
  secrets: string[];
  redactors: ((value: unknown) => unknown)[];
  logged: boolean;
  closed: boolean;
}
const context = new AsyncLocalStorage<Context>();

export function bootstrapSecret(secret: string | undefined): void {
  const active = context.getStore();
  if (secret && active && !active.closed) active.secrets.push(secret);
}

export function bootstrapRedactor(redactor: ((value: unknown) => unknown) | undefined): void {
  const active = context.getStore();
  if (redactor && active && !active.closed) active.redactors.push(redactor);
}

export async function bootstrapRequest<T>(
  authorization: string | undefined,
  run: (id: string) => T | Promise<T>,
): Promise<T> {
  const correlationId = randomUUID();
  const active: Context = {
    correlationId,
    started: performance.now(),
    secrets: [],
    redactors: [],
    logged: false,
    closed: false,
  };
  return context.run(active, async () => {
    bootstrapSecret(authorization);
    bootstrapSecret(/^Bearer (\S+)$/i.exec(authorization ?? "")?.[1]);
    try {
      return await run(correlationId);
    } finally {
      active.closed = true;
      active.secrets.length = 0;
      active.redactors.length = 0;
    }
  });
}

export function bootstrapFailure(stage: string, error: unknown, started?: number): void {
  const active = context.getStore();
  if (!active || active.closed) return;
  const status = (error as { status?: number })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return;
  if (!active.logged) {
    active.logged = true;
    // Logging must preserve the original failure and must never fall back to unredacted details.
    try {
      const failure = error as Error & { code?: unknown; stderr?: unknown; cause?: Error };
      let details: unknown = {
        name: failure?.name,
        message: failure?.message ?? String(error),
        code: failure?.code,
        stack: failure?.stack,
        stderr: failure?.stderr,
        cause: failure?.cause
          ? {
              name: failure.cause.name,
              message: failure.cause.message,
              code: (failure.cause as Error & { code?: unknown }).code,
            }
          : undefined,
      };
      for (const redact of active.redactors) details = redact(details);
      const safe = redactSensitive(details, active.secrets) as Record<string, unknown>;
      for (const key of Object.keys(safe)) if (typeof safe[key] === "string") safe[key] = safe[key].slice(0, 4096);
      console.error(
        JSON.stringify({
          event: "bootstrap_failed",
          timestamp: new Date().toISOString(),
          correlationId: active.correlationId,
          stage,
          durationMs: Math.round(performance.now() - (started ?? active.started)),
          requestDurationMs: Math.round(performance.now() - active.started),
          error: safe,
        }),
      );
    } catch {
      // A failed diagnostic sink must not alter execution or expose the raw exception.
    }
  }
}

export async function bootstrapStage<T>(stage: string, run: () => T | Promise<T>): Promise<T> {
  if (!context.getStore()) return run();
  const started = performance.now();
  try {
    return await run();
  } catch (error) {
    bootstrapFailure(stage, error, started);
    throw error;
  }
}
