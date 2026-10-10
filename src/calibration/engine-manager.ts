import { type CalibrationApplication, UnavailableError } from "./application.js";
import { assertWorkspaceId } from "./domain.js";

// The API contract contains public operations, independent of a local process or remote adapter.
export type CalibrationEngine = Pick<CalibrationApplication, keyof CalibrationApplication>;

export interface EngineRegistration {
  workspaceId: string;
  create(): Promise<CalibrationEngine>;
}

export interface EngineManagerOptions {
  maxConcurrentStarts?: number;
  idleTimeoutMs?: number;
}

interface Slot {
  create: EngineRegistration["create"];
  facade: CalibrationEngine;
  engine?: CalibrationEngine;
  transition?: Promise<void>;
  stopping?: Promise<void>;
  blocked: boolean;
  active: number;
  drained?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleStopping?: boolean;
  idleStopFailed?: boolean;
}

export class EngineManager {
  private readonly slots = new Map<string, Slot>();
  private closing?: Promise<void>;
  private closed = false;
  private readonly maxConcurrentStarts: number;
  private readonly idleTimeoutMs: number;
  private starting = 0;
  private readonly startupQueue: (() => void)[] = [];

  constructor(registrations: readonly EngineRegistration[], options: EngineManagerOptions = {}) {
    this.maxConcurrentStarts = options.maxConcurrentStarts === undefined ? 1 : options.maxConcurrentStarts;
    if (!Number.isSafeInteger(this.maxConcurrentStarts) || this.maxConcurrentStarts < 1)
      throw new TypeError("maxConcurrentStarts must be a positive safe integer");
    this.idleTimeoutMs = options.idleTimeoutMs === undefined ? 600_000 : options.idleTimeoutMs;
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1 || this.idleTimeoutMs > 2_147_483_647)
      throw new TypeError("idleTimeoutMs must be an integer between 1 and 2147483647");
    for (const registration of registrations) {
      assertWorkspaceId(registration.workspaceId);
      if (this.slots.has(registration.workspaceId)) throw new Error("Duplicate engine registration");
      const slot: Slot = { create: registration.create, facade: {} as CalibrationEngine, blocked: true, active: 0 };
      slot.facade = new Proxy({} as CalibrationEngine, {
        get: (_target, property) => {
          if (property === "then") return undefined;
          if (property === "close") return () => this.stop(slot);
          return (...args: unknown[]) => {
            if (this.closed || slot.blocked || slot.stopping || !slot.engine)
              throw new UnavailableError("Calibration engine unavailable");
            const engine = slot.engine;
            const method = Reflect.get(engine, property);
            if (typeof method !== "function") throw new TypeError("Unknown calibration operation");
            this.clearIdle(slot);
            slot.active++;
            const release = () => {
              slot.active--;
              if (slot.active === 0) slot.drained?.();
              this.armIdle(slot);
            };
            try {
              const result = Reflect.apply(method, engine, args);
              if (result instanceof Promise) return result.finally(release);
              release();
              return result;
            } catch (error) { release(); throw error; }
          };
        },
      });
      this.slots.set(registration.workspaceId, slot);
    }
  }

  application(workspaceId: string): CalibrationEngine {
    return this.slot(workspaceId).facade;
  }

  private slot(workspaceId: string): Slot {
    const slot = this.slots.get(workspaceId);
    if (!slot) throw new Error("Unregistered calibration workspace");
    return slot;
  }

  start(workspaceId: string): Promise<void> {
    if (this.closed) return Promise.reject(new UnavailableError("Engine manager closed"));
    const slot = this.slot(workspaceId);
    if (slot.stopping && slot.idleStopping) return slot.stopping.then(() => this.start(workspaceId));
    if (slot.stopping) return Promise.reject(new UnavailableError("Calibration engine stopping"));
    if (slot.idleStopFailed) return Promise.reject(new UnavailableError("Automatic engine shutdown failed; explicit restart required"));
    if (slot.transition) return slot.transition;
    if (slot.engine && !slot.blocked) { this.armIdle(slot); return Promise.resolve(); }
    return this.replace(slot);
  }

  restart(workspaceId: string): Promise<void> {
    if (this.closed) return Promise.reject(new UnavailableError("Engine manager closed"));
    const slot = this.slot(workspaceId);
    if (slot.stopping) return Promise.reject(new UnavailableError("Calibration engine stopping"));
    // Concurrent lifecycle requests share the same replacement; no operation is replayed.
    if (slot.transition) return slot.transition;
    return this.replace(slot);
  }

  private drain(slot: Slot): Promise<void> {
    if (slot.active === 0) return Promise.resolve();
    return new Promise((resolve) => { slot.drained = resolve; });
  }

  private clearIdle(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
  }

  private armIdle(slot: Slot): void {
    this.clearIdle(slot);
    if (this.closed || slot.blocked || slot.active || slot.transition || slot.stopping || !slot.engine) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      if (this.closed || slot.blocked || slot.active || slot.transition || slot.stopping || !slot.engine) return;
      slot.idleStopping = true;
      // A failed automatic shutdown stays blocked until explicit supervision.
      void this.stop(slot).catch(() => { slot.idleStopFailed = true; })
        .finally(() => { slot.idleStopping = false; });
    }, this.idleTimeoutMs);
    slot.idleTimer.unref?.();
  }

  private async acquireStartup(): Promise<() => void> {
    if (this.starting < this.maxConcurrentStarts) this.starting++;
    else await new Promise<void>((resolve) => { this.startupQueue.push(resolve); });
    return () => {
      const next = this.startupQueue.shift();
      if (next) next();
      else this.starting--;
    };
  }

  private replace(slot: Slot): Promise<void> {
    this.clearIdle(slot);
    slot.blocked = true;
    const transition = (async () => {
      await this.drain(slot);
      if (slot.engine) {
        // Keep the old handle if shutdown fails: never spawn a competing process.
        await slot.engine.close();
        slot.engine = undefined;
        slot.idleStopFailed = false;
      }
      if (this.closed) return;
      const release = await this.acquireStartup();
      try {
        if (this.closed || slot.stopping) return;
        slot.engine = await slot.create();
        slot.blocked = false;
      } finally { release(); }
    })();
    slot.transition = transition.finally(() => {
      slot.transition = undefined; slot.drained = undefined; this.armIdle(slot);
    });
    return slot.transition;
  }

  private stop(slot: Slot): Promise<void> {
    this.clearIdle(slot);
    if (slot.stopping) return slot.stopping;
    slot.blocked = true;
    slot.stopping = (async () => {
      await slot.transition?.catch(() => undefined);
      slot.blocked = true;
      await this.drain(slot);
      if (slot.engine) { await slot.engine.close(); slot.engine = undefined; slot.idleStopFailed = false; }
    })().finally(() => { slot.stopping = undefined; slot.drained = undefined; });
    return slot.stopping;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.slots.values()].map((slot) => this.stop(slot)));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Engine shutdown failed");
    })();
    return this.closing;
  }
}
