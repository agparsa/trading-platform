/**
 * What each client believes the API answers, checked by the compiler against
 * what the API does answer.
 *
 * `client-routes.test.ts` proves every path a client asks for exists. It says
 * nothing about the answer. The mobile app was written against interfaces
 * typed from memory — `interface Position { floatingPnl … }` above
 * `api.get<Position[]>('/positions')` — and the type parameter on `api.get` is
 * a cast: TypeScript believes it, the build is green, and a field the server
 * never sends is `undefined` at run time, shown as "—" or not shown at all. On
 * 24 September the phone's positions tab could not load (the request lacked the
 * account the server requires) and its home screen read three figures the
 * account-state response does not carry.
 *
 * So this module reads, with the TypeScript compiler, every call of the form
 * `api.<verb><T>(path, …)` in the web app, the phone and the shared chart
 * package: the path, the query keys the call site sends, and `T` as written.
 * Given a real response for a call, it appends to that source file — in memory,
 * never on disk — a declaration whose *type is the response itself*, every
 * string and number as its literal type, and asks the compiler whether that is
 * assignable to `T`, in the file's own scope, under the app's own tsconfig. A
 * field the client requires and the server omits, a number where the client
 * reads a string, `null` where it reads a value, `'LONG'` where it reads
 * `'BUY' | 'SELL'` — each is a compile error on a line this module owns, and
 * nothing else in the file is reported.
 *
 * Extra fields the server sends are allowed: a client may read less than it is
 * given. What it may not do is read what it is not given.
 *
 * The responses come from `smoke-contracts.ts`, which boots the real API,
 * gives it a trader with positions, trades, orders and a device, and an
 * administrator, and makes each call as its client makes it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A client, and the tsconfig its types are checked under. */
export interface ClientApp {
  readonly name: 'web' | 'mobile' | 'chart-core';
  readonly tsconfig: string;
  readonly sources: string;
}

export const CLIENT_APPS: readonly ClientApp[] = [
  { name: 'web', tsconfig: 'apps/web/tsconfig.json', sources: 'apps/web/src' },
  { name: 'mobile', tsconfig: 'apps/mobile/tsconfig.json', sources: 'apps/mobile/src' },
  {
    name: 'chart-core',
    tsconfig: 'packages/chart-core/tsconfig.json',
    sources: 'packages/chart-core/src',
  },
];

/** A call a client makes, typed or not. */
export interface ClientCall {
  readonly app: ClientApp['name'];
  /** Repository-relative. */
  readonly file: string;
  readonly line: number;
  readonly verb: Verb;
  /** `${…}` in the path is `*`. */
  readonly path: string;
  /** `T` exactly as the call site wrote it; `undefined` for an untyped call. */
  readonly typeText: string | undefined;
  /**
   * The query keys the call sends, each with its value when the call site
   * wrote a literal and `null` when it is computed. `undefined` when the call
   * passes a query object this reader cannot see into.
   */
  readonly query: Readonly<Record<string, string | null>> | undefined;
  /** `GET /positions` — the key the harness and its tables use. */
  readonly key: string;
}

/** A call whose answer the client reads as a named type. */
export interface TypedCall extends ClientCall {
  readonly typeText: string;
}

/** A call whose path this reader cannot see: a variable, a function's result. */
export interface UnreadCall {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * The names an `ApiClient` goes by at a call site: `api` from `useSession()`,
 * and `client_` inside the web's `mutate(api, (client_, input, key) => …)`.
 */
export const RECEIVERS = new Set(['api', 'client_']);

const VERBS: Readonly<Record<string, Verb>> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  /** A file as the request body: `putBytes(path, bytes, options)`. */
  putBytes: 'PUT',
};

function sourceFiles(directory: string): string[] {
  const host = ts.sys;
  return host
    .readDirectory(join(ROOT, directory), ['.ts', '.tsx'], ['**/node_modules/**', '**/dist/**'])
    .filter((file) => !/\.(test|spec)\.tsx?$/.test(file) && !file.endsWith('.d.ts'));
}

type Where = { path: string; inlineQuery: string | undefined };

/**
 * The paths an argument can take: a literal, a template, or either branch of
 * `cond ? '/a' : '/b'` — the admin KYC queue is written that way, and a reader
 * that saw only literals missed it. `'/a/' + x` is not used in the clients.
 */
function pathsOf(node: ts.Expression): Where[] | null {
  if (ts.isParenthesizedExpression(node)) return pathsOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = pathsOf(node.whenTrue);
    const whenFalse = pathsOf(node.whenFalse);
    return whenTrue === null || whenFalse === null ? null : [...whenTrue, ...whenFalse];
  }
  return pathOf(node);
}

/**
 * What one `${…}` can be: both strings of `cond ? 'suspend' : 'reinstate'`,
 * or `*` for anything else — a path parameter.
 */
function substitutions(expression: ts.Expression): string[] {
  let node = expression;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalValue(node.whenTrue);
    const whenFalse = literalValue(node.whenFalse);
    if (whenTrue !== null && whenFalse !== null) return [whenTrue, whenFalse];
  }
  return ['*'];
}

/**
 * The paths a literal or template can be. Each substitution is `*`, as it is
 * for a path parameter — `/admin/${kind}${search}` is `/admin/**`, which the
 * tests' COMPUTED tables expand — except a choice between two literals, which
 * becomes both paths. Those were invisible to the regular expression this
 * replaced: `/admin/users/${id}/${suspend ? 'suspend' : 'reinstate'}` has
 * quotes inside it, and three admin actions were never checked at all.
 */
function pathOf(node: ts.Expression): Where[] | null {
  let texts: string[];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    texts = [node.text];
  } else if (ts.isTemplateExpression(node)) {
    texts = [node.head.text];
    for (const span of node.templateSpans) {
      const options = substitutions(span.expression);
      texts = texts.flatMap((text) =>
        options.map((option) => `${text}${option}${span.literal.text}`),
      );
    }
  } else {
    return null;
  }
  return texts.map((text) => {
    const [path, inlineQuery] = text.split('?', 2) as [string, string | undefined];
    return { path, inlineQuery };
  });
}

function literalValue(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return null;
}

function queryOf(
  options: ts.Expression | undefined,
  inlineQuery: string | undefined,
): Record<string, string | null> | undefined {
  const query: Record<string, string | null> = {};
  if (inlineQuery !== undefined) {
    for (const pair of inlineQuery.split('&')) {
      const [key, value] = pair.split('=', 2);
      if (key !== undefined && key !== '') query[key] = value?.includes('*') ? null : (value ?? '');
    }
  }
  if (options === undefined || !ts.isObjectLiteralExpression(options)) {
    return options === undefined ? query : undefined;
  }
  for (const property of options.properties) {
    if (property.name === undefined || property.name.getText() !== 'query') continue;
    if (!ts.isPropertyAssignment(property)) return undefined;
    const value = property.initializer;
    if (!ts.isObjectLiteralExpression(value)) return undefined;
    for (const entry of value.properties) {
      if (ts.isPropertyAssignment(entry)) {
        query[entry.name.getText().replace(/^['"]|['"]$/g, '')] = literalValue(entry.initializer);
      } else if (ts.isShorthandPropertyAssignment(entry)) {
        query[entry.name.text] = null;
      } else {
        // A spread: keys this reader cannot enumerate.
        return undefined;
      }
    }
  }
  return query;
}

let cached: { calls: ClientCall[]; unread: UnreadCall[] } | undefined;

/** Every `api.<verb>(path, …)` in every client, typed or not, and those it cannot read. */
export function clientCalls(): { calls: ClientCall[]; unread: UnreadCall[] } {
  if (cached !== undefined) return cached;
  const calls: ClientCall[] = [];
  const unread: UnreadCall[] = [];
  for (const app of CLIENT_APPS) {
    for (const file of sourceFiles(app.sources)) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          RECEIVERS.has(node.expression.expression.text) &&
          VERBS[node.expression.name.text] !== undefined &&
          node.arguments[0] !== undefined
        ) {
          const verb = VERBS[node.expression.name.text]!;
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const paths = pathsOf(node.arguments[0]);
          if (paths === null) {
            unread.push({
              file: relative(ROOT, file),
              line,
              text: node.arguments[0].getText(source),
            });
          } else {
            // GET and DELETE take (path, options); the others (path, body, options).
            const options =
              verb === 'GET' || verb === 'DELETE' ? node.arguments[1] : node.arguments[2];
            for (const where of paths) {
              calls.push({
                app: app.name,
                file: relative(ROOT, file),
                line,
                verb,
                path: where.path,
                typeText:
                  node.typeArguments?.length === 1
                    ? node.typeArguments[0]!.getText(source)
                    : undefined,
                query: queryOf(options, where.inlineQuery),
                key: `${verb} ${where.path}`,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  cached = { calls, unread };
  return cached;
}

/** Every `api.<verb><T>(path, …)` in every client. */
export function typedCalls(): TypedCall[] {
  return clientCalls().calls.filter((call): call is TypedCall => call.typeText !== undefined);
}

/**
 * A JSON value as a TypeScript type: every leaf its literal type, arrays as
 * tuples of their first elements. Assigning this to the client's `T` is the
 * check — the compiler does the comparing, unions and optionals included.
 */
export function literalType(value: unknown, depth = 0): string {
  if (depth > 12) return 'unknown';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? String(value) : 'number';
    case 'boolean':
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .slice(0, ARRAY_SAMPLE)
          .map((element) => literalType(element, depth + 1))
          .join(', ')}]`;
      }
      const members = Object.entries(value as Record<string, unknown>).map(
        ([key, member]) => `${JSON.stringify(key)}: ${literalType(member, depth + 1)}`,
      );
      return `{ ${members.join('; ')} }`;
    }
    default:
      return 'undefined';
  }
}

/** Elements of an array compared. Enough to meet each state a row can be in. */
export const ARRAY_SAMPLE = 25;

export interface Sample {
  readonly call: TypedCall;
  /** The response's `data`, as the client's `api` hands it back. */
  readonly data: unknown;
}

export interface Mismatch {
  readonly call: TypedCall;
  /** The answer that was not a `T` — the same object that was passed in. */
  readonly sample: Sample;
  readonly message: string;
}

/** Diagnostics that are about the appended lines existing, not about the answer. */
const NOT_ABOUT_THE_ANSWER = new Set([6133, 6196, 6198]);

/**
 * Asks the compiler whether each response is a `T`.
 *
 * One program per client app, under its own tsconfig, with the checks
 * appended in memory to the files that make the calls. Only diagnostics on
 * appended lines are returned; the rest of the app is `pnpm typecheck`'s job.
 */
export function checkSamples(samples: readonly Sample[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  for (const app of CLIENT_APPS) {
    const mine = samples.filter((sample) => sample.call.app === app.name);
    if (mine.length === 0) continue;

    const configPath = join(ROOT, app.tsconfig);
    const config = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    if (config === undefined) throw new Error(`cannot read ${app.tsconfig}`);
    const options: ts.CompilerOptions = {
      ...config.options,
      incremental: false,
      noEmit: true,
      tsBuildInfoFile: undefined,
    };

    // file → appended text, and appended line → the sample it checks.
    const appended = new Map<string, { original: number; lines: string[]; owners: Sample[] }>();
    mine.forEach((sample, index) => {
      const file = join(ROOT, sample.call.file);
      const entry = appended.get(file) ?? {
        original: readFileSync(file, 'utf8').length,
        lines: [],
        owners: [],
      };
      entry.lines.push(
        `declare const __contractResponse${index}: ${literalType(sample.data)}; ` +
          `const __contractCheck${index}: ${sample.call.typeText} = __contractResponse${index};`,
      );
      entry.owners.push(sample);
      appended.set(file, entry);
    });

    const host = ts.createCompilerHost(options, true);
    const read = host.readFile.bind(host);
    const withChecks = (fileName: string): string | undefined => {
      const text = read(fileName);
      const entry = appended.get(resolve(fileName));
      if (text === undefined || entry === undefined) return text;
      return `${text}\n${entry.lines.join('\n')}\n`;
    };
    host.readFile = withChecks;
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const entry = appended.get(resolve(fileName));
      if (entry === undefined) {
        return getSourceFile(fileName, languageVersion, onError, shouldCreate);
      }
      return ts.createSourceFile(fileName, withChecks(fileName) ?? '', languageVersion, true);
    };

    const program = ts.createProgram({
      rootNames: [...new Set([...config.fileNames, ...appended.keys()])],
      options,
      host,
    });
    for (const [file, entry] of appended) {
      const source = program.getSourceFile(file);
      if (source === undefined)
        throw new Error(`${relative(ROOT, file)} is not in ${app.tsconfig}`);
      // 0-based: the original text, then the newline this module adds.
      const firstLine = source.getLineAndCharacterOfPosition(entry.original + 1).line;
      for (const diagnostic of [
        ...program.getSyntacticDiagnostics(source),
        ...program.getSemanticDiagnostics(source),
      ]) {
        if (diagnostic.start === undefined || diagnostic.start < entry.original) continue;
        if (NOT_ABOUT_THE_ANSWER.has(diagnostic.code)) continue;
        const line = source.getLineAndCharacterOfPosition(diagnostic.start).line;
        const owner = entry.owners[line - firstLine];
        if (owner === undefined) continue;
        mismatches.push({
          call: owner.call,
          sample: owner,
          message: ts
            .flattenDiagnosticMessageText(diagnostic.messageText, '\n')
            .replace(/__contractResponse\d+|__contractCheck\d+/g, 'the response'),
        });
      }
    }
  }
  return mismatches;
}
