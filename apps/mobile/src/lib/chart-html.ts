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
  /** A take-profit's colour, for the drag preview. */
  profit: string;
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
  #chart { touch-action: none; }
  #tags { position: absolute; inset: 0; z-index: 10; pointer-events: none; overflow: hidden; }
  .tag { position: absolute; transform: translateY(-50%); white-space: nowrap; font: 600 10px ui-monospace, Menlo, monospace;
         padding: 2px 6px; border-radius: 4px; color: #fff; }
  .tag.buy { background: ${theme.up}; color: #04140d; } .tag.sell { background: ${theme.down}; }
  .tag.sl { background: ${theme.down}; } .tag.tp { background: ${theme.profit}; color: #04141c; }
  .leader { position: absolute; width: 1px; }
  #empty { color: ${theme.text}; font: 13px -apple-system, system-ui, sans-serif; opacity: 0.6;
           position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
</style>
<script src="https://unpkg.com/lightweight-charts@${LIGHTWEIGHT_CHARTS_VERSION}/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
<div id="chart"></div>
<div id="tags"></div>
<div id="empty">Loading chart…</div>
<script>
  (function () {
    var chart = null;
    var series = null;
    var empty = document.getElementById('empty');

    function post(message) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
      else if (window.parent !== window) window.parent.postMessage(JSON.stringify(message), '*');
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

    /**
     * The open positions' lines: entry, stop and target. Rebuilt whole — a
     * price line has no movable price, and a handful is nothing to redraw.
     */
    var lines = [];
    window.__setLevels = function (levels) {
      ensure();
      if (series === null) return;
      for (var i = 0; i < lines.length; i++) series.removePriceLine(lines[i]);
      lines = [];
      // The scale stretches to show every level: a stop just off the top of
      // the screen is a stop the trader cannot see, which is the same as not
      // knowing where it is.
      var prices = levels.map(function (level) { return Number(level.price); })
        .filter(function (price) { return isFinite(price); });
      series.applyOptions({
        autoscaleInfoProvider: function (original) {
          var base = original();
          if (prices.length === 0) return base;
          var all = prices.slice();
          if (base !== null && base.priceRange !== null) {
            all.push(base.priceRange.minValue, base.priceRange.maxValue);
          }
          return {
            priceRange: { minValue: Math.min.apply(null, all), maxValue: Math.max.apply(null, all) },
            margins: base === null ? undefined : base.margins,
          };
        },
      });
      current = levels;
      for (var j = 0; j < levels.length; j++) {
        var level = levels[j];
        // A tagged line keeps no canvas label: the tag beside the scale says
        // it, and canvas labels of nearby lines would print over each other.
        lines.push(series.createPriceLine({
          price: Number(level.price),
          color: level.color,
          lineWidth: level.width,
          lineStyle: level.dashed ? 2 : 0,
          axisLabelVisible: !level.tag,
          title: level.tag ? '' : level.title,
        }));
      }
      placeTags();
    };

    /**
     * Dragging a position's line to set its stop or target.
     *
     * A touch within a finger's width of a position's line takes it: the chart
     * stops panning, a preview line follows the finger, and the release says
     * where to the app, which asks before anything is sent. A touch anywhere
     * else is the chart's, as before. The preview stays until the app clears
     * it — after the trader's answer — so the price being asked about is the
     * one on screen.
     */
    var current = [];
    var grab = null;
    var preview = null;
    var GRAB_PX = 22;
    var precision = ${pricePrecision};
    var tick = Number(${scriptSafeJson(minMove)});
    var colours = { STOP_LOSS: ${scriptSafeJson(theme.down)}, TAKE_PROFIT: ${scriptSafeJson(theme.profit)} };

    function snap(price) {
      var stepped = tick > 0 ? Math.round(price / tick) * tick : price;
      return stepped.toFixed(precision);
    }
    function kindAt(level, price) {
      if (level.drag.kind !== 'ENTRY') return level.drag.kind;
      var below = Number(price) < Number(level.drag.entry);
      if (Number(price) === Number(level.drag.entry)) return null;
      return (level.drag.side === 'BUY') === below ? 'STOP_LOSS' : 'TAKE_PROFIT';
    }
    function drawPreview(kind, price) {
      if (preview !== null) { series.removePriceLine(preview); preview = null; }
      if (kind === null) return;
      preview = series.createPriceLine({
        price: Number(price),
        color: colours[kind],
        lineWidth: 2,
        lineStyle: 3,
        axisLabelVisible: true,
        title: (kind === 'STOP_LOSS' ? 'SL ' : 'TP ') + price,
      });
    }
    function yOf(event) {
      var box = document.getElementById('chart').getBoundingClientRect();
      return event.clientY - box.top;
    }
    var host = document.getElementById('chart');
    host.addEventListener('pointerdown', function (event) {
      if (series === null) return;
      var y = yOf(event);
      var best = null;
      for (var i = 0; i < current.length; i++) {
        var level = current[i];
        if (!level.drag) continue;
        var at = series.priceToCoordinate(Number(level.price));
        if (at === null) continue;
        var distance = Math.abs(at - y);
        if (distance <= GRAB_PX && (best === null || distance < best.distance)) {
          best = { level: level, distance: distance };
        }
      }
      if (best === null) return;
      grab = { level: best.level, kind: null, price: null };
      chart.applyOptions({ handleScroll: false, handleScale: false });
      event.stopPropagation();
      event.preventDefault();
    }, true);
    host.addEventListener('pointermove', function (event) {
      if (grab === null) return;
      var price = series.coordinateToPrice(yOf(event));
      if (price === null) return;
      grab.price = snap(price);
      grab.kind = kindAt(grab.level, grab.price);
      drawPreview(grab.kind, grab.price);
      event.stopPropagation();
      event.preventDefault();
    }, true);
    function release(event) {
      if (grab === null) return;
      var done = grab;
      grab = null;
      chart.applyOptions({ handleScroll: true, handleScale: true });
      event.stopPropagation();
      if (done.kind === null || done.price === null) { drawPreview(null, null); return; }
      post({ type: 'level', positionId: done.level.drag.positionId, kind: done.kind, price: done.price });
    }
    host.addEventListener('pointerup', release, true);
    host.addEventListener('pointercancel', release, true);
    window.__clearPreview = function () { drawPreview(null, null); };
    /** Where a price sits on screen — for the walk that drags a line in a test. */
    window.__coordinate = function (price) {
      return series === null ? null : series.priceToCoordinate(Number(price));
    };

    /**
     * The tags of the positions' lines, beside the price scale. Each sits at
     * its line's exact height unless that would cover another; then it moves
     * just far enough, and a thin leader joins it to its line. Re-placed on
     * every frame the scale may have moved — cheaply, by comparing first.
     */
    var tagLayer = document.getElementById('tags');
    var lastLayout = '';
    var TAG_GAP = 18;
    function placeTags() {
      if (series === null || chart === null) return;
      var items = [];
      for (var i = 0; i < current.length; i++) {
        var level = current[i];
        if (!level.tag) continue;
        var y = series.priceToCoordinate(Number(level.price));
        if (y === null) continue;
        items.push({ y: y, at: y, tag: level.tag, color: level.color });
      }
      items.sort(function (a, b) { return a.y - b.y; });
      for (var k = 1; k < items.length; k++) {
        if (items[k].at < items[k - 1].at + TAG_GAP) items[k].at = items[k - 1].at + TAG_GAP;
      }
      var height = tagLayer.clientHeight;
      for (var m = items.length - 1; m >= 0; m--) {
        var limit = m === items.length - 1 ? height - 10 : items[m + 1].at - TAG_GAP;
        if (items[m].at > limit) items[m].at = limit;
      }
      var scale = chart.priceScale('right').width();
      var layout = JSON.stringify([scale, items.map(function (t) { return [Math.round(t.y), Math.round(t.at), t.tag.text]; })]);
      if (layout === lastLayout) return;
      lastLayout = layout;
      var html = '';
      for (var n = 0; n < items.length; n++) {
        var t = items[n];
        var text = String(t.tag.text).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; });
        if (Math.abs(t.at - t.y) > 1) {
          html += '<div class="leader" style="right:' + (scale + 2) + 'px;top:' + Math.min(t.y, t.at) + 'px;height:' +
            Math.abs(t.at - t.y) + 'px;background:' + t.color + '"></div>';
        }
        html += '<div class="tag ' + t.tag.tone + '" style="right:' + (scale + 4) + 'px;top:' + t.at + 'px">' + text + '</div>';
      }
      tagLayer.innerHTML = html;
    }
    (function frame() { placeTags(); requestAnimationFrame(frame); })();

    /** One bar, for the in-progress candle arriving on the socket. */
    window.__updateBar = function (bar) {
      ensure();
      if (series === null) return;
      empty.style.display = 'none';
      // Counted, so a check can see that the chart is being fed live.
      window.__liveBars = (window.__liveBars || 0) + 1;
      // A bar older than the newest drawn (a frame overtaken by a reload) is
      // refused by the library; it is simply not drawn.
      try {
        series.update({
          time: Math.floor(bar.time / 1000),
          open: Number(bar.open), high: Number(bar.high),
          low: Number(bar.low), close: Number(bar.close),
        });
      } catch (e) {}
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

/** One line on the chart: a position's entry, stop or target. */
export interface ChartLevel {
  readonly price: string;
  readonly color: string;
  readonly width: 1 | 2;
  readonly dashed: boolean;
  readonly title: string;
  /**
   * A position's label, drawn beside the price scale instead of on the canvas:
   * labels of several trades at nearby prices are spread apart so none hides
   * another, while each line stays at its exact price.
   */
  readonly tag?: { readonly text: string; readonly tone: 'buy' | 'sell' | 'sl' | 'tp' };
  /** Set on a position's lines: what a drag of this line may change. */
  readonly drag?: {
    readonly positionId: string;
    readonly kind: 'ENTRY' | 'STOP_LOSS' | 'TAKE_PROFIT';
    readonly side: 'BUY' | 'SELL';
    readonly entry: string;
  };
}

/** The call injected to redraw the position lines. */
export function setLevelsScript(levels: readonly ChartLevel[]): string {
  return `window.__setLevels(${scriptSafeJson(levels)}); true;`;
}

/** The call injected to take the drag preview away, after the trader answered. */
export const CLEAR_PREVIEW_SCRIPT = 'window.__clearPreview && window.__clearPreview(); true;';
