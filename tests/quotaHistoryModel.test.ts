import { describe, expect, test } from 'bun:test';
import {
  historyBurn,
  historyProjection,
  historyRange,
  historyServerNow,
  historySegments,
} from '../src/features/quota/quotaHistoryModel';
import type { HistorySeries } from '../src/types/quotaHistory';

export function quotaAccountSeriesFixture(): HistorySeries {
  const end = 1793196000;
  return {
    schemaVersion: 1,
    contractVersion: '1.0.1',
    generatedAt: end,
    credentialId: 'c_account_personal_canary',
    provider: 'claude',
    windowId: 'w_max20x_weekly',
    from: end - 21600,
    to: end + 1,
    metadata: {
      plan: 'max',
      scope: 'all',
      windowDurationSeconds: 604800,
      resetSemantics: 'unknown',
      normalizationVersion: 1,
    },
    quality: {
      stale: false,
      lastMeasuredAt: end,
      lastAttemptAt: end,
      lastErrorCode: null,
      coveredSeconds: 21600,
      requestedSeconds: 21601,
      coverage: 21600 / 21601,
    },
    samples: Array.from({ length: 73 }, (_, i) => ({
      measuredAt: end - 21600 + i * 300,
      collectedAt: end - 21600 + i * 300,
      usedPercent: 10 + i * 0.5,
      resetAt: end + 7200,
      measurementOrigin: 'collector-clock',
      epochId: 'e_canary',
    })),
    attempts: [],
  };
}

describe('quota history measurement invariants', () => {
  test('positive deltas use covered time; sufficient flat coverage gives zero', () => {
    const s = quotaAccountSeriesFixture();
    expect(historyBurn(s, 3, s.generatedAt).perHour).toBe(6);
    s.samples.forEach((p) => (p.usedPercent = 20));
    expect(historyBurn(s, 1, s.generatedAt).perHour).toBe(0);
    s.samples = s.samples.slice(-1);
    expect(historyBurn(s, 1, s.generatedAt).perHour).toBeNull();
  });
  test('no partial edge interpolation; exact 80 percent threshold and three points', () => {
    const s = quotaAccountSeriesFixture();
    s.samples = s.samples.slice(-13);
    expect(historyBurn(s, 1, s.generatedAt + 1).coveredSeconds).toBe(3300);
    s.samples = s.samples.slice(3);
    expect(historyBurn(s, 1, s.generatedAt).perHour).toBeNull();
    expect(historyBurn(s, 1, s.generatedAt).coverage).toBe(0.75);
  });
  test('80 percent coverage qualifies exactly, and one missing interval drops below the gate', () => {
    const s = quotaAccountSeriesFixture();
    const start = s.generatedAt - 3600;
    s.samples = [0, 720, 1440, 2160, 2880].map((delta) => ({
      ...s.samples[0],
      measuredAt: start + delta,
      usedPercent: 20,
    }));
    expect(historyBurn(s, 1, s.generatedAt).coverage).toBe(0.8);
    expect(historyBurn(s, 1, s.generatedAt).perHour).toBe(0);
    s.attempts = [{ attemptedAt: start + 100, errorCode: 'missing' }];
    expect(historyBurn(s, 1, s.generatedAt).perHour).toBeNull();
  });

  test('errors, gaps, reset metadata, epochs and decreases disconnect history and burn', () => {
    for (const change of ['error', 'gap', 'epoch', 'reset', 'decrease']) {
      const s = quotaAccountSeriesFixture();
      s.samples = s.samples.slice(-2);
      if (change === 'error')
        s.attempts.push({ attemptedAt: s.generatedAt - 100, errorCode: 'timeout' });
      if (change === 'gap') s.samples[0].measuredAt -= 901;
      if (change === 'epoch') s.samples[1].epochId = 'e_new';
      if (change === 'reset') s.samples[1].resetAt = null;
      if (change === 'decrease') s.samples[1].usedPercent = 0;
      expect(historySegments(s).map((x) => x.length)).toEqual([1, 1]);
      expect(historyBurn(s, 1, s.generatedAt).coveredSeconds).toBe(0);
    }
  });
  test('out of order, duplicate and invalid values fail closed', () => {
    for (const value of [NaN, Infinity, -1, 101]) {
      const s = quotaAccountSeriesFixture();
      s.samples[1].usedPercent = value;
      expect(historySegments(s)).toEqual([]);
      expect(historyBurn(s, 1, s.generatedAt).perHour).toBeNull();
    }
    const s = quotaAccountSeriesFixture();
    s.samples[1].measuredAt = s.samples[0].measuredAt;
    expect(historySegments(s)).toEqual([]);
    s.samples.reverse();
    expect(historySegments(s)).toEqual([]);
  });
  test('projection requires fresh latest measurement, qualified burn and no latest error', () => {
    const s = quotaAccountSeriesFixture();
    const burn = historyBurn(s, 3, s.generatedAt);
    expect(historyProjection(s, burn, s.generatedAt, s.generatedAt + 86400).at(-1)?.at).toBe(
      s.samples.at(-1)!.resetAt!
    );
    for (const code of ['timeout', 'missing', 'clock'] as const) {
      s.quality.lastErrorCode = code;
      expect(historyProjection(s, burn, s.generatedAt, s.generatedAt + 86400)).toEqual([]);
    }
    s.quality.lastErrorCode = null;
    expect(historyProjection(s, burn, s.generatedAt + 901, s.generatedAt + 86400)).toEqual([]);
    s.generatedAt -= 1;
    expect(historyProjection(s, burn, s.generatedAt, s.generatedAt + 86400)).toEqual([]);
  });
  test('server time blocks projection across a reset despite browser clock lag', () => {
    const s = quotaAccountSeriesFixture();
    s.samples = s.samples.slice(0, -1);
    s.quality.lastMeasuredAt = s.samples.at(-1)!.measuredAt;
    s.samples.forEach((p) => (p.resetAt = s.generatedAt - 100));
    expect(
      historyProjection(
        s,
        historyBurn(s, 3, s.generatedAt),
        s.generatedAt - 200,
        s.generatedAt + 3600
      )
    ).toEqual([]);
  });

  test('past reset stops; unknown and rolling never invent a full reset', () => {
    const s = quotaAccountSeriesFixture();
    const burn = historyBurn(s, 3, s.generatedAt);
    for (const semantics of ['unknown', 'rolling', 'fixed_full'] as const) {
      s.metadata.resetSemantics = semantics;
      const projection = historyProjection(s, burn, s.generatedAt, s.generatedAt + 86400);
      expect(projection).toHaveLength(2);
      expect(projection[1].remaining).toBeLessThan(projection[0].remaining);
    }
    s.samples.at(-1)!.resetAt = s.generatedAt - 1;
    expect(historyProjection(s, burn, s.generatedAt, s.generatedAt + 86400)).toEqual([]);
  });
  test('range navigation uses seconds through DST and keeps 30d API bound', () => {
    const end = Date.parse('2026-10-25T02:30:00+01:00') / 1000;
    const range = historyRange(end, 2592000, -1);
    expect(range.to - range.from).toBe(2592000);
    expect(historyRange(end, 86400, -1).to).toBe(end - 86400);
  });
});

test('server clock and query snapshot ignore both directions of browser clock skew', () => {
  const server = 1793196000;
  const snapshot = historyRange(server + 1, 86400);
  const previous = historyRange(server + 1, 86400, -1);
  for (const browserSkew of [-7200000, 7200000]) {
    const original = Date.now;
    Date.now = () => server * 1000 + browserSkew;
    try {
      expect(historyServerNow(server, 1000, 61000)).toBe(server + 60);
      expect(historyRange(server + 1, 86400)).toEqual(snapshot);
      expect(historyRange(server + 1, 86400, -1)).toEqual(previous);
      expect(snapshot.to).toBeLessThanOrEqual(server + 60);
    } finally {
      Date.now = original;
    }
  }
  expect(historyServerNow(server, 1000, 0)).toBe(server);
});
