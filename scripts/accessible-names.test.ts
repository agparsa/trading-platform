import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `<select>` in the web app has an accessible name, checked statically.
 *
 * ## Why this exists beside the axe audit
 *
 * `pnpm smoke:web` runs axe over thirty-three views, and axe is the better
 * instrument: it judges the rendered page, so it sees a name that arrives from
 * the API and a label that is visually present but programmatically detached.
 * It has one weakness, and it is structural rather than a bug — it can only
 * judge what is on screen when it runs. A control behind a tab, a dialog or a
 * disclosure that nobody opened is not audited, and nothing in the run says so.
 *
 * That is not hypothetical. Five panels in this app are tabs sharing a URL with
 * a page that was already audited, and all five were invisible to the audit for
 * as long as it existed. One of them held a `<select>` with no name at all.
 *
 * So this is the cheap net underneath: it reads source, not pixels, and
 * therefore sees every control whether or not a test happens to open it. It
 * cannot replace the audit — it knows nothing about contrast, focus order, or
 * whether a name makes sense — and it deliberately checks one rule only.
 *
 * ## What counts as named
 *
 * `aria-label`, `aria-labelledby`, or an `id` a `<label for>` could point at,
 * on the element itself; or an enclosing `<label>` — written directly or via
 * the `Field` helper in `components/primitives.tsx`, which renders one.
 *
 * ## The parsing trap this file was written around
 *
 * The first version of this survey found the end of a tag by scanning to the
 * first `>`. JSX supplies `>` inside attribute values —
 * `onChange={(event) => ...}` is the common case — so the scan stopped early
 * and reported an element as unnamed when its `aria-label` sat a line below.
 * It claimed 24 offenders where there were six, and named as unnamed an element
 * carrying `aria-label="Severity"`. Acting on a number like that means
 * twenty-four edits for one bug, and the diff looks like diligence.
 *
 * `tagEnd` below therefore tracks brace depth and quoting, and
 * `finds the tag end past a JSX arrow function` pins the case that fooled it.
 */

const WEB_SRC = join(import.meta.dirname, '..', 'apps', 'web', 'src');

/**
 * The index of the `>` that closes the tag opening at `start`, skipping
 * anything inside `{...}`, `'...'`, `"..."` or a template literal. Returns -1
 * if the file ends first, which means the source does not parse and the caller
 * should say so rather than guess.
 */
export function tagEnd(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
    } else if (c === '>' && depth === 0 && i > start) {
      return i;
    }
    i += 1;
  }
  return -1;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/**
 * Whether the element opening at `line` sits inside a `<label>` or a `<Field>`.
 * Deliberately shallow — it walks back at most a dozen lines and stops at a
 * closing tag — because a wrapper further away than that is one a reader would
 * not see either, and a name that needs archaeology to find is not a name.
 */
function wrappedInLabel(lines: string[], line: number): boolean {
  for (let i = line - 1; i >= 0 && i > line - 14; i -= 1) {
    const text = lines[i] ?? '';
    if (text.includes('</label>') || text.includes('</Field>')) return false;
    if (text.includes('<label') || text.includes('<Field')) return true;
  }
  return false;
}

type Unnamed = { file: string; line: number };

function unnamedSelects(): { total: number; unnamed: Unnamed[] } {
  const unnamed: Unnamed[] = [];
  let total = 0;
  for (const file of tsxFiles(WEB_SRC)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (const match of src.matchAll(/<select[\s>]/g)) {
      total += 1;
      const at = match.index;
      const line = src.slice(0, at).split('\n').length;
      const end = tagEnd(src, at);
      if (end < 0) {
        unnamed.push({ file: relative(WEB_SRC, file), line });
        continue;
      }
      const tag = src.slice(at, end + 1);
      const named =
        tag.includes('aria-label') || tag.includes('aria-labelledby') || /\sid=/.test(tag);
      if (!named && !wrappedInLabel(lines, line)) {
        unnamed.push({ file: relative(WEB_SRC, file), line });
      }
    }
  }
  return { total, unnamed };
}

describe('accessible names', () => {
  it('finds the tag end past a JSX arrow function', () => {
    const src = `<select\n  onChange={(event) => setKind(event.target.value)}\n  aria-label="Severity"\n>`;
    const end = tagEnd(src, 0);
    expect(end).toBeGreaterThan(0);
    expect(src.slice(0, end + 1)).toContain('aria-label');
  });

  it('still calls an element with no name unnamed', () => {
    const src = `<select onChange={(event) => set(event.target.value)}>`;
    const tag = src.slice(0, tagEnd(src, 0) + 1);
    expect(tag.includes('aria-label')).toBe(false);
  });

  it('reads every select in the web app', () => {
    // If this drops to zero the survey has stopped surveying, which would make
    // the check below pass for the wrong reason.
    expect(unnamedSelects().total).toBeGreaterThan(20);
  });

  it('gives every select an accessible name', () => {
    const { unnamed } = unnamedSelects();
    expect(unnamed.map((one) => `${one.file}:${one.line}`)).toEqual([]);
  });
});
