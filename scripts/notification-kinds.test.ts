import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATEGORY_FOR_KIND, NotificationCategory } from '@tp/shared-types';

/**
 * What the platform tells people, against the document that says what it tells
 * people.
 *
 * `docs/notifications.md` has a table headed *What raises one today*. It listed
 * nine kinds. The platform raises eighteen: identity documents accepted or
 * refused, a verification revoked, a withdrawal rejected, paid or failed, a
 * price alert, and an API key minted or revoked on somebody's account.
 *
 * The heading is what made this hard to see. *Today* reads as a deliberate
 * boundary — these and no others yet — rather than as a list somebody stopped
 * maintaining. A person is told their withdrawal was not approved and the
 * document describing the platform's notifications did not mention it.
 *
 * Three properties, because each protects a different thing:
 *
 *  1. Every kind the code raises is in the table. A notice nobody documented is
 *     one support cannot explain when a trader asks why they got it.
 *  2. Every kind in the table is one the code raises. A row for a notice that
 *     no longer exists is worse than none: somebody waits for it.
 *  3. The category in the table is the category `CATEGORY_FOR_KIND` assigns.
 *     That map decides which per-category preference silences a notice, so a
 *     document that files a withdrawal refusal under the wrong one is telling a
 *     trader they can mute something they cannot.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(resolve(ROOT, 'docs/notifications.md'), 'utf8');

/** Every `*.ts` under an application's source, tests excluded. */
const sources = (app: string): string[] => {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.push(path);
    }
  };
  walk(resolve(ROOT, app, 'src'));
  return found;
};

/**
 * The kinds passed to `raise(...)`, including the ones chosen by a conditional.
 *
 * `kind:` is followed by a literal at most sites and by a ternary at three —
 * verification outcome, close reason, risk state — so every quoted
 * `resource.verb` inside the expression counts. Taking only the first literal
 * would have missed `kyc.rejected` and `position.take_profit`, which is exactly
 * the half a reader would want documented.
 */
const raisedKinds = (): Set<string> => {
  const kinds = new Set<string>();
  for (const file of [...sources('apps/api'), ...sources('apps/worker')]) {
    const source = readFileSync(file, 'utf8');
    for (const start of source.matchAll(/\braise\(\{/g)) {
      /**
       * Brace-depth, not a regex for the whole block.
       *
       * The first version required the block to *end* at `})` within 800
       * characters. The risk-alert block — the one raising a margin call and a
       * stop-out — is longer than that and carries a doc comment of its own, so
       * the pattern never completed and that file contributed nothing. Not an
       * error, a silent zero: it reported those two kinds as undocumented
       * *notices the table promises and nothing sends*, which points a reader
       * at the document when the fault is in the reader.
       *
       * Worth being precise about what fixed it, because a mutation showed the
       * obvious repair was not the one that mattered: simply widening to a
       * fixed window passes too, since `kind:` sits two lines below `raise({`.
       * The depth scan is kept because it is right by construction rather than
       * by where a field happens to sit, and a block that grows past any window
       * is the same silent zero again.
       */
      let depth = 0;
      let end = start.index;
      for (let i = start.index; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{' || ch === '(') depth += 1;
        else if (ch === '}' || ch === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const block = source.slice(start.index, end);
      const field = /kind:([\s\S]*?),\n/.exec(block);
      for (const literal of (field?.[1] ?? '').matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
        kinds.add(literal[1]!);
      }
    }
    // The trading subscriber builds its notice first and raises `notice.kind`,
    // so its literals live in the object it returns rather than in the call.
    if (file.endsWith('trading-notifications.service.ts')) {
      for (const literal of source.matchAll(/kind:\s*\n?\s*'([a-z_]+\.[a-z_]+)'/g)) {
        kinds.add(literal[1]!);
      }
      for (const literal of source.matchAll(/\?\s*'((?:position|order)\.[a-z_]+)'/g)) {
        kinds.add(literal[1]!);
      }
      for (const literal of source.matchAll(/:\s*'((?:position|order)\.[a-z_]+)';/g)) {
        kinds.add(literal[1]!);
      }
    }
  }
  return kinds;
};

/** The table's rows: kind, and the category the document files it under. */
const documented = (): Map<string, string> => {
  const rows = new Map<string, string>();
  for (const line of doc.split('\n')) {
    const match = /^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|[^|]*\|\s*`([A-Z_]+)`\s*\|/.exec(line);
    if (match !== null) rows.set(match[1]!, match[2]!);
  }
  return rows;
};

describe('the notifications this platform raises', () => {
  it('reads both the code and the table it compares', () => {
    // Either parser returning nothing would make the checks below vacuous, and
    // the document would look complete because nothing was compared.
    expect(raisedKinds().size, 'no raise() sites parsed').toBeGreaterThan(12);
    expect(documented().size, 'no rows parsed out of the table').toBeGreaterThan(12);
    // And the conditional sites really are read: this one exists only as the
    // false branch of a ternary.
    expect(raisedKinds().has('kyc.rejected'), 'conditional kinds are not being read').toBe(true);
  });

  it('documents every kind it raises', () => {
    const rows = documented();
    const undocumented = [...raisedKinds()].filter((kind) => !rows.has(kind)).sort();
    expect(undocumented, 'these are sent to people and appear in no table').toEqual([]);
  });

  it('raises every kind it documents', () => {
    const raised = raisedKinds();
    const stale = [...documented().keys()].filter((kind) => !raised.has(kind)).sort();
    expect(stale, 'the table promises notices nothing sends').toEqual([]);
  });

  it('files each one under the category the code assigns it', () => {
    const wrong: string[] = [];
    for (const [kind, category] of documented()) {
      const actual = CATEGORY_FOR_KIND[kind];
      // A kind absent from the map is not an error here — `categoryForKind`
      // falls back to SYSTEM deliberately, so that a notice added to the
      // backend and not to the map still reaches somebody.
      const expected = actual ?? NotificationCategory.SYSTEM;
      if (category !== expected) wrong.push(`${kind}: documented ${category}, code says ${expected}`);
    }
    expect(wrong, 'the document and the map disagree about what silences these').toEqual([]);
  });
});
