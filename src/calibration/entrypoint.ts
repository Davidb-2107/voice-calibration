import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createCalibrationApplication } from "./application.js";
import { createCalibrationBridge, createCanonicalProfilePort } from "./bridge.js";
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
import { createLocalStore } from "./ports.js";

export interface CalibrationUiOptions {
  workspaceId?: string;
  dataDir?: string;
  host?: string;
  port?: number;
  allowNetwork?: boolean;
  credentials?: Pick<CredentialOptions, "env" | "envFile">;
  wpmPath?: string;
}

export async function startVoiceCalibrationUi(options: CalibrationUiOptions = {}): Promise<CalibrationUiHandle> {
  const workspaceId = options.workspaceId === undefined ? "local-default" : options.workspaceId;
  assertWorkspaceId(workspaceId);
  const cwd = process.cwd();
  const environment = { ...process.env };
  const { dataDir, host, port, allowNetwork } = options;
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
        ([key, value]) => key !== "_default" && (!value || typeof value !== "object" || Array.isArray(value)),
      )
    ) {
      throw new Error("Invalid WPM corpus");
    }
  } else {
    const implicitPath = environment.VOICE_WPM_PATH ?? historicalWpmPath;
    wpmPath = implicitPath?.trim() ? resolve(cwd, implicitPath) : undefined;
  }
  const referenceBase = wpmPath && wpmPath === historicalWpmPath
    ? "Shared/voice-calibration/voice_wpm.json" : undefined;
  const language = environment.VOICE_CALIBRATION_LANGUAGE === "en" ? "en" : "fr";
  const credentials = createCredentialProvider({ env: secret === undefined ? {} : { ELEVENLABS_API_KEY: secret } });
  const configurationIdentity =
    secret === undefined
      ? undefined
      : fingerprintConfiguration({ workspaceId, provider: "elevenlabs", wpmPath }, secret);
  const application = createCalibrationApplication({
    repositories: createLocalStore(dataDir),
    configurationIdentity,
    bridge: createCalibrationBridge({ credentials, wpmPath }),
    canonical: createCanonicalProfilePort({ wpmPath, language, referenceBase }),
    credentials,
    voiceDirectory: createVoiceDirectoryProvider({ credentials }),
  });
  return startCalibrationUi({
    application,
    workspaceId,
    host,
    port: port ?? 0,
    allowNetwork,
  });
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
