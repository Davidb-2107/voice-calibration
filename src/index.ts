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
