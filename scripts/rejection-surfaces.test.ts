import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * "All violations reported" — checked at the surfaces that report them.
 *
 * The risk engine evaluates every rule and returns every violation, and four
 * places say so: `docs/risk.md`, `docs/trading-engine.md`, `docs/testing.md` and
 * the README. `OrdersService` says why — "so a trader fixes all of them in one
 * attempt rather than discovering them one order at a time".
 *
 * The engine did its part. The error it became carried the violations joined
 * into one string that no client read, and the web terminal rendered
 * `error.message`, which is the first violation alone. The guarantee was true
 * up to the wire and false on the screen: a trader over the position limit and
 * short of margin halved the volume, submitted again, and learned about the
 * margin.
 *
 * **What this file proves and what it does not.** The decision — which lines to
 * show — is `rejectionLines`, and it is tested properly in
 * `apps/web/src/lib/order-commands.test.ts`. This is the cheaper half: that the
 * surfaces *use* it, and render the whole list rather than its first element.
 * It reads source, so it cannot tell you what a browser paints.
 *
 * For the web ticket that is now the cheaper of two checks rather than the only
 * one: `apps/web/src/components/order-ticket.test.tsx` renders the component in
 * jsdom, submits, and reads the lines out of its `role="alert"`. This file is
 * kept beside it because it reaches what a jsdom test of one component cannot —
 * the mobile screen, the shape the API sends, and the four documents that make
 * the promise — and because a check that costs a millisecond is worth having
 * next to one that costs a second.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/** Source with comments removed, so prose about a thing is not mistaken for it. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('every client shows every violation', () => {
  it('the web ticket asks for all of them and renders all of them', () => {
    const ticket = code(read('apps/web/src/components/order-ticket.tsx'));

    expect(ticket, 'the ticket does not use rejectionLines').toMatch(/rejectionLines\(/);
    // The whole list. `submitError[0]` renders one line and looks correct.
    expect(ticket, 'the ticket renders one line of the rejection').not.toMatch(
      /submitError\s*\[\s*0\s*\]/,
    );
    expect(ticket, 'the ticket does not map over the rejection lines').toMatch(
      /submitError\.map\(/,
    );
    // And it no longer reaches past the helper for the summary line, which is
    // what it did before and what reintroducing the bug would look like.
    expect(ticket, 'the ticket reads error.message directly again').not.toMatch(
      /error\s*instanceof\s+DomainError/,
    );
  });

  it('the mobile ticket shows the preview’s violations, all of them', () => {
    const screen = code(read('apps/mobile/src/app/trade/[symbol].tsx'));
    expect(screen, 'the mobile ticket does not read preview violations').toMatch(
      /preview\.violations/,
    );
    expect(screen, 'the mobile ticket shows one violation').not.toMatch(
      /preview\.violations\s*\[\s*0\s*\]/,
    );
  });

  it('the API sends a list, because a joined string is not renderable', () => {
    const service = code(read('apps/api/src/trading/orders.service.ts'));
    // This is the shape `POST /orders/preview` has always returned, and the one
    // the clients above can act on.
    expect(service).toMatch(/violations:\s*error\.violations\.map\(\(v\) => v\.message\)/);

    /**
     * And nothing joins them back into a sentence *on the way to the client*.
     * Scoped to the `DomainError` the caller receives, because `rejectTriggered`
     * legitimately joins the same messages into one `reason` string for the
     * order event it stores — a stored event is prose for a human reading
     * history, not a payload a ticket renders. A whole-file negative matched
     * that and reported a defect that was not one.
     */
    const constructions = [...service.matchAll(/throw new DomainError\([\s\S]*?\n {6}\);/g)].map(
      (match) => match[0],
    );
    expect(constructions.length, 'no DomainError constructions parsed').toBeGreaterThan(3);
    const risk = constructions.filter((block) => block.includes('violations'));
    expect(risk.length, 'no DomainError carries the violations any more').toBe(1);
    expect(risk[0], 'the violations are joined back into a sentence').not.toMatch(/\.join\(/);
  });

  it('the documents that promise this still promise it', () => {
    // If the guarantee is ever withdrawn, these tests should be deleted with
    // it — not left passing against a promise nobody makes any more.
    const promises = [
      ['docs/risk.md', /returns all violations/],
      ['docs/trading-engine.md', /all violations returned at once/],
      ['README.md', /all violations reported/],
    ] as const;
    for (const [file, pattern] of promises) {
      expect(read(file), `${file} no longer promises this`).toMatch(pattern);
    }
  });
});
