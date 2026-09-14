/**
 * The window a report covers, and why it is bounded.
 *
 * A report is a query somebody else's database runs for minutes. Two things
 * have to be refused rather than attempted: a window so wide the job cannot
 * finish, and a window that means nothing because it is backwards.
 */

/**
 * The widest window a single report may cover.
 *
 * A year, because that is the largest span anybody asks for as one file — a
 * tax year, an annual statement — and because a wider one is better served by
 * several reports that each finish. The cap is here rather than at the call
 * site so that every caller gets it, including a future one.
 */
export const MAX_WINDOW_DAYS = 366;

export interface ReportWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export type WindowProblem =
  | { readonly kind: 'not-a-date'; readonly which: 'from' | 'to' }
  | { readonly kind: 'backwards' }
  | { readonly kind: 'too-wide'; readonly days: number }
  | { readonly kind: 'in-the-future' };

/**
 * Reads a window from what a request supplied.
 *
 * Returns the problem rather than throwing, so the caller decides what an
 * invalid window means — a validation error at the API, a failed job in the
 * worker. Both need the same rules and neither wants the other's exception.
 */
export function readWindow(
  from: unknown,
  to: unknown,
  nowMs: number = Date.now(),
): { readonly window: ReportWindow } | { readonly problem: WindowProblem } {
  const fromMs = Date.parse(String(from));
  if (Number.isNaN(fromMs)) return { problem: { kind: 'not-a-date', which: 'from' } };
  const toMs = Date.parse(String(to));
  if (Number.isNaN(toMs)) return { problem: { kind: 'not-a-date', which: 'to' } };

  if (toMs <= fromMs) return { problem: { kind: 'backwards' } };

  /**
   * A day of slack on the future end, deliberately.
   *
   * "To the end of today" is the commonest request there is, and a client in a
   * timezone ahead of the server sends a `to` that is tomorrow by the server's
   * clock. Refusing that would make the report button fail for half the world
   * for reasons nobody could see.
   */
  if (fromMs > nowMs + 86_400_000) return { problem: { kind: 'in-the-future' } };

  const days = (toMs - fromMs) / 86_400_000;
  if (days > MAX_WINDOW_DAYS) {
    return { problem: { kind: 'too-wide', days: Math.ceil(days) } };
  }
  return { window: { fromMs, toMs } };
}

/** The problem, in words an operator can act on. */
export function explainWindow(problem: WindowProblem): string {
  switch (problem.kind) {
    case 'not-a-date':
      return `The ${problem.which} date is not a date.`;
    case 'backwards':
      return 'The window ends before it starts.';
    case 'too-wide':
      return `A report covers at most ${MAX_WINDOW_DAYS} days; this one asks for ${problem.days}. Ask for it in parts.`;
    case 'in-the-future':
      return 'The window starts in the future, so there is nothing in it yet.';
    default: {
      const never: never = problem;
      throw new Error(`no explanation for ${JSON.stringify(never)}`);
    }
  }
}
