/**
 * "Close all" on the phone: the same server command the terminal sends
 * (`POST /positions/close-all`), one intent and one report, never a loop of
 * single closes — a loop that dropped its connection halfway would leave
 * the rest open under a screen that said the button had been pressed.
 *
 * Kept out of the screen so the two things that decide what a trader is told
 * can be tested: which idempotency key a press carries, and how the server's
 * per-position report is put into words.
 */

export interface CloseAllOutcome {
  readonly asked: number;
  readonly closed: ReadonlyArray<{ readonly positionId: string }>;
  readonly refused: ReadonlyArray<{
    readonly positionId: string;
    readonly code: string;
    readonly message: string;
  }>;
}

/**
 * One key per confirmation, minted when the question is asked.
 *
 * A second tap on "Close all" while the first request is in flight, or a
 * retry after a timeout, is the same intent and must be recognised as such —
 * a key minted per tap would let two commands race each other. Asking again
 * after cancelling is a new intent and gets a new key.
 */
export function closeAllKey(accountId: string, askedAt: number, nonce: string): string {
  return `close-all:${accountId}:${askedAt}:${nonce}`;
}

/** The question, in words, before anything is sent. */
export function closeAllQuestion(count: number): string {
  const noun = count === 1 ? 'position' : 'positions';
  return (
    `Close all ${count} ${noun} at market? Each closes at its own price. ` +
    'Any that cannot be closed right now stays open and is listed.'
  );
}

export interface CloseAllReport {
  /** `done` when everything asked for closed; `partial` otherwise. */
  readonly tone: 'done' | 'partial';
  readonly message: string;
  /** Each position still open, with the reason the server gave. */
  readonly stillOpen: ReadonlyArray<{ readonly positionId: string; readonly reason: string }>;
}

/**
 * What the server reported, in words. Not atomic, and the words say so: a
 * `200` means the command ran, not that everything shut.
 */
export function closeAllReport(outcome: CloseAllOutcome): CloseAllReport {
  const closed = outcome.closed.length;
  const stillOpen = outcome.refused.map((one) => ({
    positionId: one.positionId,
    reason: one.message,
  }));
  if (stillOpen.length === 0) {
    return {
      tone: 'done',
      message:
        closed === 0 ? 'Nothing was open to close.' : `Closed ${closed} of ${outcome.asked}.`,
      stillOpen,
    };
  }
  return {
    tone: 'partial',
    message:
      `Closed ${closed} of ${outcome.asked}. ` +
      (stillOpen.length === 1
        ? `One is still open: ${stillOpen[0]!.reason}`
        : `${stillOpen.length} are still open — each is listed with its reason.`),
    stillOpen,
  };
}
