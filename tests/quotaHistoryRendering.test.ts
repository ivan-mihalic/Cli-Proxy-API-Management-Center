import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import i18n from '../src/i18n/index';
import { QuotaHistoryPlot } from '../src/features/quota/components/QuotaHistoryChart';
import { quotaAccountSeriesFixture } from './quotaHistoryModel.test';

const render = (series: ReturnType<typeof quotaAccountSeriesFixture>) =>
  renderToStaticMarkup(
    createElement(QuotaHistoryPlot, {
      series,
      from: series.from,
      to: series.generatedAt + 86400,
      now: series.generatedAt,
      burnHours: null,
      onBurnChange: () => {},
    })
  );

test('empty and first measurement cannot invent zero burn or an estimate', async () => {
  await i18n.changeLanguage('en');
  const s = quotaAccountSeriesFixture();
  s.samples = [];
  expect(render(s)).toContain('No measurements in this period');
  s.samples = [quotaAccountSeriesFixture().samples.at(-1)!];
  const html = render(s);
  expect(html).toContain('Insufficient data');
  expect(html).not.toContain('<title>Estimate</title>');
  expect(html).toContain('54%');
  expect(html).toContain('tabindex="0"');
});

test('latest error retains remaining history and disables estimate with fresh samples', () => {
  const s = quotaAccountSeriesFixture();
  s.quality.lastErrorCode = 'missing';
  const html = render(s);
  expect(html).toContain('54%');
  expect(html).toContain('Missing window');
  expect(html).not.toContain('<title>Estimate</title>');
  expect(html).toContain('range coverage');
});
