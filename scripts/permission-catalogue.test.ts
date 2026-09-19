import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, Permission, ROLE_PERMISSIONS } from '@tp/shared-types';
import { UserRole } from '@tp/shared-types';

/**
 * `docs/permissions.md` against the constant it claims to describe.
 *
 * The document calls its table "the catalogue" and promises that a fresh
 * deployment "behaves exactly as the catalogue below says". It listed **24 of
 * 63**. Twenty-two capabilities appeared nowhere in the document at all —
 * `security.break_glass`, `wallet.transfer`, `wallet.manage`,
 * `withdrawals.request`, `webhooks.manage`, `kyc.documents.read` and the venue
 * connections among them.
 *
 * That is worse than an out-of-date list, because the document's job is to be
 * read by whoever designs a role. Its own argument is about separations —
 * "No role may credit an account and trade the credit", "money out of nothing,
 * complete" — and a reader following that argument could not see
 * `wallet.adjust` or `withdrawals.review` in the catalogue they were told was
 * complete. Nothing in the repository read this file.
 *
 * Both directions, because each failure is different: a capability missing from
 * the document is one nobody designing a role can weigh, and a capability in
 * the document that no longer exists is a grant somebody will try to make.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(resolve(ROOT, 'docs/permissions.md'), 'utf8');

/**
 * Every capability named in a table's first column, expanding the shorthand the
 * document uses for a family: `` `orders.read` / `.create` `` is two of them.
 *
 * Strict about what counts as a name — `resource.verb`, or `.verb` continuing
 * the row's last resource. A looser pattern picked up the backticked words in
 * a prose cell and reported `and` and `or` as capabilities, which is the kind
 * of result that makes a checker look broken rather than the thing it checks.
 */
const catalogued = (): Set<string> => {
  const found = new Set<string>();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('| `')) continue;
    let prefix = '';
    for (const token of (line.split('|')[1] ?? '').match(/`[a-z_.]+`/g) ?? []) {
      const name = token.replaceAll('`', '');
      if (/^\.[a-z_]+$/.test(name)) {
        if (prefix !== '') found.add(prefix + name);
      } else if (/^[a-z_]+(\.[a-z_]+)+$/.test(name)) {
        prefix = name.split('.').slice(0, -1).join('.');
        found.add(name);
      }
    }
  }
  return found;
};

describe('the permission catalogue', () => {
  it('parses the tables it is checking', () => {
    // A parser that found nothing would report a perfectly documented
    // catalogue, which is how this file would come to mean nothing.
    const listed = catalogued();
    expect(listed.size, 'no capabilities parsed out of docs/permissions.md').toBeGreaterThan(50);
    // And the shorthand really is expanded: this one only exists as `.manage`
    // continuing an `integrity.read` row.
    expect(listed.has('integrity.manage'), 'the row shorthand is not being expanded').toBe(true);
  });

  it('documents every capability the constant defines', () => {
    const listed = catalogued();
    const undocumented = [...ALL_PERMISSIONS].filter((name) => !listed.has(name)).sort();
    expect(undocumented, 'these exist and the catalogue does not mention them').toEqual([]);
  });

  it('names no capability that does not exist', () => {
    const defined = new Set<string>(ALL_PERMISSIONS);
    const invented = [...catalogued()].filter((name) => !defined.has(name)).sort();
    expect(invented, 'the catalogue promises capabilities nothing defines').toEqual([]);
  });

  /**
   * And the claim the document makes hardest, in a heading of its own: *Why
   * ADMIN cannot trade*. It is the separation the rest of the argument rests
   * on, and it is one line of prose naming three capabilities.
   */
  it('keeps the separation its own headings argue for', () => {
    expect(doc).toMatch(/Why ADMIN cannot trade/);
    const admin = ROLE_PERMISSIONS[UserRole.ADMIN];
    for (const capability of [
      Permission.ORDERS_CREATE,
      Permission.POSITIONS_CLOSE,
      Permission.POSITIONS_MODIFY,
    ]) {
      expect(admin, `ADMIN holds ${capability}, and the document says it cannot`).not.toContain(
        capability,
      );
    }
  });
});
