/**
 * What each client sends, checked against what the API accepts.
 *
 * `response-contracts.ts` holds the answers to the clients' types. This is
 * the other direction. Every request schema in the API is a Zod object, most
 * of them `.strict()`: a field the schema does not name is refused with a 400,
 * a required field missing is refused with a 400, and nothing about either is
 * visible to the client's compiler — the body is typed by the client, for the
 * client. The phone's positions tab was refused on every open for want of one
 * query key; a body with one extra field is refused the same way.
 *
 * So the TypeScript compiler reads each client's own view of what it sends —
 * the type of the body argument at every `api.post|put|patch(…)`, and the
 * query keys of every call — and they are compared with the schemas the API
 * builds its OpenAPI document from at boot (`GET /developer/openapi.json`):
 *
 * - a field sent that a strict schema does not name;
 * - a field the schema requires that the client may omit;
 * - a field whose kind — string, number, boolean, null, list, object — the
 *   schema does not allow;
 * - the same, one level down, for objects and lists of objects;
 * - a query key the route requires that the call does not send, and one it
 *   sends that the route does not declare.
 *
 * A body the compiler cannot enumerate (`Record<string, unknown>`) is not
 * guessed at: it is reported, and allowed only where `smoke-contracts.ts`
 * says why.
 */
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  CLIENT_APPS,
  COMPUTED_PATHS,
  RECEIVERS,
  ROOT,
  type ClientCall,
  clientCalls,
} from './response-contracts';

export type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

/** One property of a body, as the client's compiler sees it. */
export interface SentField {
  readonly name: string;
  readonly optional: boolean;
  /** The kinds of value it can hold; `null` for `unknown`/`any`, which is not judged. */
  readonly kinds: ReadonlySet<Kind> | null;
  /** For an object, or a list of objects: its own fields, per alternative. */
  readonly nested: readonly SentShape[] | null;
}

/**
 * One alternative of a body — a union like `{} | { volume }` is two — or
 * `null` when the compiler cannot list its fields (an index signature).
 */
export type SentShape = readonly SentField[] | null;

export interface SentBody {
  readonly call: ClientCall;
  /** The type as the compiler prints it, for the report. */
  readonly typeText: string;
  readonly shapes: readonly SentShape[];
}

const MUTATING = new Set(['post', 'put', 'patch']);
const DEPTH = 3;

function kindsOf(type: ts.Type, checker: ts.TypeChecker): Set<Kind> | null {
  const kinds = new Set<Kind>();
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    const flags = part.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue;
    if (flags & ts.TypeFlags.StringLike) kinds.add('string');
    else if (flags & ts.TypeFlags.NumberLike) kinds.add('number');
    else if (flags & ts.TypeFlags.BooleanLike) kinds.add('boolean');
    else if (flags & ts.TypeFlags.Null) kinds.add('null');
    else if (checker.isArrayType(part) || checker.isTupleType(part)) kinds.add('array');
    else if (flags & ts.TypeFlags.Object) kinds.add('object');
    else return null;
  }
  return kinds;
}

function shapesOf(type: ts.Type, checker: ts.TypeChecker, depth: number): SentShape[] {
  const alternatives = type.isUnion()
    ? type.types.filter((part) => !(part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)))
    : [type];
  return alternatives.map((alternative) => {
    if (
      checker.getIndexInfosOfType(alternative).length > 0 ||
      alternative.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    ) {
      return null;
    }
    return checker.getPropertiesOfType(alternative).map((symbol): SentField => {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      const fieldType =
        declaration === undefined
          ? checker.getTypeOfSymbol(symbol)
          : checker.getTypeOfSymbolAtLocation(symbol, declaration);
      const optional =
        (symbol.flags & ts.SymbolFlags.Optional) !== 0 ||
        (fieldType.isUnion() && fieldType.types.some((t) => t.flags & ts.TypeFlags.Undefined));
      const kinds = kindsOf(fieldType, checker);
      let nested: SentShape[] | null = null;
      if (depth > 0 && kinds !== null) {
        const inner = fieldType.isUnion()
          ? fieldType.types.find((t) => t.flags & ts.TypeFlags.Object)
          : fieldType;
        if (inner !== undefined && checker.isArrayType(inner)) {
          const element = checker.getTypeArguments(inner as ts.TypeReference)[0];
          if (element !== undefined && element.flags & ts.TypeFlags.Object) {
            nested = shapesOf(element, checker, depth - 1);
          }
        } else if (inner !== undefined && kinds.has('object')) {
          nested = shapesOf(inner, checker, depth - 1);
        }
      }
      return { name: symbol.name, optional, kinds, nested };
    });
  });
}

let cached: SentBody[] | undefined;

/** Every body a client sends, with the fields its compiler says it has. */
export function sentBodies(): SentBody[] {
  if (cached !== undefined) return cached;
  const byPlace = new Map<string, ClientCall[]>();
  for (const call of clientCalls().calls) {
    const place = `${call.file}:${call.line}`;
    byPlace.set(place, [...(byPlace.get(place) ?? []), call]);
  }
  const bodies: SentBody[] = [];
  for (const app of CLIENT_APPS) {
    const config = ts.getParsedCommandLineOfConfigFile(
      join(ROOT, app.tsconfig),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    if (config === undefined) throw new Error(`cannot read ${app.tsconfig}`);
    const program = ts.createProgram({
      rootNames: config.fileNames,
      options: { ...config.options, incremental: false, noEmit: true },
    });
    const checker = program.getTypeChecker();
    const root = join(ROOT, app.sources);
    for (const source of program.getSourceFiles()) {
      if (!source.fileName.startsWith(root) || /\.(test|spec)\.tsx?$/.test(source.fileName)) {
        continue;
      }
      const file = relative(ROOT, source.fileName);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          RECEIVERS.has(node.expression.expression.text) &&
          MUTATING.has(node.expression.name.text) &&
          node.arguments[1] !== undefined
        ) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const type = checker.getTypeAtLocation(node.arguments[1]);
          const shapes = shapesOf(type, checker, DEPTH);
          for (const call of byPlace.get(`${file}:${line}`) ?? []) {
            bodies.push({ call, typeText: checker.typeToString(type), shapes });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  cached = bodies;
  return bodies;
}

// ─── The API's side ─────────────────────────────────────────────────────────

/** The part of a JSON Schema this reads. */
export interface Schema {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  properties?: Record<string, Schema & { 'x-nestjs_zod-parent-additional-properties'?: boolean }>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  $ref?: string;
  nullable?: boolean;
}

export interface OpenApiDocument {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { schema?: Schema }> };
        parameters?: Array<{ name: string; in: string; required?: boolean }>;
      }
    >
  >;
  components?: { schemas?: Record<string, Schema> };
}

function resolve(schema: Schema | undefined, document: OpenApiDocument): Schema | undefined {
  let current = schema;
  for (let hops = 0; current?.$ref !== undefined && hops < 10; hops += 1) {
    current = document.components?.schemas?.[current.$ref.split('/').pop() ?? ''];
  }
  return current;
}

/** The kinds a schema allows, or `null` when it says nothing (`z.unknown()`). */
function allowedKinds(schema: Schema | undefined, document: OpenApiDocument): Set<Kind> | null {
  const resolved = resolve(schema, document);
  if (resolved === undefined) return null;
  const alternatives = resolved.anyOf ?? resolved.oneOf;
  if (alternatives !== undefined) {
    const kinds = new Set<Kind>();
    for (const alternative of alternatives) {
      const inner = allowedKinds(alternative, document);
      if (inner === null) return null;
      for (const kind of inner) kinds.add(kind);
    }
    return kinds;
  }
  const kinds = new Set<Kind>();
  const types = resolved.type === undefined ? [] : [resolved.type].flat();
  if (types.length === 0) {
    if (resolved.enum !== undefined) {
      for (const value of resolved.enum) {
        kinds.add(value === null ? 'null' : (typeof value as Kind));
      }
      return kinds;
    }
    if (resolved.properties !== undefined) return new Set(['object']);
    return null;
  }
  for (const type of types) {
    if (type === 'integer' || type === 'number') kinds.add('number');
    else if (type === 'string' || type === 'boolean' || type === 'null') kinds.add(type);
    else if (type === 'array') kinds.add('array');
    else if (type === 'object') kinds.add('object');
  }
  if (resolved.nullable === true) kinds.add('null');
  return kinds;
}

/** The object schema inside a field's schema: itself, its list's items, or an `anyOf` member. */
function objectSchemaOf(schema: Schema | undefined, document: OpenApiDocument): Schema | null {
  const resolved = resolve(schema, document);
  if (resolved === undefined) return null;
  if (resolved.properties !== undefined) return resolved;
  if (resolved.items !== undefined) return objectSchemaOf(resolved.items, document);
  for (const alternative of resolved.anyOf ?? resolved.oneOf ?? []) {
    const found = objectSchemaOf(alternative, document);
    if (found !== null) return found;
  }
  return null;
}

/** `.strict()`: said by `additionalProperties: false`, or by nestjs-zod on each property. */
function isStrict(schema: Schema): boolean {
  if (schema.additionalProperties === false) return true;
  return Object.values(schema.properties ?? {}).some(
    (property) => property['x-nestjs_zod-parent-additional-properties'] === false,
  );
}

function compareShape(
  shape: SentShape,
  schema: Schema,
  document: OpenApiDocument,
  at: string,
): string[] {
  if (shape === null) return [];
  const problems: string[] = [];
  const properties = schema.properties ?? {};
  const strict = isStrict(schema);
  for (const field of shape) {
    const target = properties[field.name];
    const name = `${at}${field.name}`;
    if (target === undefined) {
      if (strict) problems.push(`sends \`${name}\`, which the schema does not accept`);
      continue;
    }
    const allowed = allowedKinds(target, document);
    if (field.kinds !== null && allowed !== null) {
      const wrong = [...field.kinds].filter((kind) => !allowed.has(kind));
      if (wrong.length > 0) {
        problems.push(
          `sends \`${name}\` as ${wrong.join(' or ')}; the schema takes ${[...allowed].join(' or ')}`,
        );
      }
    }
    const inner = objectSchemaOf(target, document);
    if (field.nested !== null && inner !== null) {
      for (const nestedShape of field.nested) {
        problems.push(...compareShape(nestedShape, inner, document, `${name}.`));
      }
    }
  }
  const sent = new Map(shape.map((field) => [field.name, field]));
  for (const required of schema.required ?? []) {
    const field = sent.get(required);
    if (field === undefined) problems.push(`omits \`${at}${required}\`, which the schema requires`);
    else if (field.optional) {
      problems.push(`may omit \`${at}${required}\`, which the schema requires`);
    }
  }
  return problems;
}

type Operation = OpenApiDocument['paths'][string][string];

/**
 * `/positions/*` → the document's `/api/v1/positions/{id}` entry. A computed
 * path (`COMPUTED_PATHS`) is every operation it can reach; `undefined` in the
 * list is one the document does not have.
 */
function operationsFor(call: ClientCall, document: OpenApiDocument): Array<Operation | undefined> {
  const wanted = COMPUTED_PATHS[call.key] ?? [call.key];
  return wanted.map((key) => {
    const [verb, path] = key.split(' ') as [string, string];
    for (const [documented, operations] of Object.entries(document.paths)) {
      const normal = documented.replace(/^\/api\/v\d+/, '').replace(/\{[^}]+\}/g, '*');
      if (normal === path.replace(/\/$/, '')) return operations[verb.toLowerCase()];
    }
    return undefined;
  });
}

export interface RequestProblem {
  readonly call: ClientCall;
  readonly message: string;
}

/** Every body and query a client sends, against the schema its route declares. */
export function checkRequests(
  bodies: readonly SentBody[],
  calls: readonly ClientCall[],
  document: OpenApiDocument,
): { problems: RequestProblem[]; opaque: SentBody[] } {
  const problems: RequestProblem[] = [];
  const opaque: SentBody[] = [];

  for (const body of bodies) {
    if (body.shapes.some((shape) => shape === null)) opaque.push(body);
    for (const operation of operationsFor(body.call, document)) {
      if (operation === undefined) {
        problems.push({ call: body.call, message: 'no such operation in the API document' });
        continue;
      }
      const schema = resolve(
        operation.requestBody?.content?.['application/json']?.schema,
        document,
      );
      if (schema === undefined) {
        const sends = body.shapes.flatMap((shape) => shape ?? []).map((field) => field.name);
        if (sends.length > 0) {
          problems.push({
            call: body.call,
            message: `sends ${[...new Set(sends)].map((name) => `\`${name}\``).join(', ')} to a route that reads no body`,
          });
        }
        continue;
      }
      for (const shape of body.shapes) {
        for (const message of compareShape(shape, schema, document, '')) {
          problems.push({ call: body.call, message });
        }
      }
    }
  }

  for (const call of calls) {
    if (call.verb !== 'GET' || call.query === undefined) continue;
    for (const operation of operationsFor(call, document)) {
      if (operation === undefined) continue;
      const declared = (operation.parameters ?? []).filter((parameter) => parameter.in === 'query');
      const names = new Set(declared.map((parameter) => parameter.name));
      for (const parameter of declared) {
        if (parameter.required === true && !(parameter.name in call.query)) {
          problems.push({
            call,
            message: `does not send the query parameter \`${parameter.name}\`, which the route requires`,
          });
        }
      }
      for (const key of Object.keys(call.query)) {
        if (!names.has(key)) {
          problems.push({
            call,
            message: `sends the query parameter \`${key}\`, which the route does not declare`,
          });
        }
      }
    }
  }
  return { problems, opaque };
}
