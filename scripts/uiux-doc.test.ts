import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The terminal's activity tabs, as `docs/uiux.md` names them, against the tabs
 * `terminal.tsx` renders.
 *
 * The page said the tabs were Positions, Pending, Trades, Closed and Orders,
 * and listed Alerts under "what Phase 6 does not deliver" as Phase 8 work —
 * after price alerts had been given their own tab. A reader deciding what to
 * build next was told to build something that was there.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL = 'apps/web/src/components/terminal.tsx';

/** The labels of the activity panel's `<Tabs tabs={[…]}>`, in order, and whether each shows a count. */
const renderedTabs = (): string[] => {
  const source = ts.createSourceFile(
    TERMINAL,
    readFileSync(resolve(ROOT, TERMINAL), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'tabs' &&
      node.initializer !== undefined &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression !== undefined &&
      ts.isArrayLiteralExpression(node.initializer.expression)
    ) {
      found.push(
        node.initializer.expression.elements.flatMap((element) => {
          if (!ts.isObjectLiteralExpression(element)) return [];
          const props = new Map(
            element.properties.flatMap((p) =>
              ts.isPropertyAssignment(p) ? [[p.name.getText(source), p.initializer] as const] : [],
            ),
          );
          const label = props.get('label');
          if (label === undefined || !ts.isStringLiteral(label)) return [];
          return [props.has('count') ? `${label.text} (n)` : label.text];
        }),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // The activity panel is the one whose tabs include positions.
  return found.find((tabs) => tabs.includes('Positions (n)')) ?? [];
};

describe('docs/uiux.md', () => {
  const doc = readFileSync(resolve(ROOT, 'docs/uiux.md'), 'utf8');

  it('names the activity tabs the terminal renders, in order', () => {
    const line = /tabs today are \*\*([^*]+)\*\*/.exec(doc.replace(/\s+/g, ' '))?.[1] ?? '';
    const documented = line.split('·').map((tab) => tab.trim());
    const rendered = renderedTabs();
    expect(rendered.length).toBeGreaterThan(3);
    expect(documented).toEqual(rendered);
  });

  it('does not list a rendered tab among what is not built', () => {
    const start = doc.indexOf('## 5.');
    const next = doc.indexOf('\n## ', start + 1);
    const notBuilt = doc.slice(start, next === -1 ? doc.length : next);
    const bullet = /\*\*([^*]*tabs)\.\*\*/.exec(notBuilt)?.[1] ?? '';
    for (const tab of renderedTabs()) {
      expect(bullet, tab).not.toContain(tab.replace(' (n)', ''));
    }
  });
});
