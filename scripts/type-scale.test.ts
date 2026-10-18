import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The web app's font sizes come from a named scale.
 *
 * Before the scale existed, 460 uses of `text-[10px]` and `text-[11px]` (and a
 * handful of 9, 12 and 13) were typed inline: a size chosen by whoever wrote
 * the line, with nothing saying that a column header and a hint should match.
 * The sizes below `text-xs` are now `micro`, `label`, `caption` and `body`,
 * defined once in `globals.css`. An arbitrary size is refused here, and every
 * named size the app uses must be one Tailwind or the theme defines — a typo
 * like `text-lable` generates no CSS at all and fails nothing else.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(resolve(ROOT, 'apps/web/src/app/globals.css'), 'utf8');

/** Tailwind's own font-size scale. */
const TAILWIND_SIZES = [
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
];

export function definedSizes(css: string): string[] {
  return [...css.matchAll(/--text-([a-z0-9]+)\s*:/g)].map((match) => match[1]!);
}

export function arbitrarySizes(source: string): string[] {
  return [...source.matchAll(/\btext-\[[^\]]*\d(?:px|rem|em|pt)\]/g)].map((match) => match[0]);
}

/** Single-word `text-*` utilities that are not sizes. */
const NOT_SIZES = new Set([
  'left',
  'right',
  'center',
  'justify',
  'start',
  'end',
  'wrap',
  'nowrap',
  'balance',
  'pretty',
  'clip',
  'ellipsis',
  'inherit',
  'current',
  'transparent',
  'white',
  'black',
]);

/**
 * Every single-word `text-*` that is not an alignment or a colour keyword:
 * the sizes, and anything mistyped as one. (`text-terminal-muted` and
 * `text-red-500` carry a hyphen and are colours.)
 */
export function namedSizes(source: string): string[] {
  return [...source.matchAll(/\btext-([a-z0-9]+)\b(?![-[/])/g)]
    .map((match) => match[1]!)
    .filter((name) => !NOT_SIZES.has(name));
}

function webSources(): string[] {
  return ts.sys
    .readDirectory(resolve(ROOT, 'apps/web/src'), ['.ts', '.tsx'])
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path));
}

describe('the type scale', () => {
  const defined = new Set([...TAILWIND_SIZES, ...definedSizes(CSS)]);

  it('is read from globals.css', () => {
    expect(definedSizes(CSS)).toEqual(
      expect.arrayContaining(['micro', 'label', 'caption', 'body']),
    );
  });

  it('is the only way the web app sets a font size', () => {
    const found = webSources().flatMap((file) =>
      arbitrarySizes(readFileSync(file, 'utf8')).map(
        (use) => `${file.slice(ROOT.length + 1)}: ${use}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('names only sizes that exist', () => {
    const unknown = webSources().flatMap((file) =>
      namedSizes(readFileSync(file, 'utf8'))
        .filter((name) => !defined.has(name))
        .map((name) => `${file.slice(ROOT.length + 1)}: text-${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it('finds a use in every shape it is written', () => {
    expect(arbitrarySizes("'text-[10px]' md:text-[0.7rem] text-[var(--x)]")).toEqual([
      'text-[10px]',
      'text-[0.7rem]',
    ]);
    expect(namedSizes('text-label text-terminal-muted text-right text-2xl text-lable')).toEqual([
      'label',
      '2xl',
      'lable',
    ]);
  });
});
