import { createHash } from "node:crypto";
import type { CalibrationRun, VoiceProfile } from "./domain.js";

// Portable projection: projects consume the measured dataset, never a detached WPM constant.
export function projectProfilePackage(run: CalibrationRun, published: VoiceProfile, record: Record<string, unknown>) {
  if (
    run.executionProvider !== "elevenlabs" ||
    run.status !== "succeeded" ||
    run.request.postproc !== "cut" ||
    published.sourceRunId !== run.id
  )
    throw new Error("Un calibrage CUT réussi et publié est requis.");
  const params = run.request.params;
  const language = params.language;
  const suppliedSettings = params.voice_settings;
  if (
    !["fr", "en"].includes(String(language)) ||
    typeof params.model_id !== "string" ||
    !suppliedSettings ||
    typeof suppliedSettings !== "object" ||
    Array.isArray(suppliedSettings)
  )
    throw new Error("Les paramètres de synthèse publiés sont incomplets.");
  const settings = Object.fromEntries(Object.entries(suppliedSettings).filter(([, value]) => value != null));
  const allowedSettings = new Set(["stability", "similarity_boost", "style", "use_speaker_boost", "speed"]);
  if (
    !Object.keys(settings).length ||
    Object.entries(settings).some(
      ([key, value]) =>
        !allowedSettings.has(key) ||
        (key === "use_speaker_boost"
          ? typeof value !== "boolean"
          : typeof value !== "number" || !Number.isFinite(value)),
    )
  )
    throw new Error("Les réglages effectifs de synthèse ne sont pas supportés.");
  const stored =
    language === "en"
      ? (record.profiles_by_lang as Record<string, Record<string, unknown>> | undefined)?.en
      : (record.profile as Record<string, unknown> | undefined);
  const sorted = (value: unknown) =>
    JSON.stringify(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry != null)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  if (
    !stored ||
    stored.voice_id !== run.request.voiceRef ||
    stored.model_id !== params.model_id ||
    sorted(stored.voice_settings ?? {}) !== sorted(settings)
  )
    throw new Error("Le corpus ne correspond plus aux paramètres du profil publié.");
  const observations = (Array.isArray(record.observed_runs) ? record.observed_runs : [])
    .filter((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const observation = row as Record<string, unknown>;
      return (
        observation.source_run_id === run.id &&
        observation.language === language &&
        observation.postproc === "cut" &&
        observation.verified === true &&
        observation.outlier_excluded !== true
      );
    })
    .map((observation) =>
      Object.fromEntries(
        [
          "slug",
          "date",
          "words",
          "duration_s",
          "wpm_actual",
          "verified",
          "language",
          "postproc",
          "style",
          "duration_raw_s",
          "duration_trimmed_s",
          "source_run_id",
        ]
          .filter((key) => observation[key] !== undefined)
          .map((key) => [key, observation[key]]),
      ),
    );
  if (!observations.length || !observations.some((row) => row.source_run_id === run.id))
    throw new Error("Les mesures CUT vérifiées du run publié sont absentes.");
  const payload = {
    schema: "project-voice-calibration-v1",
    providerMode: "elevenlabs",
    source: { workspaceId: run.workspaceId, runId: run.id, corpusVersionId: run.request.corpusVersionId },
    profile: {
      id: `elevenlabs:${run.request.voiceRef}:${language}:calibration-${run.id}`,
      version: 1,
      provider: "elevenlabs",
      voice_id: run.request.voiceRef,
      model_id: params.model_id,
      voice_settings: settings,
      language,
      atempo: 1,
      name: typeof stored.name === "string" && stored.name ? stored.name : run.request.voiceRef,
    },
    corpus: { alias: `published_${run.id}`, language, style: "", observed_runs: observations },
    wpmSnapshot: published.wpmSnapshot,
  };
  // Hash the transmitted text, avoiding Node/Python differences in float serialization.
  const serialized = JSON.stringify(payload);
  return {
    schema: "project-voice-package-v1",
    payload: serialized,
    digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}
