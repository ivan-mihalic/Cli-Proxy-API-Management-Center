import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryProvider, HistorySeries } from '@/types/quotaHistory';
import { useQuotaHistory } from '../hooks/useQuotaHistory';
import {
  BURN_HOURS,
  HISTORY_RANGES,
  historyBurn,
  historyProjection,
  historySegments,
} from '../quotaHistoryModel';
import styles from './QuotaHistoryChart.module.scss';

const dateTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
const percent = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });

export interface QuotaHistoryPlotProps {
  series: HistorySeries;
  from: number;
  to: number;
  now: number;
  burnHours: number | null;
  onBurnChange: (hours: number) => void;
  clockTrusted?: boolean;
}

export function QuotaHistoryPlot({
  series,
  from,
  to,
  now,
  burnHours,
  onBurnChange,
  clockTrusted = true,
}: QuotaHistoryPlotProps) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
  }, []);
  const [selected, setSelected] = useState<number | null>(null);
  const segments = useMemo(() => historySegments(series), [series]);
  const end = Math.min(series.to - 1, series.generatedAt);
  const burns = useMemo(() => BURN_HOURS.map((h) => historyBurn(series, h, end)), [series, end]);
  const selectedBurn =
    burns.find((b) => b.hours === (burnHours ?? 3) && b.perHour !== null) ??
    (burnHours === null ? burns.find((b) => b.perHour !== null) : undefined);
  const projection =
    clockTrusted && selectedBurn ? historyProjection(series, selectedBurn, now, to) : [];
  const last = series.samples[series.samples.length - 1];
  const selectedIndex =
    selected === null ? -1 : series.samples.findIndex((p) => p.measuredAt === selected);
  const sample = selectedIndex < 0 ? last : series.samples[selectedIndex];
  const stale =
    !clockTrusted ||
    series.quality.stale ||
    series.quality.lastMeasuredAt === null ||
    series.quality.lastMeasuredAt > series.generatedAt ||
    now - series.quality.lastMeasuredAt > 900;
  const latestError =
    series.quality.lastMeasuredAt !== null && series.quality.lastMeasuredAt > series.generatedAt
      ? 'clock'
      : series.quality.lastErrorCode;
  const status = latestError ? 'error' : stale ? 'stale' : 'measured';
  const x = (at: number) => 48 + ((at - from) / (to - from)) * 900;
  const y = (remaining: number) => 32 + (100 - remaining) * 2.1;
  const path = (points: { at: number; remaining: number }[]) =>
    points
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(2)},${y(p.remaining).toFixed(2)}`)
      .join(' ');
  const coverage = percent(series.quality.coverage * 100);
  const sampleDescription = sample
    ? t('quota_history.sample_detail', {
        timestamp: dateTime(sample.measuredAt),
        remaining: percent(100 - sample.usedPercent),
        status: t('quota_history.measured'),
        coverage,
      })
    : t('quota_history.empty');

  return (
    <>
      <div className={styles.summary}>
        <span className={styles.remaining}>
          {last ? `${percent(100 - last.usedPercent)}%` : '—'}
        </span>
        <span className={styles.muted}>{t('quota_history.capacity')}</span>
        <span role="status" className={styles.muted}>
          {t(`quota_history.${status}`)}
          {latestError && ` · ${t(`quota_history.errors.${latestError}`)}`}
          {last &&
            ` · ${t('quota_history.selected_measurement', { timestamp: dateTime(last.measuredAt) })}`}
        </span>
      </div>
      <div className={styles.burns} role="group" aria-label={t('quota_history.burn')}>
        {burns.map((b) => (
          <button
            type="button"
            key={b.hours}
            onClick={() => onBurnChange(b.hours)}
            aria-pressed={selectedBurn?.hours === b.hours}
          >
            <span>
              {t('quota_history.burn_hours', { hours: b.hours })}:{' '}
              {b.perHour === null
                ? t('quota_history.insufficient')
                : t('quota_history.rate', { value: percent(b.perHour) })}
            </span>
            <small>{t('quota_history.coverage', { value: percent(b.coverage * 100) })}</small>
          </button>
        ))}
      </div>
      {last ? (
        <>
          <div className={styles.viewport} ref={viewportRef}>
            <svg
              className={styles.svg}
              viewBox="0 0 980 286"
              tabIndex={0}
              role="group"
              aria-label={t('quota_history.chart_label')}
              aria-describedby={descriptionId}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? series.samples.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            series.samples.length - 1,
                            (selectedIndex < 0 ? series.samples.length - 1 : selectedIndex) +
                              (event.key === 'ArrowLeft' ? -1 : 1)
                          )
                        );
                setSelected(series.samples[next].measuredAt);
                const viewport = viewportRef.current;
                if (viewport) {
                  const position =
                    (x(series.samples[next].measuredAt) / 980) * event.currentTarget.clientWidth;
                  if (
                    position < viewport.scrollLeft ||
                    position > viewport.scrollLeft + viewport.clientWidth
                  ) {
                    viewport.scrollLeft = position - viewport.clientWidth / 2;
                  }
                }
              }}
              onPointerMove={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const instant =
                  from +
                  ((((event.clientX - rect.left) / rect.width) * 980 - 48) / 900) * (to - from);
                let low = 0;
                let high = series.samples.length - 1;
                while (low < high) {
                  const mid = Math.floor((low + high) / 2);
                  if (series.samples[mid].measuredAt < instant) low = mid + 1;
                  else high = mid;
                }
                if (
                  low > 0 &&
                  Math.abs(series.samples[low - 1].measuredAt - instant) <
                    Math.abs(series.samples[low].measuredAt - instant)
                )
                  low--;
                setSelected(series.samples[low].measuredAt);
              }}
            >
              <title>{t('quota_history.chart_label')}</title>
              {[0, 25, 50, 75, 100].map((value) => (
                <g key={value}>
                  <line className={styles.grid} x1={48} x2={948} y1={y(value)} y2={y(value)} />
                  <text x={40} y={y(value) + 4} textAnchor="end">
                    {value}%
                  </text>
                </g>
              ))}
              {Array.from({ length: 5 }, (_, i) => from + ((to - from) * i) / 4).map((at) => (
                <g key={at}>
                  <line className={styles.grid} x1={x(at)} x2={x(at)} y1={32} y2={242} />
                  <text
                    x={x(at)}
                    y={266}
                    textAnchor={at === from ? 'start' : at === to ? 'end' : 'middle'}
                  >
                    {new Date(at * 1000).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </text>
                </g>
              ))}
              {series.samples.slice(1).map((p, i) => {
                const left = series.samples[i];
                if (
                  p.measuredAt - left.measuredAt > 900 ||
                  (p.epochId === left.epochId &&
                    p.usedPercent >= left.usedPercent &&
                    p.resetAt === left.resetAt)
                )
                  return null;
                return (
                  <rect
                    key={`transition-${p.measuredAt}`}
                    className={styles.uncertain}
                    x={x(left.measuredAt)}
                    y={32}
                    width={x(p.measuredAt) - x(left.measuredAt)}
                    height={210}
                  >
                    <title>
                      {t('quota_history.uncertain', {
                        from: dateTime(left.measuredAt),
                        to: dateTime(p.measuredAt),
                      })}
                    </title>
                  </rect>
                );
              })}
              {segments.map((segment, i) => {
                const points = segment.map((p) => ({
                  at: p.measuredAt,
                  remaining: 100 - p.usedPercent,
                }));
                return (
                  <g key={i}>
                    {segment.length > 1 && (
                      <path
                        className={styles.area}
                        d={`${path(points)} L${x(points[points.length - 1].at)},242 L${x(points[0].at)},242 Z`}
                      />
                    )}
                    <path className={styles.line} d={path(points)} />
                    {segment.length === 1 && (
                      <circle
                        className={styles.point}
                        cx={x(points[0].at)}
                        cy={y(points[0].remaining)}
                        r={3}
                      />
                    )}
                  </g>
                );
              })}
              {series.attempts.map((a, i) => (
                <line
                  key={`attempt-${i}`}
                  className={styles.failure}
                  x1={x(a.attemptedAt)}
                  x2={x(a.attemptedAt)}
                  y1={234}
                  y2={242}
                >
                  <title>
                    {`${dateTime(a.attemptedAt)} · ${t(`quota_history.errors.${a.errorCode}`)}`}
                  </title>
                </line>
              ))}
              {last.resetAt !== null && last.resetAt >= from && last.resetAt <= to && (
                <g>
                  <line
                    className={styles.marker}
                    x1={x(last.resetAt)}
                    x2={x(last.resetAt)}
                    y1={32}
                    y2={242}
                  />
                  <text x={Math.min(830, x(last.resetAt) + 4)} y={20}>
                    {t('quota_history.planned_reset')}
                  </text>
                  <title>{`${t('quota_history.planned_reset')} · ${dateTime(last.resetAt)}`}</title>
                </g>
              )}
              {now >= from && now <= to && (
                <g>
                  <line className={styles.marker} x1={x(now)} x2={x(now)} y1={32} y2={242} />
                  <text x={x(now) - 4} y={20} textAnchor="end">
                    {t('quota_history.now')}
                  </text>
                </g>
              )}
              {projection.length > 0 && (
                <path className={`${styles.line} ${styles.estimate}`} d={path(projection)}>
                  <title>{t('quota_history.estimate')}</title>
                </path>
              )}
              {sample && (
                <g>
                  <line
                    className={styles.cursor}
                    x1={x(sample.measuredAt)}
                    x2={x(sample.measuredAt)}
                    y1={32}
                    y2={242}
                  />
                  <circle
                    className={styles.point}
                    cx={x(sample.measuredAt)}
                    cy={y(100 - sample.usedPercent)}
                    r={4}
                  />
                </g>
              )}
            </svg>
          </div>
          <div className={styles.legend}>
            <span>
              <i />
              {t('quota_history.recorded')}
            </span>
            <span>
              <i className={styles.dashed} />
              {t('quota_history.estimate')}
            </span>
            <span>{t('quota_history.gap_note')}</span>
          </div>
        </>
      ) : (
        <div className={styles.empty}>{t('quota_history.empty')}</div>
      )}
      <div className={styles.detail} id={descriptionId} aria-live="polite">
        {sampleDescription} · {t('quota_history.keyboard')}
      </div>
    </>
  );
}

export function QuotaHistoryChart() {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<HistoryProvider>('claude');
  const [credentialId, setCredentialId] = useState('');
  const [windowId, setWindowId] = useState('');
  const [range, setRange] = useState<number>(86400);
  const [offset, setOffset] = useState(0);
  const [burnHours, setBurnHours] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const history = useQuotaHistory(credentialId, windowId, range, offset, refresh);
  const { now } = history;
  const from = history.series?.from ?? history.from;
  const to = history.series?.to ?? history.to;
  const accounts = history.catalog?.credentials.filter((a) => a.provider === provider) ?? [];
  const account = accounts.find((a) => a.credentialId === credentialId) ?? accounts[0];
  const window = account?.windows.find((w) => w.windowId === windowId) ?? account?.windows[0];
  // Při prvním katalogu zvolíme stabilní ID; žádné párování s filename/email upstream účtu.
  const selectionKey = `${account?.credentialId ?? ''}:${window?.windowId ?? ''}`;
  const currentKey = `${credentialId}:${windowId}`;
  if (history.catalog && selectionKey !== currentKey) {
    setCredentialId(account?.credentialId ?? '');
    setWindowId(window?.windowId ?? '');
  }
  const series = history.series;
  const compatible =
    series &&
    account &&
    window &&
    series.provider === account.provider &&
    series.metadata.plan === window.plan &&
    series.metadata.scope === window.scope &&
    series.metadata.windowDurationSeconds === window.windowDurationSeconds &&
    series.metadata.resetSemantics === window.resetSemantics &&
    series.metadata.normalizationVersion === window.normalizationVersion;
  const change = (action: () => void) => {
    history.cancelSeries();
    action();
  };
  return (
    <section
      className={styles.history}
      aria-label={t('quota_history.title')}
      style={{ '--history-accent': `var(--quota-history-${provider})` } as CSSProperties}
    >
      <div className={styles.heading}>
        <h2>{t('quota_history.title')}</h2>
        <button type="button" onClick={() => change(() => setRefresh((v) => v + 1))}>
          {t('quota_history.refresh')}
        </button>
      </div>
      <div className={styles.controls}>
        <label>
          {t('quota_history.provider')}
          <select
            aria-label={t('quota_history.provider')}
            value={provider}
            onChange={(e) =>
              change(() => {
                setProvider(e.target.value as HistoryProvider);
                setCredentialId('');
                setWindowId('');
                setBurnHours(null);
              })
            }
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label>
          {t('quota_history.account')}
          <select
            aria-label={t('quota_history.account')}
            value={account?.credentialId ?? ''}
            disabled={!accounts.length}
            onChange={(e) =>
              change(() => {
                setCredentialId(e.target.value);
                setWindowId('');
                setBurnHours(null);
              })
            }
          >
            {!accounts.length && <option value="">{t('quota_history.empty_accounts')}</option>}
            {accounts.map((a) => (
              <option key={a.credentialId} value={a.credentialId}>
                {a.alias}
                {a.active ? '' : ` · ${t('quota_history.inactive')}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('quota_history.window')}
          <select
            aria-label={t('quota_history.window')}
            value={window?.windowId ?? ''}
            disabled={!window}
            onChange={(e) =>
              change(() => {
                setWindowId(e.target.value);
                setBurnHours(null);
              })
            }
          >
            {!window && <option value="">{t('quota_history.empty_windows')}</option>}
            {account?.windows.map((w) => (
              <option key={w.windowId} value={w.windowId}>
                {w.label} · {t(`quota_history.plans.${w.plan}`)} ·{' '}
                {t(`quota_history.scopes.${w.scope}`)} ·{' '}
                {w.firstMeasuredAt === null
                  ? t('quota_history.empty')
                  : dateTime(w.firstMeasuredAt)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('quota_history.range')}
          <select
            aria-label={t('quota_history.range')}
            value={range}
            onChange={(e) =>
              change(() => {
                setRange(Number(e.target.value));
                setOffset(0);
              })
            }
          >
            {HISTORY_RANGES.map((s, i) => (
              <option value={s} key={s}>
                {t(`quota_history.ranges.${['6h', '24h', '7d', '30d'][i]}`)}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.navigation}>
          <button
            type="button"
            aria-label={t('quota_history.previous')}
            disabled={from <= now - 2592000}
            onClick={() => change(() => setOffset((v) => v - 1))}
          >
            ‹
          </button>
          <button type="button" disabled={offset === 0} onClick={() => change(() => setOffset(0))}>
            {t('quota_history.today')}
          </button>
          <button
            type="button"
            aria-label={t('quota_history.next')}
            disabled={offset >= 0}
            onClick={() => change(() => setOffset((v) => Math.min(0, v + 1)))}
          >
            ›
          </button>
        </div>
      </div>
      <div className={styles.muted}>
        {dateTime(from)} – {dateTime(to - 1)}
      </div>
      {history.catalogStatus === 'unavailable' ||
      history.seriesStatus === 'unavailable' ||
      (series && !compatible) ? (
        <div className={styles.empty} role="status">
          {t('quota_history.unavailable')}
        </div>
      ) : !history.catalog || (window && !series) ? (
        <div className={styles.empty} role="status">
          {t('quota_history.loading')}
        </div>
      ) : compatible ? (
        <QuotaHistoryPlot
          key={`${currentKey}:${range}:${offset}`}
          series={series}
          from={from}
          to={offset === 0 ? to + range / 3 : to}
          now={now}
          clockTrusted={history.clockTrusted}
          burnHours={burnHours}
          onBurnChange={setBurnHours}
        />
      ) : (
        <div className={styles.empty}>{t('quota_history.empty')}</div>
      )}
    </section>
  );
}
