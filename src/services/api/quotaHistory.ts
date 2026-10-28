import { apiClient } from './client';
import type {
  HistoryCatalog,
  HistorySeries,
  HistoryMetadata,
  HistorySample,
} from '@/types/quotaHistory';
import { historyPairGuard, validHistorySamples } from '@/features/quota/quotaHistoryModel';

const errors = [
  'unauthorized',
  'forbidden',
  'rate_limited',
  'timeout',
  'transport',
  'upstream',
  'schema',
  'missing',
  'storage',
  'identity',
  'clock',
];
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,96}$/.test(v);
const seconds = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 8640000000000;
const nullableSeconds = (v: unknown) => v === null || seconds(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const errorCode = (v: unknown) => v === null || (typeof v === 'string' && errors.includes(v));
const member = (v: unknown, values: readonly unknown[]) => values.includes(v);
const text = (v: unknown) =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 96 &&
  Array.from(v).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
  );
function record(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid history schema');
  const result = value as Record<string, unknown>;
  const allowed = keys.split(' ');
  if (
    Object.keys(result).length !== allowed.length ||
    !allowed.every((k) => Object.prototype.hasOwnProperty.call(result, k))
  ) {
    throw new Error('Invalid history schema');
  }
  return result;
}
function requireValid(valid: unknown): asserts valid {
  if (!valid) throw new Error('Invalid history schema');
}
function header(value: Record<string, unknown>) {
  requireValid(
    value.schemaVersion === 1 && value.contractVersion === '1.0.1' && seconds(value.generatedAt)
  );
}
function metadata(value: unknown): HistoryMetadata {
  const m = record(value, 'plan scope windowDurationSeconds resetSemantics normalizationVersion');
  requireValid(
    member(m.plan, [
      'unknown',
      'free',
      'pro',
      'plus',
      'max',
      'team',
      'business',
      'enterprise',
      'edu',
    ]) &&
      member(m.scope, ['all', 'sonnet', 'opus', 'code_review', 'other']) &&
      (m.windowDurationSeconds === null ||
        (seconds(m.windowDurationSeconds) && m.windowDurationSeconds > 0)) &&
      member(m.resetSemantics, ['unknown', 'fixed_full', 'rolling']) &&
      m.normalizationVersion === 1
  );
  return m as unknown as HistoryMetadata;
}

export function parseHistoryCatalog(value: unknown): HistoryCatalog {
  const c = record(
    value,
    'schemaVersion contractVersion generatedAt pollIntervalSeconds staleAfterSeconds retentionSeconds credentials'
  );
  header(c);
  requireValid(
    c.pollIntervalSeconds === 300 &&
      c.staleAfterSeconds === 900 &&
      c.retentionSeconds === 2592000 &&
      Array.isArray(c.credentials)
  );
  const ids = new Set<string>();
  for (const raw of c.credentials) {
    const a = record(raw, 'credentialId alias provider active windows');
    requireValid(
      id(a.credentialId) &&
        !ids.has(a.credentialId) &&
        member(a.provider, ['claude', 'codex']) &&
        typeof a.alias === 'string' &&
        new RegExp(`^${a.provider === 'claude' ? 'Claude' : 'Codex'} [1-9][0-9]*$`).test(a.alias) &&
        a.alias.length <= 96 &&
        typeof a.active === 'boolean' &&
        Array.isArray(a.windows)
    );
    ids.add(a.credentialId);
    const windows = new Set<string>();
    for (const rawWindow of a.windows) {
      const w = record(
        rawWindow,
        'windowId label plan scope windowDurationSeconds resetSemantics normalizationVersion firstMeasuredAt lastMeasuredAt stale lastAttemptAt lastErrorCode'
      );
      metadata({
        plan: w.plan,
        scope: w.scope,
        windowDurationSeconds: w.windowDurationSeconds,
        resetSemantics: w.resetSemantics,
        normalizationVersion: w.normalizationVersion,
      });
      requireValid(
        id(w.windowId) &&
          !windows.has(w.windowId) &&
          text(w.label) &&
          nullableSeconds(w.firstMeasuredAt) &&
          nullableSeconds(w.lastMeasuredAt) &&
          nullableSeconds(w.lastAttemptAt) &&
          errorCode(w.lastErrorCode) &&
          typeof w.stale === 'boolean'
      );
      windows.add(w.windowId);
    }
  }
  return structuredClone(c) as unknown as HistoryCatalog;
}

export function parseHistorySeries(value: unknown): HistorySeries {
  const s = record(
    value,
    'schemaVersion contractVersion generatedAt credentialId provider windowId from to metadata quality samples attempts'
  );
  header(s);
  requireValid(
    id(s.credentialId) &&
      id(s.windowId) &&
      member(s.provider, ['claude', 'codex']) &&
      seconds(s.from) &&
      seconds(s.to) &&
      s.from < s.to &&
      s.to - s.from <= 2592000 &&
      s.to <= Number(s.generatedAt) + 60
  );
  metadata(s.metadata);
  const q = record(
    s.quality,
    'stale lastMeasuredAt lastAttemptAt lastErrorCode coveredSeconds requestedSeconds coverage'
  );
  requireValid(
    typeof q.stale === 'boolean' &&
      nullableSeconds(q.lastMeasuredAt) &&
      nullableSeconds(q.lastAttemptAt) &&
      errorCode(q.lastErrorCode) &&
      seconds(q.coveredSeconds) &&
      q.requestedSeconds === Number(s.to) - Number(s.from) &&
      finite(q.coverage) &&
      q.coverage >= 0 &&
      q.coverage <= 1 &&
      Array.isArray(s.samples) &&
      s.samples.length <= 8640 &&
      Array.isArray(s.attempts) &&
      s.attempts.length <= 8640
  );
  for (const raw of s.samples) {
    const p = record(raw, 'measuredAt collectedAt usedPercent resetAt measurementOrigin epochId');
    requireValid(
      seconds(p.measuredAt) &&
        p.measuredAt >= Number(s.from) &&
        p.measuredAt < Number(s.to) &&
        seconds(p.collectedAt) &&
        finite(p.usedPercent) &&
        p.usedPercent >= 0 &&
        p.usedPercent <= 100 &&
        nullableSeconds(p.resetAt) &&
        member(p.measurementOrigin, ['collector-clock', 'provider-clock']) &&
        id(p.epochId)
    );
  }
  for (const raw of s.attempts) {
    const a = record(raw, 'attemptedAt errorCode');
    requireValid(
      seconds(a.attemptedAt) &&
        a.attemptedAt >= Number(s.from) &&
        a.attemptedAt < Number(s.to) &&
        a.errorCode !== null &&
        errorCode(a.errorCode)
    );
  }
  const result = structuredClone(s) as unknown as HistorySeries;
  requireValid(validHistorySamples(result.samples));
  let covered = 0;
  const eligible = historyPairGuard(result.attempts);
  result.samples.forEach((p: HistorySample, i: number) => {
    if (i && eligible(result.samples[i - 1], p)) {
      covered += p.measuredAt - result.samples[i - 1].measuredAt;
    }
  });
  requireValid(
    covered === q.coveredSeconds &&
      Math.abs(covered / Number(q.requestedSeconds) - Number(q.coverage)) < 1e-8
  );
  return result;
}

export function captureQuotaHistory(isCurrent: () => boolean, signal: AbortSignal) {
  const client = apiClient.captureConnection(() => !signal.aborted && isCurrent());
  return {
    catalog: async () => parseHistoryCatalog(await client.getQuotaHistory('catalog', {}, signal)),
    series: async (credentialId: string, windowId: string, from: number, to: number) => {
      requireValid(
        id(credentialId) &&
          id(windowId) &&
          seconds(from) &&
          seconds(to) &&
          from < to &&
          to - from <= 2592000
      );
      const series = parseHistorySeries(
        await client.getQuotaHistory('series', { credentialId, windowId, from, to }, signal)
      );
      requireValid(
        series.credentialId === credentialId &&
          series.windowId === windowId &&
          series.from === from &&
          series.to === to
      );
      return series;
    },
  };
}
