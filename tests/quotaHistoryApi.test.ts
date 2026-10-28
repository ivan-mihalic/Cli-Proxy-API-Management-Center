import { afterAll, describe, expect, test } from 'bun:test';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { apiClient } from '../src/services/api/client';
import {
  captureQuotaHistory,
  parseHistoryCatalog,
  parseHistorySeries,
} from '../src/services/api/quotaHistory';
import { historyRequestCurrent } from '../src/features/quota/hooks/useQuotaHistory';
import { useAuthStore, useQuotaStore } from '../src/stores';
import { seriesFixture } from './quotaHistoryModel.test';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const originalAdapter = axios.defaults.adapter;
const events: string[] = [];
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { origin: 'https://proxycli.internal' },
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
  },
});
axios.defaults.adapter = async (config) => ({
  data: {},
  status: 200,
  statusText: 'OK',
  headers: {},
  config,
});
// captureConnection vytváří vlastní Axios instanci až po instalaci testovacího adaptéru.
afterAll(() => {
  axios.defaults.adapter = originalAdapter;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});
const connect = (base = 'https://proxycli.internal', key = 'canary-only') =>
  apiClient.setConfig({ apiBase: base, managementKey: key });

function catalogFixture() {
  const s = seriesFixture();
  return {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    generatedAt: s.generatedAt,
    pollIntervalSeconds: 300,
    staleAfterSeconds: 900,
    retentionSeconds: 2592000,
    credentials: [
      {
        credentialId: s.credentialId,
        alias: 'Claude 1',
        provider: s.provider,
        active: true,
        windows: [
          {
            windowId: s.windowId,
            label: 'Weekly',
            ...s.metadata,
            firstMeasuredAt: s.samples[0].measuredAt,
            lastMeasuredAt: s.generatedAt,
            stale: false,
            lastAttemptAt: s.generatedAt,
            lastErrorCode: null,
          },
        ],
      },
    ],
  };
}

describe('frozen quota history wire and isolation guards', () => {
  test('valid whitelist data; metadata transitions stay distinct window IDs', () => {
    expect(parseHistorySeries(seriesFixture()).samples).toHaveLength(73);
    const c = catalogFixture();
    const old = c.credentials[0].windows[0];
    c.credentials[0].windows.push({ ...old, windowId: 'w_new_plan', plan: 'max', scope: 'opus' });
    expect(parseHistoryCatalog(c).credentials[0].windows).toHaveLength(2);
  });
  test('unknown fields, invalid enums, personal aliases, malformed samples and false coverage reject', () => {
    const bad = [
      { ...seriesFixture(), secret: 'canary-unknown-field' },
      { ...seriesFixture(), contractVersion: '2.0.0' },
      { ...seriesFixture(), metadata: { ...seriesFixture().metadata, plan: 'unrecognized' } },
      { ...seriesFixture(), quality: { ...seriesFixture().quality, coverage: 1 } },
      { ...seriesFixture(), samples: [{ ...seriesFixture().samples[0], usedPercent: 101 }] },
      { ...seriesFixture(), samples: seriesFixture().samples.reverse() },
    ];
    bad.forEach((value) =>
      expect(() => parseHistorySeries(value)).toThrow('Invalid history schema')
    );
    const c = catalogFixture();
    c.credentials[0].alias = 'canary@example.invalid';
    expect(() => parseHistoryCatalog(c)).toThrow();
  });
  test('extension uses exact root path and existing bearer; management paths retain v8', async () => {
    const calls: InternalAxiosRequestConfig[] = [];
    axios.defaults.adapter = async (config) => {
      calls.push(config);
      return { data: catalogFixture(), status: 200, statusText: 'OK', headers: {}, config };
    };
    connect();
    await captureQuotaHistory(() => true, new AbortController().signal).catalog();
    expect(calls[0].url).toBe('https://proxycli.internal/quota-history/v1/catalog');
    expect(calls[0].headers.Authorization).toBe('Bearer canary-only');
    const client = apiClient.captureConnection();
    await client.get('/auth-files');
    expect(calls[1].baseURL).toBe('https://proxycli.internal/v8/management');
    expect(calls[1].url).toBe('/auth-files');
  });
  test('custom origins, deployment prefixes, cross-origin pages and missing key never send', async () => {
    let sent = 0;
    axios.defaults.adapter = async (config) => {
      sent++;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    for (const base of [
      'https://other.invalid',
      'https://proxycli.internal/extra',
      'https://proxycli.internal.evil.invalid',
    ]) {
      connect(base);
      await expect(
        captureQuotaHistory(() => true, new AbortController().signal).catalog()
      ).rejects.toThrow('unavailable');
    }
    connect('https://proxycli.internal', '');
    await expect(
      captureQuotaHistory(() => true, new AbortController().signal).catalog()
    ).rejects.toThrow();
    connect();
    window.location.origin = 'http://localhost:5173';
    await expect(
      captureQuotaHistory(() => true, new AbortController().signal).catalog()
    ).rejects.toThrow();
    window.location.origin = 'https://proxycli.internal';
    expect(sent).toBe(0);
  });
  test('late 401 is suppressed after ABA, selection invalidation or abort; current 401 emits', async () => {
    let rejectPending: (reason: unknown) => void = () => {};
    let config: InternalAxiosRequestConfig;
    axios.defaults.adapter = (value) => {
      config = value;
      return new Promise((_, reject) => {
        rejectPending = reject;
      });
    };
    for (const mode of ['aba', 'selection', 'abort', 'current']) {
      events.length = 0;
      connect();
      let current = true;
      const abort = new AbortController();
      const pending = captureQuotaHistory(() => current, abort.signal)
        .catalog()
        .catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (mode === 'aba') {
        connect('https://other.invalid');
        connect();
      }
      if (mode === 'selection') current = false;
      if (mode === 'abort') abort.abort();
      rejectPending(
        new AxiosError('canary', 'ERR_BAD_REQUEST', config!, undefined, {
          data: {},
          status: 401,
          statusText: 'Unauthorized',
          headers: {},
          config: config!,
        })
      );
      await pending;
      expect(events.includes('unauthorized')).toBe(mode === 'current');
    }
  });
  test('request guard rejects old account/window/range requests and logout generations including ABA', () => {
    connect();
    useAuthStore.setState({ isAuthenticated: true, connectionStatus: 'connected' });
    const generation = useQuotaStore.getState().cacheGeneration;
    const revision = apiClient.getConnectionRevision();
    expect(historyRequestCurrent(revision, generation, 1, 1)).toBe(true);
    expect(historyRequestCurrent(revision, generation, 1, 2)).toBe(false);
    useQuotaStore.getState().clearQuotaCache();
    expect(historyRequestCurrent(revision, generation, 1, 1)).toBe(false);
    connect('https://other.invalid');
    connect();
    expect(historyRequestCurrent(revision, useQuotaStore.getState().cacheGeneration, 1, 1)).toBe(
      false
    );
    useAuthStore.setState({ isAuthenticated: false, connectionStatus: 'disconnected' });
    expect(
      historyRequestCurrent(
        apiClient.getConnectionRevision(),
        useQuotaStore.getState().cacheGeneration,
        1,
        1
      )
    ).toBe(false);
  });
  test('missing extension rejects independently and mismatched query response fails closed', async () => {
    connect();
    for (const status of [404, 503]) {
      axios.defaults.adapter = async (config) => {
        throw new AxiosError('Unavailable', 'ERR_BAD_RESPONSE', config, undefined, {
          data: {},
          status,
          statusText: 'Unavailable',
          headers: {},
          config,
        });
      };
      await expect(
        captureQuotaHistory(() => true, new AbortController().signal).catalog()
      ).rejects.toMatchObject({ status });
    }
    axios.defaults.adapter = async (config) => ({
      data: seriesFixture(),
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    const s = seriesFixture();
    await expect(
      captureQuotaHistory(() => true, new AbortController().signal).series(
        'c_other',
        s.windowId,
        s.from,
        s.to
      )
    ).rejects.toThrow();
  });
});
