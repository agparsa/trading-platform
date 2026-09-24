import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every query parameter a handler reads by name is in the published API
 * document, and says truly whether it is required.
 *
 * `@Query('status') status?: string` is optional to the handler and, to
 * Nest's document generator, required — it cannot see the `?`. Twelve such
 * parameters were published as required on 24 September, among them the
 * filters of the payments, KYC and withdrawal queues; and
 * `@Query('currency') currency = 'USD'` was not published at all, because a
 * default value hides the parameter from the generator's reflection. The
 * document is what a developer integrating against the platform reads (§49),
 * and what `pnpm smoke:contracts` compares every client's queries with — a
 * document that is wrong about a parameter fails both. So each one carries an
 * `@ApiQuery` that says what the signature means, and this test holds the two
 * together.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function controllers(): string[] {
  return ts.sys
    .readDirectory(join(ROOT, 'apps/api/src'), ['.ts'])
    .filter((file) => file.endsWith('.controller.ts'));
}

interface Read {
  file: string;
  method: string;
  name: string;
  optional: boolean;
  documented: boolean | null;
}

function reads(): Read[] {
  const found: Read[] = [];
  for (const file of controllers()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) {
        const decorators = ts.getDecorators(node) ?? [];
        const documented = new Map<string, boolean>();
        for (const decorator of decorators) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'ApiQuery')
            continue;
          const options = call.arguments[0];
          if (options === undefined || !ts.isObjectLiteralExpression(options)) continue;
          let name: string | null = null;
          let required = true;
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = property.name.getText(source);
            if (key === 'name' && ts.isStringLiteral(property.initializer))
              name = property.initializer.text;
            if (key === 'required')
              required = property.initializer.kind === ts.SyntaxKind.TrueKeyword;
          }
          if (name !== null) documented.set(name, required);
        }
        for (const parameter of node.parameters) {
          for (const decorator of ts.getDecorators(parameter) ?? []) {
            const call = decorator.expression;
            if (!ts.isCallExpression(call) || call.expression.getText(source) !== 'Query') continue;
            const argument = call.arguments[0];
            if (argument === undefined || !ts.isStringLiteral(argument)) continue;
            const optional =
              parameter.questionToken !== undefined || parameter.initializer !== undefined;
            found.push({
              file: relative(ROOT, file),
              method: node.name.getText(source),
              name: argument.text,
              optional,
              documented: documented.has(argument.text) ? !documented.get(argument.text)! : null,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('named query parameters are published as the handler reads them', () => {
  const all = reads();

  it('finds them (the probe that cannot fail is the one that never looked)', () => {
    expect(all.length).toBeGreaterThanOrEqual(13);
  });

  it('documents every one', () => {
    expect(
      all.filter((read) => read.documented === null).map((r) => `${r.file} ${r.method} ${r.name}`),
    ).toEqual([]);
  });

  it('documents an optional one as optional, and a required one as required', () => {
    expect(
      all
        .filter((read) => read.documented !== null && read.documented !== read.optional)
        .map((r) => `${r.file} ${r.method} ${r.name}`),
    ).toEqual([]);
  });
});
