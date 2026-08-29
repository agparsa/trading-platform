/**
 * Short human references for UUID identifiers.
 *
 * Positions, orders and trades are identified publicly by UUID — §23 of the
 * platform brief forbids exposing sequential database ids, and that is the right
 * call. But a trader on the phone to support cannot read out
 * `a3f1c9e2-4b7d-4f0a-9c31-5e8b2d7a1f60`, and a table column that wide is a
 * column of noise.
 *
 * So the terminal shows a prefix. The one thing a prefix must never do is name
 * two different things the same way: if two open positions both display `A3F1C9E2`
 * then every instruction given about "A3F1C9E2" is ambiguous, and the trader has
 * no way to know it. `shortRefs` therefore lengthens the prefix — for every id in
 * the set, not just the colliding pair, so the column stays one width — until it
 * is unique across the set it was given.
 *
 * These are display labels. Nothing is ever looked up by one: every request
 * carries the full identifier.
 */

/** Characters shown when nothing collides. Eight hex digits, uppercased. */
const BASE_LENGTH = 8;

const STEP = 4;

/**
 * A stable, unique short label for each id in `ids`.
 *
 * The returned map is keyed by the full id. Ids are compared after the same
 * normalisation that is displayed (dashes stripped, uppercased), so two ids that
 * would *look* identical are treated as a collision even if they differ in
 * punctuation.
 */
export function shortRefs(ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  const normalised = new Map(unique.map((id) => [id, normalise(id)]));

  let length = BASE_LENGTH;
  const longest = Math.max(0, ...unique.map((id) => (normalised.get(id) ?? '').length));

  while (length < longest) {
    const seen = new Set<string>();
    let collided = false;
    for (const id of unique) {
      const candidate = (normalised.get(id) ?? '').slice(0, length);
      if (seen.has(candidate)) {
        collided = true;
        break;
      }
      seen.add(candidate);
    }
    if (!collided) break;
    length += STEP;
  }

  return new Map(unique.map((id) => [id, (normalised.get(id) ?? '').slice(0, length) || id]));
}

/** One id on its own. Used where there is no set to be unique within. */
export function shortRef(id: string): string {
  return normalise(id).slice(0, BASE_LENGTH) || id;
}

function normalise(id: string): string {
  return id.replace(/-/g, '').toUpperCase();
}
