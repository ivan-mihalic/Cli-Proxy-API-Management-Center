import type { HistoryAttempt, HistorySample, HistorySeries } from '@/types/quotaHistory';

export const HISTORY_RANGES = [21600, 86400, 604800, 2592000] as const;
export const BURN_HOURS = [1, 3, 6] as const;
export interface BurnRate {
  hours: number;
  coveredSeconds: number;
  coverage: number;
  pointCount: number;
  perHour: number | null;
}

export function validHistorySamples(samples: HistorySample[]): boolean {
  return samples.every(
    (sample, index) =>
      Number.isSafeInteger(sample.measuredAt) &&
      sample.measuredAt >= 0 &&
      Number.isFinite(sample.usedPercent) &&
      sample.usedPercent >= 0 &&
      sample.usedPercent <= 100 &&
      (index === 0 || sample.measuredAt > samples[index - 1].measuredAt)
  );
}

export function historyPairGuard(attempts: HistoryAttempt[]) {
  const times = attempts.map((a) => a.attemptedAt).sort((a, b) => a - b);
  return (left: HistorySample, right: HistorySample): boolean => {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (times[mid] < left.measuredAt) low = mid + 1;
      else high = mid;
    }
    const seconds = right.measuredAt - left.measuredAt;
    return (
      seconds > 0 &&
      seconds <= 900 &&
      left.epochId === right.epochId &&
      left.resetAt === right.resetAt &&
      right.usedPercent >= left.usedPercent &&
      (low === times.length || times[low] > right.measuredAt)
    );
  };
}

export function eligibleHistoryPair(
  left: HistorySample,
  right: HistorySample,
  attempts: HistoryAttempt[]
): boolean {
  return historyPairGuard(attempts)(left, right);
}

export function historySegments(series: HistorySeries): HistorySample[][] {
  if (!validHistorySamples(series.samples)) return [];
  const segments: HistorySample[][] = [];
  const eligible = historyPairGuard(series.attempts);
  for (const sample of series.samples) {
    const current = segments[segments.length - 1];
    if (!current || !eligible(current[current.length - 1], sample)) {
      segments.push([sample]);
    } else current.push(sample);
  }
  return segments;
}

export function historyBurn(series: HistorySeries, hours: number, end: number): BurnRate {
  const duration = hours * 3600;
  let coveredSeconds = 0;
  let used = 0;
  const points = new Set<number>();
  const eligible = historyPairGuard(series.attempts);
  if (validHistorySamples(series.samples)) {
    for (let index = 1; index < series.samples.length; index++) {
      const left = series.samples[index - 1];
      const right = series.samples[index];
      if (left.measuredAt < end - duration || right.measuredAt > end || !eligible(left, right))
        continue;
      coveredSeconds += right.measuredAt - left.measuredAt;
      used += Math.max(0, right.usedPercent - left.usedPercent);
      points.add(left.measuredAt);
      points.add(right.measuredAt);
    }
  }
  const coverage = Math.min(1, coveredSeconds / duration);
  return {
    hours,
    coveredSeconds,
    coverage,
    pointCount: points.size,
    perHour: coverage >= 0.8 && points.size >= 3 ? (used * 3600) / coveredSeconds : null,
  };
}

export interface HistoryProjectionPoint {
  at: number;
  remaining: number;
}

// Konzervativní odhad končí u prvního markeru; marker sám není nové měření.
export function historyProjection(
  series: HistorySeries,
  burn: BurnRate,
  now: number,
  viewEnd: number
): HistoryProjectionPoint[] {
  now = Math.max(now, series.generatedAt);
  const latest = series.samples[series.samples.length - 1];
  const measuredAt = series.quality.lastMeasuredAt;
  if (
    !latest ||
    !validHistorySamples(series.samples) ||
    measuredAt !== latest.measuredAt ||
    measuredAt > series.generatedAt ||
    measuredAt > now ||
    now - measuredAt > 900 ||
    series.quality.stale ||
    series.quality.lastErrorCode !== null ||
    burn.perHour === null ||
    (latest.resetAt !== null && latest.resetAt <= now)
  )
    return [];
  const end = Math.min(viewEnd, latest.resetAt ?? viewEnd);
  if (end <= now) return [];
  const remaining = 100 - latest.usedPercent;
  const emptyAt = burn.perHour > 0 ? measuredAt + (remaining / burn.perHour) * 3600 : end;
  const stop = Math.min(end, Math.max(measuredAt, emptyAt));
  if (stop <= now) return [];
  return [
    { at: measuredAt, remaining },
    { at: stop, remaining: Math.max(0, remaining - (burn.perHour * (stop - measuredAt)) / 3600) },
  ];
}

// Pevná délka v sekundách zůstává stejná i při přechodu DST.
export function historyRange(end: number, seconds: number, offset = 0) {
  const to = Math.max(1, Math.floor(end) + Math.min(0, offset) * seconds);
  return { from: Math.max(0, to - seconds), to };
}

// Čas serveru + monotónně uplynulá doba; změna hodin OS nemění dotazy ani odhad.
export function historyServerNow(generatedAt: number, receivedAt: number, monotonicNow: number) {
  return generatedAt + Math.max(0, Math.floor((monotonicNow - receivedAt) / 1000));
}
