/**
 * Turning a form into a patch for stop loss and take profit.
 *
 * ## Why this is its own file with its own tests
 *
 * Because the API distinguishes three states and a text input only has two.
 * `null` clears a level, omitting the field leaves it unchanged, and a value
 * sets it — while the form knows only "the box is empty" and "the box has
 * something in it". Collapsing those wrongly has two failure modes and both are
 * expensive:
 *
 * - a trader clears the stop-loss box, the field is omitted, and the stop is
 *   still there. It fires later on a position they believed was unprotected —
 *   or that they had deliberately widened.
 * - a trader types a stop, the field is omitted because the code compared
 *   against the wrong original, and the position sits unprotected while they
 *   believe it is covered.
 *
 * Neither is visible on the screen afterwards. Both are visible here.
 */
export interface ProtectiveForm {
  /** Empty string means the trader cleared it. */
  readonly stopLoss: string;
  readonly takeProfit: string;
}

export interface ProtectiveLevels {
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
}

export interface ProtectivePatch {
  stopLoss?: string | null;
  takeProfit?: string | null;
}

/**
 * What changed, in the shape the API expects.
 *
 * Returns `null` when nothing changed — the endpoint refuses an empty patch,
 * and sending one would surface as a validation error for a button the trader
 * pressed having changed nothing.
 */
export function protectivePatch(
  form: ProtectiveForm,
  original: ProtectiveLevels,
): ProtectivePatch | null {
  const patch: ProtectivePatch = {};

  const next = (raw: string): string | null => {
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  };

  const stopLoss = next(form.stopLoss);
  const takeProfit = next(form.takeProfit);

  // Compared numerically, not as strings: "1.5000" and "1.50" are the same
  // stop, and sending a patch for a level nobody moved is a needless write on
  // an audited table.
  if (!sameLevel(stopLoss, original.stopLoss)) patch.stopLoss = stopLoss;
  if (!sameLevel(takeProfit, original.takeProfit)) patch.takeProfit = takeProfit;

  return Object.keys(patch).length === 0 ? null : patch;
}

export function sameLevel(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Number(a);
  const right = Number(b);
  // A value that is not a number is compared literally rather than as NaN,
  // which is equal to nothing including itself and would make every patch look
  // like a change.
  if (!Number.isFinite(left) || !Number.isFinite(right)) return a === b;
  return left === right;
}

/**
 * A plain-language description of the change, for the confirmation.
 *
 * §43 wants dangerous actions confirmed, and "are you sure?" is not a
 * confirmation of anything — it does not say what is about to happen. Removing
 * a stop loss in particular deserves a sentence that says so in those words.
 */
export function describePatch(patch: ProtectivePatch): string {
  const parts: string[] = [];
  if ('stopLoss' in patch) {
    parts.push(
      patch.stopLoss === null
        ? 'remove the stop loss, leaving this position unprotected'
        : `move the stop loss to ${patch.stopLoss}`,
    );
  }
  if ('takeProfit' in patch) {
    parts.push(
      patch.takeProfit === null
        ? 'remove the take profit'
        : `move the take profit to ${patch.takeProfit}`,
    );
  }
  return parts.join(' and ');
}

/**
 * The same three-state problem, for a resting order.
 *
 * Price and volume are *not* nullable — an order without a price is not an
 * order — so an empty box there means "leave it alone", not "clear it". Stop
 * loss and take profit keep the clearing semantics. Two different rules on one
 * form is exactly the sort of thing that gets written once by hand and then
 * quietly diverges, so both live here with the tests.
 */
export interface PendingOrderForm {
  readonly price: string;
  readonly volume: string;
  readonly stopLoss: string;
  readonly takeProfit: string;
}

export interface PendingOrderState {
  readonly price: string;
  readonly volume: string;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
}

export interface PendingOrderPatch {
  price?: string;
  volume?: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
}

export function pendingOrderPatch(
  form: PendingOrderForm,
  original: PendingOrderState,
): PendingOrderPatch | null {
  const patch: PendingOrderPatch = {};

  const required = (raw: string, current: string): string | undefined => {
    const trimmed = raw.trim();
    // An empty required field is a half-finished edit, not an instruction.
    // Sending nothing is the safe reading; the server would reject '' anyway,
    // and rejecting it here means the trader is not told their whole edit
    // failed because of one blank box.
    if (trimmed.length === 0) return undefined;
    return sameLevel(trimmed, current) ? undefined : trimmed;
  };

  const price = required(form.price, original.price);
  const volume = required(form.volume, original.volume);
  if (price !== undefined) patch.price = price;
  if (volume !== undefined) patch.volume = volume;

  const levels = protectivePatch(
    { stopLoss: form.stopLoss, takeProfit: form.takeProfit },
    { stopLoss: original.stopLoss, takeProfit: original.takeProfit },
  );
  if (levels !== null) Object.assign(patch, levels);

  // The endpoint refuses an empty patch, and sending one surfaces as a
  // validation error for a button pressed having changed nothing.
  return Object.keys(patch).length === 0 ? null : patch;
}
