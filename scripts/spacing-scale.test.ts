import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The web app's spacing comes from a short list of steps.
 *
 * Measured on 4 November, before this file existed: no arbitrary value
 * (`p-[13px]`) anywhere, and almost every gap one of six Tailwind steps —
 * 0.5, 1, 1.5, 2, 3 and 4 (2px to 16px) — with a handful of larger ones on
 * the pages that are not the terminal (sign-in, status). That *is* the
 * terminal's spacing scale; it had simply never been written down, so
 * nothing stopped the next panel from inventing a seventh gap.
 *
 * The list below is the scale. A step not on it fails here, and adding one
 * is a decision made in this file, with its reason, rather than a value
 * typed into a component.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SPACING_STEPS: ReadonlySet<string> = new Set([
  '0',
  'px',
  '0.5', // 2px — between a figure and its unit, inside a badge
  '1', // 4px
  '1.5', // 6px — a table cell's vertical padding
  '2', // 8px — the terminal's default gap
  '2.5', // 10px — the ticket's estimate box and form inputs
  '3', // 12px — a panel's padding
  '4', // 16px — between panels on a page
  '5', // 20px — the sign-in card
  '6', // 24px — page sections
  '8', // 32px — below a page header; a popover's offset
  '16', // 64px — the status page's top margin
]);

const PROPERTIES =
  '(?:p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|bottom|left|right)';

/** Every spacing utility in a source, as `property-step`. */
export function spacingUses(source: string): Array<{ use: string; step: string }> {
  const pattern = new RegExp(
    `(?<![\\w-])-?${PROPERTIES}-(\\[[^\\]]+\\]|[0-9.]+|px)(?![\\w.-])`,
    'g',
  );
  return [...source.matchAll(pattern)].map((match) => ({ use: match[0], step: match[1]! }));
}

function webSources(): string[] {
  return ts.sys
    .readDirectory(resolve(ROOT, 'apps/web/src'), ['.ts', '.tsx'])
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path));
}

describe('the spacing scale', () => {
  it('is the only spacing the web app uses', () => {
    const off = webSources().flatMap((file) =>
      spacingUses(readFileSync(file, 'utf8'))
        .filter((found) => !SPACING_STEPS.has(found.step))
        .map((found) => `${file.slice(ROOT.length + 1)}: ${found.use}`),
    );
    expect(off).toEqual([]);
  });

  it('finds a use in every shape it is written, and nothing that only looks like one', () => {
    expect(
      spacingUses(
        'px-2.5 -mt-1 gap-x-3 p-[13px] top-8 space-y-0.5 text-2xl rounded-md grid-cols-2 mx-px',
      ).map((found) => found.use),
    ).toEqual(['px-2.5', '-mt-1', 'gap-x-3', 'p-[13px]', 'top-8', 'space-y-0.5', 'mx-px']);
    expect(
      spacingUses('p-[13px] m-7 py-1.5')
        .filter((found) => !SPACING_STEPS.has(found.step))
        .map((found) => found.use),
    ).toEqual(['p-[13px]', 'm-7']);
  });
});
