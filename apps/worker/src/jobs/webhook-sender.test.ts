import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSender, vetAddress, type Resolver } from './webhook-sender';

/**
 * The HTTP half, against a real socket.
 *
 * The receiver here is a local server, so the resolver is overridden and
 * private addresses are allowed — a test-only door, documented on the option.
 * What is pinned: the request that actually goes over the wire, that a 3xx is
 * reported and not followed, that a huge response is cut, that a hung
 * receiver is a timeout and not a hang, and — in `vetAddress` — that a name
 * resolving to anything private is refused before a socket is opened.
 */

describe('vetAddress', () => {
  const resolving =
    (...answers: string[]): Resolver =>
    async () =>
      answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it('pins the first answer when every answer is public', async () => {
    // Real public space, not TEST-NET: the documentation ranges are refused too.
    expect(await vetAddress('hooks.example.com', resolving('93.184.216.34', '8.8.8.8'))).toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  /**
   * DNS rebinding. One private answer among public ones is a name that will be
   * private the moment the resolver's order changes, so the whole name is
   * refused — not just that answer skipped.
   */
  it('refuses a name with any private answer, not just the first', async () => {
    const result = await vetAddress('hooks.evil.example', resolving('93.184.216.34', '127.0.0.1'));
    expect(result).toEqual({ refused: expect.stringContaining('127.0.0.1') });
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'])(
    'refuses a name resolving to %s',
    async (address) => {
      expect(await vetAddress('x.example', resolving(address))).toHaveProperty('refused');
    },
  );

  it('refuses a name that resolves to nothing, or not at all', async () => {
    expect(await vetAddress('x.example', resolving())).toHaveProperty('refused');
    expect(
      await vetAddress('x.example', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toEqual({ refused: expect.stringContaining('ENOTFOUND') });
  });
});

describe('sending over HTTP', () => {
  let server: Server;
  let port: number;
  const seen: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'https://elsewhere.example/' });
          res.end();
        } else if (req.url === '/huge') {
          res.writeHead(200);
          res.end('x'.repeat(10_000));
        } else if (req.url === '/hang') {
          // Never answers.
        } else if (req.url === '/fail') {
          res.writeHead(503);
          res.end('down');
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const local = makeSender({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    unsafeAllowPrivateAddresses: true,
  });

  it('POSTs the exact body with the headers it was given, to the pinned address', async () => {
    const before = seen.length;
    const outcome = await local({
      url: `http://receiver.example:${port}/hook`,
      body: '{"id":"evt_1"}',
      headers: { 'content-type': 'application/json', 'x-signature': 't=1,v1=abc' },
      timeoutMs: 2000,
      allowHttp: true,
    });
    expect(outcome).toMatchObject({ kind: 'response', status: 200, body: 'ok' });
    const request = seen[before];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/hook');
    expect(request?.body).toBe('{"id":"evt_1"}');
    expect(request?.headers['x-signature']).toBe('t=1,v1=abc');
    expect(request?.headers['host']).toBe(`receiver.example:${port}`);
  });

  it('reports a redirect as its status and does not follow it', async () => {
    const before = seen.length;
    const outcome = await local({ ...base(), url: `http://receiver.example:${port}/redirect` });
    expect(outcome).toMatchObject({ kind: 'response', status: 302 });
    expect(seen.length).toBe(before + 1);
  });

  it('reports a failure status as a response, not an error', async () => {
    const outcome = await local({ ...base(), url: `http://receiver.example:${port}/fail` });
    expect(outcome).toMatchObject({ kind: 'response', status: 503, body: 'down' });
  });

  it('keeps only the first kilobyte of a huge response', async () => {
    const outcome = await local({ ...base(), url: `http://receiver.example:${port}/huge` });
    expect(outcome.kind).toBe('response');
    if (outcome.kind === 'response') expect(outcome.body.length).toBe(1024);
  });

  it('gives up on a receiver that never answers', async () => {
    const outcome = await local({
      ...base(),
      url: `http://receiver.example:${port}/hang`,
      timeoutMs: 300,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.reason).toMatch(/300 ms/);
  });

  it('refuses plain http unless told otherwise, before resolving anything', async () => {
    const outcome = await local({
      ...base(),
      url: `http://receiver.example:${port}/hook`,
      allowHttp: false,
    });
    expect(outcome).toMatchObject({ kind: 'refused' });
  });

  it('refuses, without a socket, a name that resolves privately when not in the test door', async () => {
    const strict = makeSender({ resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
    const outcome = await strict({ ...base(), url: `http://receiver.example:${port}/hook` });
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('127.0.0.1'),
    });
  });

  function base() {
    return {
      url: '',
      body: '{"id":"evt_1"}',
      headers: { 'content-type': 'application/json' },
      timeoutMs: 2000,
      allowHttp: true,
    };
  }
});
