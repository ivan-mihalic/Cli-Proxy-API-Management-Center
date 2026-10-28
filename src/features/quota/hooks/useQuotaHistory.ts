import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api/client';
import { captureQuotaHistory } from '@/services/api/quotaHistory';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { HistoryCatalog, HistorySeries } from '@/types/quotaHistory';

interface Resource<T> {
  key: string;
  data?: T;
  status: 'loading' | 'ready' | 'unavailable';
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
  from: number,
  to: number,
  refresh: number
) {
  const generation = useQuotaStore((s) => s.cacheGeneration);
  const connected = useAuthStore((s) => s.isAuthenticated && s.connectionStatus === 'connected');
  const [catalog, setCatalog] = useState<Resource<HistoryCatalog>>({ key: '', status: 'loading' });
  const [series, setSeries] = useState<Resource<HistorySeries>>({ key: '', status: 'loading' });
  const catalogRequest = useRef(0);
  const seriesRequest = useRef(0);
  const seriesAbort = useRef<AbortController | null>(null);
  const revision = apiClient.getConnectionRevision();
  const catalogKey = `${generation}:${revision}:${refresh}:${connected}`;
  const seriesKey = `${catalogKey}:${credentialId}:${windowId}:${from}:${to}`;
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
    setCatalog({ key: catalogKey, status: 'loading' });
    void captureQuotaHistory(current, abort.signal)
      .catalog()
      .then((data) => {
        if (current()) setCatalog({ key: catalogKey, data, status: 'ready' });
      })
      .catch(() => {
        if (current()) setCatalog({ key: catalogKey, status: 'unavailable' });
      });
    return () => abort.abort();
  }, [catalogKey, connected, generation, revision]);

  useEffect(() => {
    const request = ++seriesRequest.current;
    const abort = new AbortController();
    seriesAbort.current = abort;
    const current = () =>
      !abort.signal.aborted &&
      historyRequestCurrent(revision, generation, request, seriesRequest.current);
    if (!connected || !credentialId || !windowId) return () => abort.abort();
    setSeries({ key: seriesKey, status: 'loading' });
    void captureQuotaHistory(current, abort.signal)
      .series(credentialId, windowId, from, to)
      .then((data) => {
        if (current()) setSeries({ key: seriesKey, data, status: 'ready' });
      })
      .catch(() => {
        if (current()) setSeries({ key: seriesKey, status: 'unavailable' });
      });
    return () => abort.abort();
  }, [connected, credentialId, from, generation, revision, seriesKey, to, windowId]);

  return {
    catalog: catalog.key === catalogKey && connected ? catalog.data : undefined,
    catalogStatus: catalog.key === catalogKey ? catalog.status : 'loading',
    series: series.key === seriesKey && connected ? series.data : undefined,
    seriesStatus: series.key === seriesKey ? series.status : 'loading',
    cancelSeries,
  };
}
