import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every metric this platform declares is fed by something.
 *
 * Three were not, from the beginning:
 *
 * | Metric | Also appearing in |
 * | --- | --- |
 * | `tp_http_requests_total` | the `RequestsShed` alert, a dashboard panel, `observability.md` |
 * | `tp_http_request_duration_seconds` | a dashboard panel, `observability.md`, and cited in `order-timeline.ts` as the reason not to add a stage |
 * | `tp_execution_latency_seconds` | the `ExecutionLatencyHigh` alert, three dashboard panels, "the number that tells you whether the engine is healthy under load" |
 *
 * Measured on a running instance: six HTTP requests, and
 * `tp_http_requests_total` had a `# HELP` line and **zero samples**.
 *
 * **A registered metric with no samples is worse than a missing one.**
 * Prometheus answers a query against it with *no data* rather than an error, a
 * panel draws an empty chart rather than a broken one, and an alert on a series
 * that never exists never fires and never explains itself. Two of the shipped
 * alerts were in that state, and four dashboard panels.
 */

const API_SRC = join(__dirname, '..');
const METRICS = readFileSync(join(__dirname, 'metrics.service.ts'), 'utf8');

/** Each instrument declared on `MetricsService`, with its exported name. */
export function declaredMetrics(source: string): Array<{ field: string; name: string }> {
  const fields = [...source.matchAll(/^\s*readonly ([A-Za-z0-9_]+):\s*(?:Gauge|Counter|Histogram|Summary)\b/gm)]
    .map((match) => match[1])
    .filter((field): field is string => field !== undefined);
  return fields.map((field) => {
    const assignment = new RegExp(
      `this\\.${field}\\s*=\\s*new\\s+\\w+\\(\\{[\\s\\S]*?name:\\s*'([^']+)'`,
    ).exec(source);
    return { field, name: assignment?.[1] ?? '' };
  });
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    if (path.endsWith(join('metrics', 'metrics.service.ts'))) continue;
    found.push(path);
  }
  return found;
}

const APPLICATION = sourceFiles(API_SRC)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

describe('declared metrics', () => {
  it('finds the declarations it is meant to be checking', () => {
    const declared = declaredMetrics(METRICS);
    expect(declared.length).toBeGreaterThanOrEqual(25);
    for (const metric of declared) {
      expect(metric.name, `${metric.field} has no exported name`).not.toBe('');
      expect(metric.name).toMatch(/^tp_/);
    }
  });

  /**
   * Written against the *field*, not the exported name, because that is what a
   * call site uses: `metrics.httpRequests.inc(...)`.
   */
  it('has something that writes to each one', () => {
    const unfed = declaredMetrics(METRICS)
      .filter(({ field }) => !new RegExp(`metrics\\.${field}\\b`).test(APPLICATION))
      .map(({ field, name }) => `${field} (${name})`);
    expect(
      unfed,
      'these are exported to Prometheus and nothing ever gives them a sample — ' +
        'a query against one answers "no data", and an alert on it never fires',
    ).toEqual([]);
  });

  /**
   * The other direction: a dashboard or an alert naming a metric this build
   * does not export is the same failure seen from the other end, and is how the
   * three above stayed invisible — everything referred to them, so they looked
   * real.
   */
  it('exports every metric the shipped alerts and dashboard query', () => {
    const observability = join(API_SRC, '..', '..', '..', 'docker', 'observability');
    const queried = new Set<string>();
    for (const file of [
      join(observability, 'alerts.yml'),
      join(observability, 'grafana', 'dashboards', 'trading-platform.json'),
    ]) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\btp_[a-z0-9_]+/g)) {
        // Histogram queries name the derived series, which prom-client exports
        // from the base histogram.
        queried.add(match[0].replace(/_(bucket|sum|count)$/, ''));
      }
    }
    expect(queried.size).toBeGreaterThan(5);

    const exported = new Set(declaredMetrics(METRICS).map(({ name }) => name));
    const missing = [...queried].filter(
      (name) => !exported.has(name) && !name.startsWith('tp_nodejs_') && !name.startsWith('tp_process_'),
    );
    expect(missing, 'a dashboard or an alert queries a metric this build does not export').toEqual(
      [],
    );
  });
});
