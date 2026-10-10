/**
 * Public API of the voice-calibration package. Any consumer (the `capcut-david`
 * engine's `calibration-ui` adapter, or other hosts) uses exactly this surface;
 * the standalone `voice-calibration` bin wraps the same entrypoint.
 */
export {
  type CalibrationUiOptions,
  openInBrowser,
  startVoiceCalibrationUi,
} from "./calibration/entrypoint.js";
export type { CalibrationUiHandle } from "./calibration/http-server.js";
export { startSupabaseCalibrationApi, type SupabaseAuthOptions, type TenantWorkspaceOptions } from "./calibration/supabase-auth.js";
export { EngineManager, type CalibrationEngine, type EngineRegistration, type EngineManagerOptions } from "./calibration/engine-manager.js";
export { CalibrationJobQueue, type CalibrationJob, type JobIdentity } from "./calibration/job-queue.js";
export { DockerMcpStdioTransport, type DockerEngineOptions } from "./calibration/docker-transport.js";
