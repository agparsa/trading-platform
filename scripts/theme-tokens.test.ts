import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every `terminal-*` colour the web app uses is a colour the theme defines.
 *
 * Tailwind does not complain about a class whose colour does not exist — it
 * simply generates nothing, and the element falls back to whatever it
 * inherits. Twenty-six uses had drifted into names nobody defined: a wallet
 * error in `text-terminal-negative` rendered in ordinary text colour, the
 * feature switches' ON and OFF in `-success` / `-danger` looked identical, and
 * an admin "Save" button in `bg-terminal-accent` with dark text was dark text
 * on no background at all. None of it failed a build or a test.
 *
 * So the vocabulary is read from `globals.css` and every use is checked
 * against it.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(resolve(ROOT, 'apps/web/src/app/globals.css'), 'utf8');

export function definedColours(css: string): Set<string> {
  return new Set([...css.matchAll(/--color-terminal-([a-z-]+)\s*:/g)].map((match) => match[1]!));
}

/** `bg-terminal-raised/40` → `raised`, for every utility prefix Tailwind gives a colour. */
export function usedColours(source: string): string[] {
  return [
    ...source.matchAll(
      /\b(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|placeholder|caret|accent|decoration|shadow)-terminal-([a-z]+(?:-[a-z]+)*)/g,
    ),
  ].map((match) => match[1]!);
}

function webSources(): string[] {
  return ts.sys
    .readDirectory(resolve(ROOT, 'apps/web/src'), ['.ts', '.tsx'])
    .filter((path) => !/\.(test|spec)\.tsx?$/.test(path));
}

describe('the terminal theme', () => {
  const defined = definedColours(CSS);

  it('is read from globals.css, so this test is checking something', () => {
    expect([...defined]).toEqual(
      expect.arrayContaining(['bg', 'surface', 'raised', 'text', 'muted', 'long', 'short']),
    );
  });

  it('defines every terminal colour the web app uses', () => {
    const missing: string[] = [];
    for (const file of webSources()) {
      const source = readFileSync(file, 'utf8');
      for (const name of usedColours(source)) {
        if (!defined.has(name)) missing.push(`${file.slice(ROOT.length + 1)}: terminal-${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * A colour defined in the dark theme and not the light one is the light
   * page painted with a dark-theme colour: dark text on a light background
   * reads, but the dark theme's near-black raised row does not.
   */
  it('gives the light theme every colour the dark theme has, and no others', () => {
    const block = /:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(CSS);
    expect(block, 'globals.css has a light theme block').not.toBeNull();
    const light = definedColours(block![1]!);
    const dark = definedColours(
      CSS.slice(CSS.indexOf('@theme'), CSS.indexOf('}', CSS.indexOf('@theme'))),
    );
    expect([...light].sort()).toEqual([...dark].sort());
  });

  it('finds a use in every shape it is written', () => {
    expect(usedColours("'text-terminal-short' bg-terminal-raised/40 border-b-terminal-x")).toEqual([
      'short',
      'raised',
      'x',
    ]);
  });
});
