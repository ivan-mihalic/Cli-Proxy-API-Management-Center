import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiClient } from '@/services/api/client';
import { captureQuotaHistory } from '@/services/api/quotaHistory';
import { useAuthStore, useQuotaStore } from '@/stores';
import { createQuotaHistoryClock } from '../quotaHistoryClock';
import { historyRange, historyServerNow } from '../quotaHistoryModel';
import type { HistoryCatalog, HistorySeries } from '@/types/quotaHistory';

const historyClock = createQuotaHistoryClock();
const serverSnapshot = { elapsed: 0, epoch: 0 };
const serverClockSnapshot = () => serverSnapshot;

interface Resource<T> {
  key: string;
  data?: T;
  status: 'loading' | 'ready' | 'unavailable';
  receivedAt?: number;
  anchor?: number;
  clockEpoch?: number;
}

// Revize klienta chrání i ABA; generace quota cache zachytí logout a nový login.
export function historyRequestCurrent(
  revision: number,
  generation: number,
  request: number,
  currentRequest: number
): boolean {
  return (
    revision === apiClient.getConnectionRevision() &&
    generation === useQuotaStore.getState().cacheGeneration &&
    request === currentRequest &&
    useAuthStore.getState().isAuthenticated &&
    useAuthStore.getState().connectionStatus === 'connected'
  );
}

export function useQuotaHistory(
  credentialId: string,
  windowId: string,
  range: number,
  offset: number,
  refresh: number
) {
  const clock = useSyncExternalStore(
    historyClock.subscribe,
    historyClock.getSnapshot,
    serverClockSnapshot
  );
  const monotonicTime = clock.elapsed;
  const refreshCycle = `${Math.floor(monotonicTime / 300000)}:${clock.epoch}:${refresh}`;
  const generation = useQuotaStore((s) => s.cacheGeneration);
  const connected = useAuthStore((s) => s.isAuthenticated && s.connectionStatus === 'connected');
  const [catalog, setCatalog] = useState<Resource<HistoryCatalog>>({ key: '', status: 'loading' });
  const [series, setSeries] = useState<Resource<HistorySeries>>({ key: '', status: 'loading' });
  const catalogRequest = useRef(0);
  const seriesRequest = useRef(0);
  const seriesAbort = useRef<AbortController | null>(null);
  const revision = apiClient.getConnectionRevision();
  const catalogKey = `${generation}:${revision}:${connected}`;
  const currentCatalog = catalog.key === catalogKey && connected ? catalog : undefined;
  const { from, to } = historyRange(
    (offset < 0
      ? currentCatalog?.anchor
      : currentCatalog?.data
        ? currentCatalog.data.generatedAt + 1
        : undefined) ?? 0,
    range,
    offset
  );
  const seriesKey = `${catalogKey}:${credentialId}:${windowId}:${range}:${offset}`;
  const cancelSeries = useCallback(() => {
    seriesRequest.current++;
    seriesAbort.current?.abort();
  }, []);

  useEffect(() => {
    const request = ++catalogRequest.current;
    const abort = new AbortController();
    const current = () =>
      !abort.signal.aborted &&
      historyRequestCurrent(revision, generation, request, catalogRequest.current);
    if (!connected) return () => abort.abort();
    setCatalog((previous) =>
      previous.key === catalogKey ? previous : { key: catalogKey, status: 'loading' }
    );
    void captureQuotaHistory(current, abort.signal)
      .catalog()
      .then((data) => {
        if (current()) {
          const received = historyClock.checkpoint();
          setCatalog((previous) => ({
            key: catalogKey,
            data,
            status: 'ready',
            receivedAt: received.elapsed,
            clockEpoch: received.epoch,
            anchor:
              previous.key === catalogKey && previous.anchor !== undefined
                ? previous.anchor
                : data.generatedAt + 1,
          }));
        }
      })
      .catch(() => {
        if (current())
          setCatalog((previous) => ({
            key: catalogKey,
            status: 'unavailable',
            anchor: previous.key === catalogKey ? previous.anchor : undefined,
          }));
      });
    return () => abort.abort();
  }, [catalogKey, connected, generation, revision, refreshCycle]);

  useEffect(() => {
    const request = ++seriesRequest.current;
    const abort = new AbortController();
    seriesAbort.current = abort;
    const current = () =>
      !abort.signal.aborted &&
      historyRequestCurrent(revision, generation, request, seriesRequest.current);
    if (!connected || !credentialId || !windowId || !currentCatalog?.data)
      return () => abort.abort();
    setSeries((previous) =>
      previous.key === seriesKey ? previous : { key: seriesKey, status: 'loading' }
    );
    void captureQuotaHistory(current, abort.signal)
      .series(credentialId, windowId, from, to)
      .then((data) => {
        if (current()) setSeries({ key: seriesKey, data, status: 'ready' });
      })
      .catch(() => {
        if (current()) setSeries({ key: seriesKey, status: 'unavailable' });
      });
    return () => abort.abort();
  }, [
    connected,
    credentialId,
    from,
    generation,
    revision,
    seriesKey,
    to,
    windowId,
    currentCatalog?.data,
  ]);

  return {
    from,
    to,
    clockTrusted: currentCatalog?.clockEpoch === clock.epoch,
    now: currentCatalog?.data
      ? historyServerNow(
          currentCatalog.data.generatedAt,
          currentCatalog.receivedAt ?? monotonicTime,
          monotonicTime
        )
      : 0,
    catalog: catalog.key === catalogKey && connected ? catalog.data : undefined,
    catalogStatus: catalog.key === catalogKey ? catalog.status : 'loading',
    series: series.key === seriesKey && connected ? series.data : undefined,
    seriesStatus: series.key === seriesKey ? series.status : 'loading',
    cancelSeries,
  };
}
