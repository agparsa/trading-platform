/**
 * The platform's kill switch, as the API reports it and the console reads it.
 *
 * Defined here rather than in the API because the console read it from a type
 * of its own — `{ halted: boolean }` — which the server has never sent. The
 * overview therefore showed "Open" while trading was halted, labelled its
 * button "Halt new risk" in both states, and pressing it on a halted platform
 * halted it again: there was no way to resume from the console. One definition,
 * imported by both, and `pnpm smoke:contracts` checking the real answer against
 * the console's reading of it.
 */
export const TradingState = {
  ENABLED: 'TRADING_ENABLED',
  DISABLED: 'TRADING_DISABLED',
} as const;
export type TradingState = (typeof TradingState)[keyof typeof TradingState];

export interface KillSwitchState {
  state: TradingState;
  reason: string | null;
  changedAt: string | null;
  changedByUserId: string | null;
}

/** The one question every reader of the switch asks. */
export function isTradingHalted(state: Pick<KillSwitchState, 'state'>): boolean {
  return state.state === TradingState.DISABLED;
}
