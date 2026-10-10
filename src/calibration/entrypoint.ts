import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type CalibrationApplication, createCalibrationApplication } from "./application.js";
import { type CalibrationTransport, createCalibrationBridge, createCanonicalProfilePort } from "./bridge.js";
import {
  type CredentialOptions,
  createCredentialProvider,
  createVoiceDirectoryProvider,
  findVaultRoot,
  parseDotEnv,
} from "./credentials.js";
import { assertWorkspaceId } from "./domain.js";
import { fingerprintConfiguration } from "./fingerprint.js";
import { type CalibrationUiHandle, startCalibrationUi } from "./http-server.js";
import { canonicalLocalPath, resolveLocalDataDir } from "./local-store.js";
import { createLocalStore } from "./ports.js";

export interface CalibrationUiOptions {
  tenantId?: string;
  workspaceId?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  allowNetwork?: boolean;
  credentials?: Pick<CredentialOptions, "env" | "envFile">;
  wpmPath?: string;
  stateDir?: string;
  mcpTransport?: CalibrationTransport;
}

export async function createVoiceCalibrationApplication(
  options: CalibrationUiOptions = {},
  onExit?: () => void,
): Promise<CalibrationApplication> {
  const workspaceId = options.workspaceId === undefined ? "local-default" : options.workspaceId;
  assertWorkspaceId(workspaceId);
  if (options.tenantId !== undefined) {
    assertWorkspaceId(options.tenantId);
    if (workspaceId === "local-default") throw new Error("Tenant requires a named workspace");
  }
  const cwd = process.cwd();
  const environment = { ...process.env };
  const { dataDir } = options;
  const suppliedStateDir = options.stateDir;
  if (suppliedStateDir !== undefined && (typeof suppliedStateDir !== "string" || !suppliedStateDir.trim())) {
    throw new Error("Invalid MCP state directory");
  }
  const boundInstance = workspaceId !== "local-default" || suppliedStateDir !== undefined;
  const resolvedDataDir = resolveLocalDataDir(dataDir);
  const stateDir = boundInstance
    ? canonicalLocalPath(
        suppliedStateDir === undefined ? resolve(resolvedDataDir, "mcp") : resolve(cwd, suppliedStateDir),
      )
    : undefined;
  const suppliedCredentials = options.credentials;
  const suppliedWpmPath = options.wpmPath;
  if (workspaceId !== "local-default" && (suppliedCredentials === undefined || suppliedWpmPath === undefined)) {
    throw new Error("Explicit credentials and WPM path are required");
  }

  let secret: string | undefined;
  if (suppliedCredentials !== undefined) {
    if (!suppliedCredentials || typeof suppliedCredentials !== "object" || Array.isArray(suppliedCredentials)) {
      throw new Error("Invalid explicit credentials");
    }
    const hasEnv = Object.hasOwn(suppliedCredentials, "env");
    const hasFile = Object.hasOwn(suppliedCredentials, "envFile");
    if (hasEnv === hasFile || Object.keys(suppliedCredentials).some((key) => key !== "env" && key !== "envFile")) {
      throw new Error("Exactly one credential source is required");
    }
    if (hasEnv) {
      const env = suppliedCredentials.env;
      if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Invalid credential environment");
      secret = env.ELEVENLABS_API_KEY;
    } else {
      const file = suppliedCredentials.envFile;
      if (typeof file !== "string" || !file.trim()) throw new Error("Invalid credential file path");
      try {
        secret = parseDotEnv(readFileSync(resolve(cwd, file), "utf8")).ELEVENLABS_API_KEY;
      } catch {
        throw new Error("Credential file is unavailable");
      }
    }
    if (typeof secret !== "string" || !secret.trim()) throw new Error("ElevenLabs API key is not configured");
    secret = secret.trim();
  } else {
    try {
      secret = (await createCredentialProvider({ cwd }).forRun()).secret;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "ElevenLabs API key is not configured") throw error;
    }
  }

  let wpmPath: string | undefined;
  const vault = findVaultRoot(cwd);
  const historicalWpmPath = vault ? resolve(vault, "Shared", "voice-calibration", "voice_wpm.json") : undefined;
  if (suppliedWpmPath !== undefined) {
    if (typeof suppliedWpmPath !== "string" || !suppliedWpmPath.trim()) throw new Error("Invalid WPM path");
    wpmPath = resolve(cwd, suppliedWpmPath);
    let corpus: unknown;
    try {
      corpus = JSON.parse(readFileSync(wpmPath, "utf8"));
    } catch {
      throw new Error("WPM file is unavailable or invalid");
    }
    if (
      !corpus ||
      typeof corpus !== "object" ||
      Array.isArray(corpus) ||
      Object.entries(corpus).some(
        ([key, value]) => !key.startsWith("_") && (!value || typeof value !== "object" || Array.isArray(value)),
      )
    ) {
      throw new Error("Invalid WPM corpus");
    }
  } else {
    const implicitPath = environment.VOICE_WPM_PATH ?? historicalWpmPath;
    wpmPath = implicitPath?.trim() ? resolve(cwd, implicitPath) : undefined;
  }
  const referenceBase =
    wpmPath && wpmPath === historicalWpmPath ? "Shared/voice-calibration/voice_wpm.json" : undefined;
  if (boundInstance && wpmPath) wpmPath = canonicalLocalPath(wpmPath);
  const language = environment.VOICE_CALIBRATION_LANGUAGE === "en" ? "en" : "fr";
  const credentials = createCredentialProvider({ env: secret === undefined ? {} : { ELEVENLABS_API_KEY: secret } });
  const configurationIdentity =
    secret === undefined
      ? undefined
      : fingerprintConfiguration(
          { tenantId: options.tenantId, workspaceId, provider: "elevenlabs", wpmPath, stateDir },
          secret,
        );
  const bridge = createCalibrationBridge({
    credentials,
    wpmPath,
    tenantId: options.tenantId,
    transport: options.mcpTransport,
    ...(boundInstance
      ? { workspaceId, stateDir, uiWorkspaceDir: resolve(resolvedDataDir, "workspaces", workspaceId) }
      : {}),
  });
  const application = createCalibrationApplication({
    repositories: createLocalStore(resolvedDataDir),
    configurationIdentity,
    bridge,
    canonical: createCanonicalProfilePort({ wpmPath, language, referenceBase }),
    credentials,
    voiceDirectory: createVoiceDirectoryProvider({ credentials }),
  });
  let exited = false;
  if (boundInstance)
    bridge.onExit?.(() => {
      exited = true;
      if (onExit) onExit();
      else void application.close();
    });
  try {
    if (boundInstance) await bridge.getSchema();
    if (exited) throw new Error("MCP process exited; restart the calibration instance");
    return application;
  } catch (error) {
    await application.close();
    throw error;
  }
}

export async function startVoiceCalibrationUi(options: CalibrationUiOptions = {}): Promise<CalibrationUiHandle> {
  let ui: CalibrationUiHandle | undefined;
  let exited = false;
  const application = await createVoiceCalibrationApplication(options, () => {
    exited = true;
    if (ui) void ui.close();
  });
  try {
    if (exited) throw new Error("MCP process exited; restart the calibration instance");
    ui = await startCalibrationUi({
      application,
      workspaceId: options.workspaceId,
      host: options.host,
      port: options.port ?? 0,
      allowNetwork: options.allowNetwork,
    });
    if (exited) {
      await ui.close();
      throw new Error("MCP process exited; restart the calibration instance");
    }
    return ui;
  } catch (error) {
    await application.close();
    throw error;
  }
}

export function openInBrowser(target: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
