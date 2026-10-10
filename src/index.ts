/**
 * Public API of the voice-calibration package. Any consumer (the `capcut-david`
 * engine's `calibration-ui` adapter, or other hosts) uses exactly this surface;
 * the standalone `voice-calibration` bin wraps the same entrypoint.
 */

export { type DockerEngineOptions, DockerMcpStdioTransport } from "./calibration/docker-transport.js";
export {
  type CalibrationEngine,
  EngineManager,
  type EngineManagerOptions,
  type EngineRegistration,
} from "./calibration/engine-manager.js";
export {
  type CalibrationUiOptions,
  openInBrowser,
  startVoiceCalibrationUi,
} from "./calibration/entrypoint.js";
export type { CalibrationUiHandle } from "./calibration/http-server.js";
export { type CalibrationJob, CalibrationJobQueue, type JobIdentity } from "./calibration/job-queue.js";
export {
  type SupabaseAuthOptions,
  startSupabaseCalibrationApi,
  type TenantWorkspaceOptions,
} from "./calibration/supabase-auth.js";
