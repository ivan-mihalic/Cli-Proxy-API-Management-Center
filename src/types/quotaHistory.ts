export type HistoryProvider = 'claude' | 'codex';
export type HistoryPlan =
  'unknown' | 'free' | 'pro' | 'plus' | 'max' | 'team' | 'business' | 'enterprise' | 'edu';
export type HistoryScope = 'all' | 'sonnet' | 'opus' | 'code_review' | 'other';
export type HistoryError =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'transport'
  | 'upstream'
  | 'schema'
  | 'missing'
  | 'storage'
  | 'identity'
  | 'clock';
export interface HistoryMetadata {
  plan: HistoryPlan;
  scope: HistoryScope;
  windowDurationSeconds: number | null;
  resetSemantics: 'unknown' | 'fixed_full' | 'rolling';
  normalizationVersion: 1;
}
export interface HistoryWindow extends HistoryMetadata {
  windowId: string;
  label: string;
  firstMeasuredAt: number | null;
  lastMeasuredAt: number | null;
  stale: boolean;
  lastAttemptAt: number | null;
  lastErrorCode: HistoryError | null;
}
export interface HistoryCredential {
  credentialId: string;
  alias: string;
  provider: HistoryProvider;
  active: boolean;
  windows: HistoryWindow[];
}
export interface HistoryCatalog {
  schemaVersion: 1;
  contractVersion: '1.0.0';
  generatedAt: number;
  pollIntervalSeconds: 300;
  staleAfterSeconds: 900;
  retentionSeconds: 2592000;
  credentials: HistoryCredential[];
}
export interface HistorySample {
  measuredAt: number;
  collectedAt: number;
  usedPercent: number;
  resetAt: number | null;
  measurementOrigin: 'collector-clock' | 'provider-clock';
  epochId: string;
}
export interface HistoryAttempt {
  attemptedAt: number;
  errorCode: HistoryError;
}
export interface HistorySeries {
  schemaVersion: 1;
  contractVersion: '1.0.0';
  generatedAt: number;
  credentialId: string;
  provider: HistoryProvider;
  windowId: string;
  from: number;
  to: number;
  metadata: HistoryMetadata;
  quality: {
    stale: boolean;
    lastMeasuredAt: number | null;
    lastAttemptAt: number | null;
    lastErrorCode: HistoryError | null;
    coveredSeconds: number;
    requestedSeconds: number;
    coverage: number;
  };
  samples: HistorySample[];
  attempts: HistoryAttempt[];
}
