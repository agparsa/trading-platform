import { fetchApiLiveness } from '@/lib/api';

/**
 * Which build is serving, and whether the API answers.
 *
 * This page used to carry a hand-typed list of fifteen phases, each marked
 * Complete or In progress — the first plan's list, retired on 3 September and
 * never updated after. It told every trader who followed the terminal's "Build
 * status" link that performance under load was finished (the thousand-trader
 * run has not been done) and that security testing stood at 25 attacks (it is
 * over sixty), beside an API line reading "up · undefineds", because the
 * liveness probe was read without unwrapping its envelope.
 *
 * A public page is the wrong place for a roadmap, and a hand-typed one goes
 * stale the day it is written. What stays is what the running system can say
 * about itself: the build each half is on, and whether they are the same one.
 * Progress against the plan is tracked in the repository, measured and dated.
 */
export const dynamic = 'force-dynamic';

export default async function StatusPage() {
  const liveness = await fetchApiLiveness();
  const web = process.env.TP_WEB_BUILD ?? 'unknown';
  const agree = liveness !== null && liveness.build === web && web !== 'unknown';

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="border-b border-terminal-border pb-8">
        <p className="numeric text-xs uppercase tracking-[0.2em] text-terminal-muted">
          Trading Platform
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-terminal-text">Build status</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-terminal-muted">
          Which build is serving, and whether the API answers. The build is a short digest of the
          release, the same one support will ask you for.
        </p>
        <a
          href="/"
          className="mt-4 inline-block text-xs text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ← Terminal
        </a>
      </header>

      <section
        className="mt-8 divide-y divide-terminal-border rounded-lg border border-terminal-border bg-terminal-surface"
        data-testid="build-status"
      >
        <Row
          label="API"
          detail={
            liveness === null
              ? 'not reachable from the web process'
              : `up ${liveness.uptimeSeconds}s · build ${liveness.build}`
          }
          ok={liveness !== null}
          verdict={liveness === null ? 'DOWN' : 'OK'}
        />
        <Row
          label="Web"
          detail={`build ${web}`}
          ok={web !== 'unknown'}
          verdict={web === 'unknown' ? 'UNSTAMPED' : 'OK'}
        />
        <Row
          label="Same release"
          detail={
            liveness === null
              ? 'cannot tell while the API is unreachable'
              : agree
                ? 'the web and the API are on the same build'
                : `web ${web}, API ${liveness.build} — a deploy is in progress, or one half was not updated`
          }
          ok={agree}
          verdict={agree ? 'YES' : 'NO'}
        />
      </section>
    </main>
  );
}

function Row({
  label,
  detail,
  ok,
  verdict,
}: {
  label: string;
  detail: string;
  ok: boolean;
  verdict: string;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div>
        <h2 className="text-sm font-medium text-terminal-text">{label}</h2>
        <p className="numeric mt-1 text-xs text-terminal-muted">{detail}</p>
      </div>
      <span
        className={`numeric rounded border px-2.5 py-1 text-xs ${
          ok
            ? 'border-terminal-long/40 bg-terminal-long/10 text-terminal-long'
            : 'border-terminal-short/40 bg-terminal-short/10 text-terminal-short'
        }`}
      >
        {verdict}
      </span>
    </div>
  );
}
