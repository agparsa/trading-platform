import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `docs/README.md` is the way into eighty documents. On 23 September it
 * listed fifty of them: wallets, payments, withdrawals, KYC, webhooks, the
 * security centre, IP rules, secrets, disaster recovery, capacity — thirty
 * documents, most of them written for exactly the reader who starts at an
 * index, were reachable only by already knowing their names. Its one line
 * about the generated route inventory said "all 84 routes"; there are over
 * two hundred.
 *
 * So: every document is indexed, every indexed document exists, and every
 * relative link and anchor in the documentation resolves.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const documents = readdirSync(DOCS).filter((name) => name.endsWith('.md'));

/** The slug a heading gets on GitHub, near enough for this repository's headings. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');

describe('the documentation index', () => {
  const index = readFileSync(join(DOCS, 'README.md'), 'utf8');
  const listed = [...index.matchAll(/\]\(\.\/([^)#]+\.md)\)/g)].map((match) => match[1]!);

  it('indexes every document', () => {
    expect(documents.length).toBeGreaterThan(50);
    expect(documents.filter((name) => name !== 'README.md' && !listed.includes(name))).toEqual([]);
  });

  it('indexes nothing that does not exist', () => {
    expect(listed.filter((name) => !documents.includes(name))).toEqual([]);
  });

  it('states no route count by hand — the inventory is generated', () => {
    expect(index).not.toMatch(/all \d+ routes/);
  });
});

describe('links in the documentation', () => {
  const files = [...documents.map((name) => join(DOCS, name)), join(ROOT, 'README.md')];

  it('every relative link and anchor resolves', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\]\(((?!https?:|mailto:)[^)\s]+)\)/g)) {
        const [target = '', anchor] = match[1]!.split('#');
        const path = target === '' ? file : normalize(join(dirname(file), target));
        checked += 1;
        if (!existsSync(path)) {
          broken.push(`${file.slice(ROOT.length + 1)} → ${match[1]}`);
          continue;
        }
        if (anchor !== undefined && path.endsWith('.md')) {
          const headings = [...readFileSync(path, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
            slug(m[1]!),
          );
          if (!headings.includes(anchor))
            broken.push(`${file.slice(ROOT.length + 1)} → ${match[1]}`);
        }
      }
    }
    expect(checked, 'the scan found links to check').toBeGreaterThan(100);
    expect(broken).toEqual([]);
  });
});
