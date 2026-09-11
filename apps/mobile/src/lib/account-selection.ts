/**
 * Which account a phone screen is acting on (§16, §53).
 *
 * The terminal fixed this on the web in Phase 6: it used `accounts[0]` and
 * offered no way to change it, so a trader with two accounts could reach only
 * the first. The phone had the same fault and a worse shape of it — the home
 * screen lists *every* account with its own equity, and then the ticket, the
 * orders tab and the history tab all silently acted on whichever one the server
 * happened to return first. A trader could watch the balance of one account and
 * place an order against another.
 *
 * The resolution is deliberately not "remember the id and use it". An id that
 * once worked can stop working — an account is closed, a master's grant is
 * revoked, the list comes back shorter — and a screen that keeps sending the
 * stale one gets a 404 per action with nothing on screen to explain it. So the
 * choice is re-resolved against the list every time the list changes, and it
 * falls back rather than failing.
 */
export interface SelectableAccount {
  readonly id: string;
}

/**
 * The account a screen should act on: the one asked for if it is still there,
 * otherwise the first, otherwise none at all.
 *
 * The `?? null` is the empty-list case, and it is worth naming rather than
 * guarding separately — a mutation that removed an explicit `length === 0`
 * check changed nothing, because this line already answers it. A freshly
 * registered user has an account, so an empty list means something went wrong
 * upstream, and a screen that shows "no account" is telling the truth where one
 * that invented a placeholder id would send a request nobody can service.
 */
export function resolveSelection<T extends SelectableAccount>(
  accounts: readonly T[],
  requestedId: string | null,
): T | null {
  if (requestedId !== null) {
    const requested = accounts.find((account) => account.id === requestedId);
    if (requested !== undefined) return requested;
  }
  return accounts[0] ?? null;
}

/**
 * Whether a picker is worth the space it takes.
 *
 * One account is the common case and a chooser with one choice is furniture. It
 * is also the case where hiding it costs nothing: there is nothing to choose.
 */
export function shouldOfferChoice(accounts: readonly SelectableAccount[]): boolean {
  return accounts.length > 1;
}
