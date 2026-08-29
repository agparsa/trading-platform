/**
 * What happened to the orders this browser submitted.
 *
 * ## Why a command log exists at all
 *
 * Before this, sending an order produced a spinner and then nothing. The tables
 * refreshed, and the trader was left to work out for themselves whether the row
 * that appeared was theirs. On a fast market, with two orders in flight, that is
 * not a question a person can answer.
 *
 * So every submission is recorded against the idempotency key it was actually
 * sent with — which is the platform's own notion of "this attempt", the same
 * value that stops a retry opening a second position. Calling it a command id
 * is naming what it already was.
 *
 * ## The states, and why there are four
 *
 * - `SUBMITTING` — the request is in flight. Nothing is known.
 * - `ACCEPTED`  — the server took it. For a resting order this is the *end* of
 *   the story until the market reaches it, and conflating it with execution
 *   would tell a trader their limit had filled the moment they placed it.
 * - `EXECUTED`  — a position exists. Either the market-order response said so,
 *   or an `order.filled` frame later named this order.
 * - `REJECTED`  — the server refused, and the reason is kept.
 *
 * The distinction that earns its keep is ACCEPTED vs EXECUTED. Everything else
 * follows from it.
 *
 * ## What this module is not
 *
 * Not a source of truth about positions. The tables come from REST and always
 * will; this log says what *this browser asked for* and what it was told. If
 * the two ever disagree, the tables are right.
 */

export const CommandState = {
  SUBMITTING: 'SUBMITTING',
  ACCEPTED: 'ACCEPTED',
  EXECUTED: 'EXECUTED',
  REJECTED: 'REJECTED',
} as const;
export type CommandState = (typeof CommandState)[keyof typeof CommandState];

export type CommandOrderType = 'MARKET' | 'LIMIT' | 'STOP';

export interface OrderCommand {
  /** The idempotency key this attempt was sent with. */
  commandId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: CommandOrderType;
  volume: string;
  state: CommandState;
  /** When it was submitted, epoch ms. */
  at: number;
  /** When it reached a state that is not SUBMITTING. */
  settledAt: number | null;
  orderId: string | null;
  positionId: string | null;
  /** The price the server reported, once it reported one. */
  price: string | null;
  /** Why it was refused. Only ever set on REJECTED. */
  reason: string | null;
}

/**
 * How many commands to keep.
 *
 * Enough to see a burst of manual orders; small enough that a terminal left open
 * all day does not accumulate an unbounded list of things nobody will scroll
 * back to. The tables are the record; this is the last few seconds of context.
 */
export const COMMAND_LOG_LIMIT = 12;

export interface NewCommand {
  commandId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: CommandOrderType;
  volume: string;
  at: number;
}

/** Records a submission, newest first. */
export function beginCommand(log: readonly OrderCommand[], command: NewCommand): OrderCommand[] {
  const entry: OrderCommand = {
    ...command,
    state: CommandState.SUBMITTING,
    settledAt: null,
    orderId: null,
    positionId: null,
    price: null,
    reason: null,
  };
  return [entry, ...log.filter((row) => row.commandId !== command.commandId)].slice(
    0,
    COMMAND_LOG_LIMIT,
  );
}

export interface CommandSettlement {
  state: CommandState;
  orderId?: string | null;
  positionId?: string | null;
  price?: string | null;
  reason?: string | null;
  at: number;
}

/**
 * Applies an outcome to one command.
 *
 * A command that is not in the log is ignored rather than created: an outcome
 * with no submission behind it means the log was trimmed, and inventing a row
 * for it would show a trader an order with no beginning.
 */
export function settleCommand(
  log: readonly OrderCommand[],
  commandId: string,
  settlement: CommandSettlement,
): OrderCommand[] {
  return log.map((row) =>
    row.commandId === commandId
      ? {
          ...row,
          state: settlement.state,
          settledAt: settlement.at,
          orderId: settlement.orderId ?? row.orderId,
          positionId: settlement.positionId ?? row.positionId,
          price: settlement.price ?? row.price,
          reason: settlement.reason ?? null,
        }
      : row,
  );
}

/**
 * What the server's answer means for a command's state.
 *
 * A market order that came back with a position id has executed. A resting order
 * that came back has been *accepted* and is now waiting for the market — saying
 * "executed" there would be a lie the trader would act on.
 *
 * A market order whose response carries no position id is left ACCEPTED rather
 * than guessed at. It should not happen, and if it does the honest reading is
 * "the server took it and did not tell us it filled".
 */
export function settlementFromResponse(
  type: CommandOrderType,
  response: unknown,
  at: number,
): CommandSettlement {
  const body = (response ?? {}) as Record<string, unknown>;
  const orderId = typeof body['orderId'] === 'string' ? body['orderId'] : null;
  const positionId = typeof body['positionId'] === 'string' ? body['positionId'] : null;
  const price = typeof body['price'] === 'string' ? body['price'] : null;

  const executed = type === 'MARKET' && positionId !== null;
  return {
    state: executed ? CommandState.EXECUTED : CommandState.ACCEPTED,
    orderId,
    positionId,
    price,
    at,
  };
}

/**
 * A resting order filled, reported by the socket rather than by a response.
 *
 * Matched on order id because that is the only identifier the fill carries — the
 * command id belongs to the submission, and by the time a limit triggers, hours
 * may have passed. Only an ACCEPTED command advances: a rejected one cannot
 * later fill, and re-marking an already-executed one would move its settlement
 * time for no reason.
 */
export function noteOrderFilled(
  log: readonly OrderCommand[],
  orderId: string,
  positionId: string | null,
  at: number,
): OrderCommand[] {
  return log.map((row) =>
    row.orderId === orderId && row.state === CommandState.ACCEPTED
      ? {
          ...row,
          state: CommandState.EXECUTED,
          positionId: positionId ?? row.positionId,
          settledAt: at,
        }
      : row,
  );
}

/** A resting order the trader cancelled, or one the server expired. */
export function noteOrderClosed(
  log: readonly OrderCommand[],
  orderId: string,
  reason: string,
  at: number,
): OrderCommand[] {
  return log.map((row) =>
    row.orderId === orderId && row.state === CommandState.ACCEPTED
      ? { ...row, state: CommandState.REJECTED, reason, settledAt: at }
      : row,
  );
}

/** Short label for the state, for a column that has no room for a sentence. */
export const COMMAND_STATE_LABEL: Record<CommandState, string> = {
  [CommandState.SUBMITTING]: 'sending',
  [CommandState.ACCEPTED]: 'accepted',
  [CommandState.EXECUTED]: 'filled',
  [CommandState.REJECTED]: 'refused',
};
