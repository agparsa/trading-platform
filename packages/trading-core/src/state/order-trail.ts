/**
 * An order's event rows, in the order they happened.
 *
 * `seq` is assigned at the insert, so for every row written since it existed
 * it is the order. The rows written before were numbered in the table's
 * physical order when the column was added, and that was not always the order
 * they were inserted in — earlier migrations had rewritten every row, and a
 * rewritten row moves. Production has four trails that read FILLED, CREATED,
 * ACCEPTED by `seq` alone.
 *
 * Those rows are never touched to fix it: the table is append-only, and the
 * database refuses the UPDATE. The order is recovered where it is read.
 * Only rows sharing a `createdAt` can be out of order — rows of one
 * transaction; across transactions the time already orders them — and within
 * such a group the rows form a chain, each starting where the one before it
 * ended. So a group is laid out by following that chain from the one row
 * nothing in the group leads to. A group that is not exactly one chain (a
 * modify's two rows lead to each other; a partial fill can repeat a status)
 * keeps its `seq` order, which for anything written since is the true one.
 */
export interface TrailRow {
  readonly seq: bigint | number;
  readonly createdAt: Date;
  readonly fromStatus: string | null;
  readonly toStatus: string;
}

const bySeq = (a: TrailRow, b: TrailRow): number => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

/** The group as one chain, or `null` when it is not exactly one. */
function chain<T extends TrailRow>(group: readonly T[]): T[] | null {
  const starts = group.filter(
    (row) =>
      row.fromStatus === null ||
      !group.some((other) => other !== row && other.toStatus === row.fromStatus),
  );
  if (starts.length !== 1) return null;
  const walk: T[] = [starts[0]!];
  const left = new Set(group.filter((row) => row !== starts[0]));
  while (left.size > 0) {
    const at = walk[walk.length - 1]!.toStatus;
    const next = [...left].filter((row) => row.fromStatus === at);
    if (next.length !== 1) return null;
    walk.push(next[0]!);
    left.delete(next[0]!);
  }
  return walk;
}

export function orderTrail<T extends TrailRow>(rows: readonly T[]): T[] {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || bySeq(a, b),
  );
  const out: T[] = [];
  for (let i = 0; i < sorted.length;) {
    const time = sorted[i]!.createdAt.getTime();
    let j = i;
    while (j < sorted.length && sorted[j]!.createdAt.getTime() === time) j += 1;
    const group = sorted.slice(i, j);
    out.push(...(group.length > 1 ? (chain(group) ?? group) : group));
    i = j;
  }
  return out;
}
