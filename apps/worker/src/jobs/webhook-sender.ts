import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPublicAddress } from '@tp/webhooks-core';

/**
 * One HTTP POST to a receiver, with the address it goes to pinned.
 *
 * ## Why the lookup is done here and not left to the socket
 *
 * The URL was checked when the endpoint was registered. That check saw a
 * hostname; a hostname is a promise about an address, and promises change.
 * DNS rebinding is the attack: `hooks.evil.example` resolves to a public
 * address while the form is being filled in and to `127.0.0.1` when the
 * delivery is made. So the name is resolved *here*, every address it resolves
 * to is checked, and the socket is told to connect to exactly the address that
 * passed — not to look the name up again and get a different answer.
 *
 * ## What is deliberately not done
 *
 * Redirects are not followed. A 3xx is a failure like any other, because a
 * webhook that redirects is a webhook pointing somewhere the firm did not
 * register, and following it would let a compromised receiver forward signed
 * events wherever it liked. The response body is read up to a small cap and
 * discarded beyond it; a receiver that answers with a megabyte is not going
 * to be debugged from a log column.
 */

export interface SendRequest {
  readonly url: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly allowHttp: boolean;
}

export type SendOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly body: string;
      readonly durationMs: number;
    }
  | { readonly kind: 'refused'; readonly reason: string; readonly durationMs: number }
  | { readonly kind: 'error'; readonly reason: string; readonly durationMs: number };

export type Sender = (request: SendRequest) => Promise<SendOutcome>;

const RESPONSE_CAP = 1024;

/**
 * Resolves the name and vets every answer. Returns the address to pin, or a
 * reason nothing may be pinned.
 */
export type Resolver = (
  host: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const systemResolver: Resolver = (host) => dnsLookup(host, { all: true });

export async function vetAddress(
  hostname: string,
  resolve: Resolver = systemResolver,
  allowPrivate = false,
): Promise<{ address: string; family: number } | { refused: string }> {
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await resolve(hostname);
  } catch (error) {
    return {
      refused: `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (answers.length === 0) return { refused: `${hostname} resolved to nothing` };
  /**
   * Every answer must be public, not just the one chosen. A name with one
   * public and one private address is a name that will be private the moment
   * the resolver's order changes.
   */
  const bad = allowPrivate ? undefined : answers.find((answer) => !isPublicAddress(answer.address));
  if (bad !== undefined)
    return { refused: `${hostname} resolves to ${bad.address}, which is not a public address` };
  const [first] = answers;
  return first as { address: string; family: number };
}

export interface SenderOptions {
  readonly resolve?: Resolver;
  /**
   * Tests only. Lets a receiver on 127.0.0.1 be reached so the HTTP mechanics
   * — no redirects, the response cap, the timeout — can be exercised against a
   * real socket. Production constructs the sender without it and there is no
   * configuration that turns it on.
   */
  readonly unsafeAllowPrivateAddresses?: boolean;
}

export function makeSender(options: SenderOptions = {}): Sender {
  const resolve = options.resolve ?? systemResolver;
  const allowPrivate = options.unsafeAllowPrivateAddresses === true;
  return async (request) => {
    const started = Date.now();
    const elapsed = () => Date.now() - started;

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { kind: 'refused', reason: 'not a URL', durationMs: elapsed() };
    }
    const secure = url.protocol === 'https:';
    if (!secure && !(request.allowHttp && url.protocol === 'http:')) {
      return { kind: 'refused', reason: `${url.protocol} is not allowed`, durationMs: elapsed() };
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');
    const vetted = await vetAddress(host, resolve, allowPrivate);
    if ('refused' in vetted)
      return { kind: 'refused', reason: vetted.refused, durationMs: elapsed() };

    const lookup: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all === true) {
        (
          callback as unknown as (
            err: null,
            addresses: Array<{ address: string; family: number }>,
          ) => void
        )(null, [{ address: vetted.address, family: vetted.family }]);
        return;
      }
      callback(null, vetted.address, vetted.family);
    };

    return new Promise<SendOutcome>((resolve) => {
      const make = secure ? httpsRequest : httpRequest;
      const req = make(
        url,
        {
          method: 'POST',
          headers: {
            ...request.headers,
            'content-length': String(Buffer.byteLength(request.body)),
          },
          lookup,
          timeout: request.timeoutMs,
          // The certificate is checked against the *name*, not the pinned address.
          ...(secure ? { servername: host } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (size >= RESPONSE_CAP) return;
            const take = chunk.subarray(0, RESPONSE_CAP - size);
            chunks.push(take);
            size += take.length;
          });
          res.on('end', () => {
            resolve({
              kind: 'response',
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              durationMs: elapsed(),
            });
          });
          res.on('error', (error) => {
            resolve({ kind: 'error', reason: error.message, durationMs: elapsed() });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`no response within ${request.timeoutMs} ms`));
      });
      req.on('error', (error) => {
        resolve({ kind: 'error', reason: error.message, durationMs: elapsed() });
      });
      req.end(request.body);
    });
  };
}

export const sendOverHttp: Sender = makeSender();
