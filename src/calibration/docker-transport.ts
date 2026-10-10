import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { NodeMcpStdioTransport } from "./bridge.js";
import { canonicalLocalPath } from "./local-store.js";
import { assertWorkspaceId } from "./domain.js";

export interface DockerEngineOptions {
  image: string;
  root: string;
  tenantId: string;
  workspaceId: string;
  wpmPath: string;
  stateDir: string;
  uiWorkspaceDir: string;
}

export class DockerMcpStdioTransport extends NodeMcpStdioTransport {
  readonly instanceStateDir: string;
  readonly hostRoot: string;
  readonly binding: DockerEngineOptions;
  private readonly containerName: string;

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
    const launch = { tenantId: options.tenantId, workspaceId: options.workspaceId,
      wpmPath: inside(options.wpmPath), stateDir: inside(options.stateDir), uiWorkspaceDir: inside(options.uiWorkspaceDir) };
    const containerName = `calibration-engine-${randomUUID()}`;
    const args = ["run", "--rm", "-i", "--name", containerName, "--pull=never", "--network=none",
      "--read-only", "--user=10001:10001", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--memory=512m", "--cpus=1", "--pids-limit=64", "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001",
      "--mount", `type=bind,src=${root},dst=/workspace`,
      "--env", "HOME=/tmp", "--env", "ELEVENLABS_API_KEY",
      ...Object.entries({ VOICE_WPM_PATH: launch.wpmPath, VOICE_CALIBRATION_STATE_DIR: launch.stateDir,
        VOICE_CALIBRATION_UI_WORKSPACE_DIR: launch.uiWorkspaceDir, VOICE_CALIBRATION_WORKSPACE_ID: launch.workspaceId,
        VOICE_CALIBRATION_TENANT_ID: launch.tenantId }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      options.image, "/opt/venv/bin/python", "-I", "-m", "voice_calibration.mcp_server.server"];
    super("docker", args, undefined, launch);
    this.instanceStateDir = launch.stateDir;
    this.hostRoot = root;
    this.binding = Object.freeze({ ...options, root, wpmPath: canonicalLocalPath(options.wpmPath),
      stateDir: canonicalLocalPath(options.stateDir), uiWorkspaceDir: canonicalLocalPath(options.uiWorkspaceDir) });
    this.containerName = containerName;
  }

  override async close(): Promise<void> {
    try { await super.close(); }
    finally {
      // The trusted host owns cleanup; a stuck engine cannot keep its container alive.
      await promisify(execFile)("docker", ["rm", "--force", this.containerName], { timeout: 10_000 }).catch((error) => {
        if (!/No such (container|object)/i.test(String(error.stderr))) throw error;
      });
    }
  }
}
