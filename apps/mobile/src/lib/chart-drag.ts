/**
 * Setting a stop or a target by dragging a line on the chart.
 *
 * The trader touches a position's entry line and drags it: away on the losing
 * side is a stop, on the winning side a target. Or touches an existing stop or
 * target and moves it. Nothing changes on release — the app asks, in a
 * sentence with the price, and only a "Set" sends it. The lines then move when
 * the server's answer arrives, never before; a refusal leaves them where they
 * were, with the server's reason.
 */
export type DragKind = 'STOP_LOSS' | 'TAKE_PROFIT';

export interface DraggedLevel {
  readonly positionId: string;
  readonly kind: DragKind;
  readonly price: string;
}

/**
 * Which level a drag from the entry line sets: below a buy's entry (above a
 * sell's) is where it loses, so a stop; the other side a target. `null` for a
 * drop on the entry itself.
 */
export function kindFromEntry(side: 'BUY' | 'SELL', entry: string, price: string): DragKind | null {
  const order = compare(price, entry);
  if (order === null || order === 0) return null;
  const below = order < 0;
  return (side === 'BUY') === below ? 'STOP_LOSS' : 'TAKE_PROFIT';
}

/** The PATCH body for a dropped level: only the level that moved. */
export function dragPatch(level: DraggedLevel): { stopLoss: string } | { takeProfit: string } {
  return level.kind === 'STOP_LOSS' ? { stopLoss: level.price } : { takeProfit: level.price };
}

/** Exact comparison of two decimal strings; `null` if either is not one. */
function compare(a: string, b: string): number | null {
  const pattern = /^\d+(\.\d+)?$/;
  if (!pattern.test(a) || !pattern.test(b)) return null;
  const [ai = '', af = ''] = a.split('.');
  const [bi = '', bf = ''] = b.split('.');
  const wa = ai.replace(/^0+(?=\d)/, '');
  const wb = bi.replace(/^0+(?=\d)/, '');
  if (wa.length !== wb.length) return wa.length < wb.length ? -1 : 1;
  if (wa !== wb) return wa < wb ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const fa = af.padEnd(width, '0');
  const fb = bf.padEnd(width, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}
