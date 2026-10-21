import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { bootstrapStage } from "./bootstrap-diagnostics.js";
import { BridgeTransportError, NodeMcpStdioTransport } from "./bridge.js";
import { assertWorkspaceId } from "./domain.js";
import { assertNoSymlinkWithin, canonicalLocalPath } from "./local-store.js";

export interface DockerEngineOptions {
  image: string;
  root: string;
  tenantId: string;
  workspaceId: string;
  wpmPath: string;
  stateDir: string;
  uiWorkspaceDir: string;
  restoreGuardDir?: string;
}

export class DockerMcpStdioTransport extends NodeMcpStdioTransport {
  readonly instanceStateDir: string;
  readonly hostRoot: string;
  readonly binding: DockerEngineOptions;
  private readonly containerName: string;
  private readonly corpusPath: string;
  private prepared?: Promise<void>;
  private starting?: Promise<void>;
  private containerClosing?: Promise<void>;
  private readonly startupTimeoutMs = 30_000;
  private stopped = false;

  constructor(options: DockerEngineOptions) {
    assertWorkspaceId(options.tenantId);
    assertWorkspaceId(options.workspaceId);
    if (!/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error("Immutable local Docker image ID required");
    const root = canonicalLocalPath(options.root);
    if (root.includes(",")) throw new Error("Docker mount path cannot contain commas");
    const inside = (path: string) => {
      const part = relative(root, canonicalLocalPath(path));
      if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
        throw new Error("Engine resource must be inside its private root");
      return `/workspace/${part.split(sep).join("/")}`;
    };
    const launch = {
      tenantId: options.tenantId,
      workspaceId: options.workspaceId,
      wpmPath: inside(options.wpmPath),
      stateDir: inside(options.stateDir),
      uiWorkspaceDir: inside(options.uiWorkspaceDir),
    };
    const writable = [canonicalLocalPath(options.stateDir), dirname(canonicalLocalPath(options.wpmPath))];
    const ui = canonicalLocalPath(options.uiWorkspaceDir);
    const restoreGuard = options.restoreGuardDir ? canonicalLocalPath(options.restoreGuardDir) : undefined;
    if (restoreGuard) {
      for (const [parent, child] of [
        [root, restoreGuard],
        [restoreGuard, root],
      ]) {
        const part = relative(parent, child);
        if (restoreGuard.includes(",") || !part || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)))
          throw new Error("Restore control must be outside the restored workspace");
      }
    }
    for (const path of writable) {
      inside(path);
      for (const [parent, child] of [
        [path, ui],
        [ui, path],
      ]) {
        const part = relative(parent, child);
        if (!part || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)))
          throw new Error("Writable engine resources overlap protected UI");
      }
    }
    const containerName = `calibration-engine-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--user=10001:10001",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=512m",
      "--cpus=1",
      "--pids-limit=64",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
      "--mount",
      `type=bind,src=${root},dst=/workspace,readonly`,
      ...writable.flatMap((path) => ["--mount", `type=bind,src=${path},dst=${inside(path)}`]),
      "--mount",
      `type=bind,src=${join(ui, ".instance.lock")},dst=${launch.uiWorkspaceDir}/.instance.lock`,
      ...(restoreGuard
        ? [
            "--mount",
            `type=bind,src=${restoreGuard},dst=/restore-control,readonly`,
            "--mount",
            `type=bind,src=${join(restoreGuard, "provider-registry")},dst=/provider-registry`,
            "--env",
            "VOICE_CALIBRATION_RESTORE_GUARD_PATH=/restore-control/guard.json",
            "--env",
            "VOICE_CALIBRATION_PROVIDER_REGISTRY_DIR=/provider-registry",
            "--env",
            "VOICE_CALIBRATION_PROVIDER_REGISTRY_KEY=/restore-control/provider-registry.key",
          ]
        : []),
      "--env",
      "HOME=/tmp",
      "--env",
      "ELEVENLABS_API_KEY",
      ...Object.entries({
        VOICE_WPM_PATH: launch.wpmPath,
        VOICE_CALIBRATION_STATE_DIR: launch.stateDir,
        VOICE_CALIBRATION_UI_WORKSPACE_DIR: launch.uiWorkspaceDir,
        VOICE_CALIBRATION_WORKSPACE_ID: launch.workspaceId,
        VOICE_CALIBRATION_TENANT_ID: launch.tenantId,
      }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      options.image,
      "/opt/venv/bin/python",
      "-I",
      "-m",
      "voice_calibration.mcp_server.server",
    ];
    super("docker", args, undefined, launch);
    this.instanceStateDir = launch.stateDir;
    this.hostRoot = root;
    this.binding = Object.freeze({
      ...options,
      root,
      wpmPath: canonicalLocalPath(options.wpmPath),
      stateDir: canonicalLocalPath(options.stateDir),
      uiWorkspaceDir: canonicalLocalPath(options.uiWorkspaceDir),
      restoreGuardDir: restoreGuard,
    });
    this.containerName = containerName;
    this.corpusPath = launch.wpmPath;
  }

  override async schema(secret: string, timeoutMs: number): Promise<unknown> {
    this.prepared ??= (async () => {
      await mkdir(this.binding.stateDir, { recursive: true });
      await mkdir(dirname(this.binding.wpmPath), { recursive: true });
      await mkdir(this.binding.uiWorkspaceDir, { recursive: true });
      const lockPath = join(this.binding.uiWorkspaceDir, ".instance.lock");
      await assertNoSymlinkWithin(this.hostRoot, lockPath);
      if (this.binding.restoreGuardDir) {
        await assertNoSymlinkWithin(this.binding.restoreGuardDir, join(this.binding.restoreGuardDir, "guard.json"));
        await assertNoSymlinkWithin(
          this.binding.restoreGuardDir,
          join(this.binding.restoreGuardDir, "provider-registry", "provider.sqlite3"),
        );
        await assertNoSymlinkWithin(
          this.binding.restoreGuardDir,
          join(this.binding.restoreGuardDir, "provider-registry.key"),
        );
      }
      const lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      await lock.close();
    })();
    await this.prepared;
    return bootstrapStage("mcp_handshake", () => super.schema(secret, timeoutMs));
  }

  protected override async start(secret: string): Promise<void> {
    if (this.stopped)
      throw new BridgeTransportError("Engine container startup closed", false, "", "ENGINE_STARTUP_FAILED");
    this.ensureChild(secret);
    this.starting ??= bootstrapStage("container_start", async () => {
      const deadline = performance.now() + this.startupTimeoutMs;
      try {
        while (!this.stopped) {
          this.ensureChild(secret);
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new BridgeTransportError("Engine container startup timed out", false, "", "ENGINE_STARTUP_TIMEOUT");
          const running = await this.inspectRunning(Math.min(1_000, remaining));
          if (performance.now() >= deadline)
            throw new BridgeTransportError("Engine container startup timed out", false, "", "ENGINE_STARTUP_TIMEOUT");
          if (running && !this.stopped) return;
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))));
        }
        throw new BridgeTransportError("Engine container startup closed", false, "", "ENGINE_STARTUP_FAILED");
      } catch (error) {
        try {
          await this.close();
        } catch {
          throw new BridgeTransportError(
            "Engine container startup failed; cleanup unconfirmed",
            false,
            "",
            "ENGINE_STARTUP_FAILED",
          );
        }
        if (error instanceof BridgeTransportError && error.code === "ENGINE_STARTUP_TIMEOUT") throw error;
        throw new BridgeTransportError("Engine container startup failed", false, "", "ENGINE_STARTUP_FAILED");
      }
    });
    await this.starting;
  }

  private async inspectRunning(timeout: number): Promise<boolean> {
    try {
      const result = await promisify(execFile)(
        "docker",
        ["inspect", "--format", "{{.State.Running}}", this.containerName],
        { timeout, windowsHide: true },
      );
      return result.stdout.trim() === "true";
    } catch (error) {
      const failure = error as Error & { stderr?: string; killed?: boolean };
      if (failure.killed || /No such (container|object)/i.test(String(failure.stderr))) return false;
      throw error;
    }
  }

  async readCorpus(secret: string): Promise<string> {
    await this.schema(secret, 10_000);
    // Resolve mutable workspace paths only inside its private mount namespace.
    const result = await promisify(execFile)(
      "docker",
      [
        "exec",
        this.containerName,
        "/opt/venv/bin/python",
        "-I",
        "-c",
        'import sys; from pathlib import Path; sys.stdout.write(Path(sys.argv[1]).read_text(encoding="utf-8"))',
        this.corpusPath,
      ],
      { timeout: 10_000, maxBuffer: Infinity },
    );
    return result.stdout;
  }

  override async close(): Promise<void> {
    this.stopped = true;
    this.containerClosing ??= (async () => {
      try {
        await super.close();
      } finally {
        // The trusted host owns cleanup; a stuck engine cannot keep its container alive.
        await this.removeContainer();
      }
    })();
    return this.containerClosing;
  }

  private async removeContainer(): Promise<void> {
    await promisify(execFile)("docker", ["rm", "--force", this.containerName], {
      timeout: 10_000,
      windowsHide: true,
    }).catch((error) => {
      if (!/No such (container|object)/i.test(String(error.stderr))) throw error;
    });
  }
}
