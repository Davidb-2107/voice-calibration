import type { CalibrationRun, CorpusDraft, CorpusVersion, VoiceProfile } from "./domain.js";

export interface CorpusRepository {
  getDraft(workspaceId: string): Promise<CorpusDraft>;
  saveDraft(workspaceId: string, draft: CorpusDraft, expectedRevision: number): Promise<CorpusDraft>;
  publishDraft(workspaceId: string, expectedRevision: number): Promise<CorpusVersion>;
  getActiveVersion(workspaceId: string): Promise<CorpusVersion | null>;
  listVersions(workspaceId: string): Promise<CorpusVersion[]>;
}

export interface CalibrationRunRepository {
  create(run: CalibrationRun): Promise<void>;
  get(workspaceId: string, id: string): Promise<CalibrationRun | null>;
  save(run: CalibrationRun): Promise<void>;
  list(workspaceId: string): Promise<CalibrationRun[]>;
  recoverRunning(workspaceId: string, runId: string, recoveredAt: string): Promise<CalibrationRun | null>;
  consumeApproval?(workspaceId: string, runId: string, consumedAt: string): Promise<CalibrationRun>;
}

export interface VoiceProfileRepository {
  list(workspaceId: string): Promise<VoiceProfile[]>;
  publish(profile: VoiceProfile): Promise<void>;
}

export interface VoiceDirectoryPort {
  getName(voiceRef: string): Promise<string | null>;
}

export interface ArtifactStore {
  put(workspaceId: string, runId: string, name: string, bytes: Uint8Array): Promise<string>;
  get(workspaceId: string, ref: string): Promise<Uint8Array>;
}

export interface LocalStore {
  corpus: CorpusRepository;
  runs: CalibrationRunRepository;
  profiles: VoiceProfileRepository;
  artifacts: ArtifactStore;
}

export class ConflictError extends Error {
  constructor(
    message = "revision conflict",
    readonly code = "conflict",
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export { createLocalStore } from "./local-store.js";
