import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PUBLIC_CHANNELS, WsChannel, WsEvent } from '@tp/shared-types';

/**
 * What each socket channel carries, against the table in `docs/websocket.md`
 * that says what it carries.
 *
 * The table said `orders` carried created / updated / filled / cancelled and
 * `account` carried `account.updated`. The server also sends `order.rejected`
 * on `orders` and `risk.updated` on `account`, and had for as long as those
 * events existed. They are the two a trader most needs to act on — a resting
 * order refused for margin, an account crossing into margin call — and an
 * integrator reading the contract to decide what to subscribe to and handle
 * would have learned of neither.
 *
 * The code side is read from the source, not declared beside it: every call
 * in `apps/api/src` that sends a frame (`send`, `sendToAccount`) names its
 * channel and event as `WsChannel.X` / `WsEvent.Y`, and the one call that does
 * not — the domain-event relay — takes both from `EVENT_ROUTING`, which is read
 * too. A send whose channel or event this reader cannot name is itself a
 * failure, so a new path cannot slip past by computing its event name.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENDERS = new Set(['send', 'sendToAccount']);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

const member = (node: ts.Node | undefined, object: string): string | null =>
  node !== undefined &&
  ts.isPropertyAccessExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === object
    ? node.name.text
    : null;

const channelOf = (node: ts.Node | undefined): string | null => {
  const key = member(node, 'WsChannel');
  return key === null ? null : ((WsChannel as Record<string, string>)[key] ?? null);
};
const eventOf = (node: ts.Node | undefined): string | null => {
  const key = member(node, 'WsEvent');
  return key === null ? null : ((WsEvent as Record<string, string>)[key] ?? null);
};

/** The enclosing function's parameter names: a call that only forwards them adds no route. */
const parametersAround = (node: ts.Node): Set<string> => {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      return new Set(at.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
    }
  }
  return new Set();
};

interface ServerRoutes {
  /** channel → events the server sends on it */
  carried: Map<string, Set<string>>;
  /** sends whose channel or event the reader could not name */
  unread: string[];
  /** how many sends went through `EVENT_ROUTING` */
  relays: number;
}

const serverRoutes = (): ServerRoutes => {
  const carried = new Map<string, Set<string>>();
  const unread: string[] = [];
  let relays = 0;
  const add = (channel: string, event: string): void => {
    const events = carried.get(channel) ?? new Set<string>();
    events.add(event);
    carried.set(channel, events);
  };
  const routing: Array<[string, string]> = [];

  for (const file of sources(resolve(ROOT, 'apps/api/src'))) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const where = (node: ts.Node): string =>
      `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'EVENT_ROUTING' &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
          const fields =
            value !== undefined && ts.isObjectLiteralExpression(value)
              ? new Map(
                  value.properties.flatMap((p) =>
                    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)
                      ? [[p.name.text, p.initializer] as const]
                      : [],
                  ),
                )
              : new Map<string, ts.Expression>();
          const channel = channelOf(fields.get('channel'));
          const event = eventOf(fields.get('wire'));
          if (channel === null || event === null) unread.push(`${where(property)} EVENT_ROUTING`);
          else routing.push([channel, event]);
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        SENDERS.has(node.expression.name.text) &&
        // `sendToAccount` on the gateway from anywhere; `send` only as the
        // gateway's own `this.send` — not `this.email.send` or `res.send`.
        (node.expression.name.text === 'sendToAccount' ||
          node.expression.expression.kind === ts.SyntaxKind.ThisKeyword)
      ) {
        const name = node.expression.name.text;
        // send(socket, event, channel, …) / sendToAccount(accountId, channel, event, …)
        const [eventArg, channelArg] =
          name === 'send'
            ? [node.arguments[1], node.arguments[2]]
            : [node.arguments[2], node.arguments[1]];
        const channel = channelOf(channelArg);
        const event = eventOf(eventArg);
        const params = parametersAround(node);
        const forwards =
          eventArg !== undefined &&
          channelArg !== undefined &&
          ts.isIdentifier(eventArg) &&
          ts.isIdentifier(channelArg) &&
          params.has(eventArg.text) &&
          params.has(channelArg.text);
        const relayed =
          eventArg !== undefined &&
          channelArg !== undefined &&
          eventArg.getText(source) === 'route.wire' &&
          channelArg.getText(source) === 'route.channel';
        if (channel !== null && event !== null) add(channel, event);
        else if (relayed) relays += 1;
        else if (!forwards) unread.push(`${where(node)} ${node.getText(source).slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  if (relays > 0) for (const [channel, event] of routing) add(channel, event);
  return { carried, unread, relays };
};

/** The *Channels* table: channel → visibility and the events it names. */
const documentedRoutes = (
  doc: string,
): Map<string, { visibility: string; events: Set<string> }> => {
  const section = doc.slice(doc.indexOf('## Channels'));
  const rows = section
    .slice(0, section.indexOf('\n\n', section.indexOf('| Channel')))
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  return new Map(
    rows.map((row) => {
      const [, channel = '', visibility = '', carries = ''] = row.split('|').map((c) => c.trim());
      // Events are the backticked names before the first dash; what follows is prose.
      const names = carries.split(' — ')[0] ?? '';
      return [
        channel.replaceAll('`', ''),
        {
          visibility,
          events: new Set([...names.matchAll(/`([a-z]+\.[a-z_]+)`/g)].map((m) => m[1]!)),
        },
      ];
    }),
  );
};

const routes = serverRoutes();
const documented = documentedRoutes(readFileSync(resolve(ROOT, 'docs/websocket.md'), 'utf8'));
const sorted = (map: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...map].map(([k, v]) => [k, [...v].sort()]).sort());

describe('the socket channels', () => {
  it('reads every send (the probe that cannot fail is the one that never looked)', () => {
    expect(routes.unread).toEqual([]);
    expect(routes.relays).toBe(1);
    // Public market data, the valuation, the transition, and the relay's routes.
    expect(routes.carried.get(WsChannel.QUOTES)).toContain(WsEvent.QUOTES_UPDATED);
    expect(routes.carried.get(WsChannel.ACCOUNT)).toContain(WsEvent.RISK_UPDATED);
    expect(routes.carried.get(WsChannel.ORDERS)).toContain(WsEvent.ORDER_REJECTED);
  });

  it('carry exactly what docs/websocket.md says they carry', () => {
    expect(sorted(new Map([...documented].map(([channel, row]) => [channel, row.events])))).toEqual(
      sorted(routes.carried),
    );
  });

  it('are documented public exactly when anyone may subscribe to them', () => {
    const publicInDoc = [...documented]
      .filter(([, row]) => row.visibility === 'public')
      .map(([channel]) => channel);
    expect(publicInDoc.sort()).toEqual([...PUBLIC_CHANNELS].sort());
    expect([...documented.keys()].sort()).toEqual(Object.values(WsChannel).sort());
  });

  it('leave no event in the vocabulary that no channel carries', () => {
    const sent = new Set([...routes.carried.values()].flatMap((events) => [...events]));
    expect(Object.values(WsEvent).filter((event) => !sent.has(event))).toEqual([]);
  });
});

describe('the table reader', () => {
  it('stops at the prose, so a word after the dash is not an event', () => {
    const doc = [
      '## Channels',
      '',
      '| Channel | Visibility | Carries |',
      '| --- | --- | --- |',
      '| `orders` | private | `order.created`, `order.filled` — unlike `order.updated` |',
      '',
      'later `quotes.updated`',
    ].join('\n');
    expect([...(documentedRoutes(doc).get('orders')?.events ?? [])]).toEqual([
      'order.created',
      'order.filled',
    ]);
  });
});
