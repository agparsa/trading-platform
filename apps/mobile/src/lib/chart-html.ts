import type { ChartBar } from '@tp/chart-core';

/**
 * The page the chart renders inside.
 *
 * ## Why a WebView and not a native chart library
 *
 * Because the renderer is already decided and already behind a boundary. The
 * web terminal draws with `lightweight-charts` through `@tp/chart-core`, and
 * `docs/charting.md` records that the boundary exists so the renderer can be
 * swapped once TradingView Advanced Charts is licensed. Adding a *second*
 * renderer for the phone would mean two candlestick implementations to keep
 * looking the same, and a trader who saw a different chart on each device would
 * be right to distrust both.
 *
 * The cost is a WebView bridge and a JavaScript context per chart. That is a
 * real cost and it is paid deliberately.
 *
 * ## Why the library is loaded from a CDN and pinned
 *
 * A bundled copy would need the file vendored into the app and updated by hand.
 * Pinned to an exact version because an unpinned chart library is a rendering
 * change nobody reviewed, shipped to a phone at whatever moment upstream
 * publishes.
 */
export const LIGHTWEIGHT_CHARTS_VERSION = '5.2.1';

export interface ChartTheme {
  background: string;
  text: string;
  grid: string;
  up: string;
  down: string;
}

/**
 * Builds the page.
 *
 * Bars are injected as JSON rather than fetched from inside the WebView: the
 * access token lives in the keychain on the native side, and handing it to a
 * browser context to make its own authenticated requests would put a
 * credential somewhere it does not need to be.
 */
export function chartHtml(options: {
  theme: ChartTheme;
  pricePrecision: number;
  minMove: string;
}): string {
  const { theme, pricePrecision, minMove } = options;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body, #chart { margin: 0; padding: 0; height: 100%; width: 100%; background: ${theme.background}; }
  #empty { color: ${theme.text}; font: 13px -apple-system, system-ui, sans-serif; opacity: 0.6;
           position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
</style>
<script src="https://unpkg.com/lightweight-charts@${LIGHTWEIGHT_CHARTS_VERSION}/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
<div id="chart"></div>
<div id="empty">Loading chart…</div>
<script>
  (function () {
    var chart = null;
    var series = null;
    var empty = document.getElementById('empty');

    function post(message) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }

    function ensure() {
      if (chart !== null) return;
      if (typeof LightweightCharts === 'undefined') {
        // The CDN did not load — an offline phone, or a blocked network. Said
        // out loud rather than left as a blank rectangle the trader will read
        // as "no data".
        post({ type: 'error', message: 'chart library unavailable' });
        empty.textContent = 'Chart unavailable offline.';
        return;
      }
      chart = LightweightCharts.createChart(document.getElementById('chart'), {
        layout: { background: { color: ${scriptSafeJson(theme.background)} }, textColor: ${scriptSafeJson(theme.text)} },
        grid: { vertLines: { color: ${scriptSafeJson(theme.grid)} }, horzLines: { color: ${scriptSafeJson(theme.grid)} } },
        rightPriceScale: { borderColor: ${scriptSafeJson(theme.grid)} },
        timeScale: { borderColor: ${scriptSafeJson(theme.grid)}, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
        handleScale: true,
        handleScroll: true,
      });
      series = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: ${scriptSafeJson(theme.up)},
        downColor: ${scriptSafeJson(theme.down)},
        wickUpColor: ${scriptSafeJson(theme.up)},
        wickDownColor: ${scriptSafeJson(theme.down)},
        borderVisible: false,
        priceFormat: { type: 'price', precision: ${pricePrecision}, minMove: ${scriptSafeJson(minMove)} },
      });
      window.addEventListener('resize', function () {
        if (chart !== null) chart.applyOptions({});
      });
      post({ type: 'ready' });
    }

    /**
     * Created once, then fed.
     *
     * Recreating the chart when data changes throws away the trader's pan and
     * zoom on every tick — the same rule the web terminal follows, for the same
     * reason.
     */
    window.__setBars = function (bars) {
      ensure();
      if (series === null) return;
      empty.style.display = bars.length === 0 ? 'flex' : 'none';
      if (bars.length === 0) { empty.textContent = 'No bars for this window.'; return; }
      series.setData(bars.map(function (bar) {
        return {
          // lightweight-charts wants seconds, the platform speaks milliseconds.
          time: Math.floor(bar.time / 1000),
          open: Number(bar.open), high: Number(bar.high),
          low: Number(bar.low), close: Number(bar.close),
        };
      }));
    };

    /** One bar, for the in-progress candle arriving on the socket. */
    window.__updateBar = function (bar) {
      ensure();
      if (series === null) return;
      empty.style.display = 'none';
      series.update({
        time: Math.floor(bar.time / 1000),
        open: Number(bar.open), high: Number(bar.high),
        low: Number(bar.low), close: Number(bar.close),
      });
    };

    ensure();
  })();
</script>
</body>
</html>`;
}

/**
 * JSON that is safe to place inside a `<script>` element.
 *
 * `JSON.stringify` does **not** escape `<`, so a string containing
 * `</script>` closes the surrounding element and everything after it is parsed
 * as HTML. Bar data comes from a market feed rather than from a trader, which
 * makes this unlikely rather than impossible — and "unlikely" is not a property
 * worth relying on for something that renders in a browser context holding a
 * session.
 *
 * U+2028 and U+2029 are escaped for a different reason: they are valid inside a
 * JSON string and are line terminators in JavaScript, so an unescaped one turns
 * the rest of the expression into a syntax error.
 *
 * Discovered by a test that assumed `JSON.stringify` already did this. It does
 * not.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The call injected to replace the whole series. */
export function setBarsScript(bars: readonly ChartBar[]): string {
  return `window.__setBars(${scriptSafeJson(bars)}); true;`;
}

/** The call injected for a single live bar. */
export function updateBarScript(bar: ChartBar): string {
  return `window.__updateBar(${scriptSafeJson(bar)}); true;`;
}
