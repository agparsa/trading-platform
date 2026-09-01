import { describe, expect, it } from 'vitest';
import type { ChartBar } from '@tp/chart-core';
import {
  LIGHTWEIGHT_CHARTS_VERSION,
  chartHtml,
  setBarsScript,
  updateBarScript,
} from './chart-html';

const theme = {
  background: '#0B0E11',
  text: '#E6EAF0',
  grid: '#252D38',
  up: '#16C784',
  down: '#EA3943',
};

const bar: ChartBar = {
  time: 1_788_000_000_000,
  open: '4583.58',
  high: '4590.00',
  low: '4580.10',
  close: '4588.20',
  volume: '120',
};

describe('the chart page', () => {
  it('pins the library version', () => {
    // An unpinned chart library is a rendering change nobody reviewed, shipped
    // to a phone at whatever moment upstream publishes.
    const html = chartHtml({ theme, pricePrecision: 2, minMove: '0.01' });
    expect(html).toContain(`lightweight-charts@${LIGHTWEIGHT_CHARTS_VERSION}`);
    expect(LIGHTWEIGHT_CHARTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses the instrument's own precision, not a default", () => {
    const html = chartHtml({ theme, pricePrecision: 5, minMove: '0.00001' });
    expect(html).toContain('precision: 5');
    expect(html).toContain('"0.00001"');
  });

  it('carries the theme into the page rather than hard-coding colours', () => {
    const html = chartHtml({ theme, pricePrecision: 2, minMove: '0.01' });
    expect(html).toContain(theme.up);
    expect(html).toContain(theme.down);
    expect(html).toContain(theme.background);
  });

  it('says so when the library cannot load', () => {
    // A blank rectangle reads as "no data", which is a different and much
    // more alarming thing than "you are offline".
    const html = chartHtml({ theme, pricePrecision: 2, minMove: '0.01' });
    expect(html).toContain('chart library unavailable');
    expect(html).toContain('Chart unavailable offline.');
  });

  it('converts milliseconds to the seconds the library expects', () => {
    const html = chartHtml({ theme, pricePrecision: 2, minMove: '0.01' });
    // The platform speaks milliseconds throughout; lightweight-charts wants
    // seconds. Getting this wrong puts every bar in the year 58000.
    expect(html).toContain('Math.floor(bar.time / 1000)');
  });
});

describe('the injected calls', () => {
  it('serialises a whole series', () => {
    const script = setBarsScript([bar]);
    expect(script).toContain('__setBars');
    expect(script).toContain('4583.58');
    // Injected scripts must evaluate to something truthy or iOS logs a warning
    // on every call.
    expect(script.trim().endsWith('true;')).toBe(true);
  });

  it('serialises one bar', () => {
    const script = updateBarScript(bar);
    expect(script).toContain('__updateBar');
    expect(script.trim().endsWith('true;')).toBe(true);
  });

  it('keeps prices as strings on the way in', () => {
    // The server sends exact decimal strings. They are converted to numbers
    // inside the page, at the last possible moment, because that is where the
    // renderer needs them — not before.
    expect(setBarsScript([bar])).toContain('"open":"4583.58"');
  });

  it('escapes a payload that would otherwise break out of the script', () => {
    const nasty: ChartBar = { ...bar, open: '</script><script>alert(1)</script>' };
    const script = setBarsScript([nasty]);
    /**
     * `JSON.stringify` alone does not do this — the first version of this test
     * assumed it did, and failed. `<` is escaped to `\u003c` so the string
     * cannot terminate the surrounding element, and the JSON still parses to
     * exactly the original text.
     */
    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c');
    expect(JSON.parse(script.slice(script.indexOf('(') + 1, script.lastIndexOf(')')))).toEqual([
      nasty,
    ]);
  });
});
