/**
 * Which addresses a firm allows, and how the answer is reached.
 *
 * Pure: no database, no request, no clock. An IP rule set is the kind of thing
 * that locks people out of their own platform when it is subtly wrong, and the
 * only way to be sure about it is to be able to run every case on a laptop.
 *
 * ## The semantics, stated once
 *
 * - A **DENY** match refuses, and beats everything. An explicit block is an
 *   explicit block.
 * - If any **ALLOW** rule exists for the scope, the address must match one of
 *   them. That is allow-list mode, and it is what a firm means by "only from
 *   the office".
 * - If no ALLOW rule exists, everything not denied is allowed. A rule set of
 *   only denials is a block-list, and a firm that has written one has not asked
 *   for an allow-list by accident.
 *
 * The asymmetry is deliberate: adding the first ALLOW rule changes the mode of
 * the whole set, from "everyone except these" to "nobody except these". That is
 * a large change and the API makes the caller confirm it — see
 * `IpRulesService`.
 */

export const IpRuleKind = { ALLOW: 'ALLOW', DENY: 'DENY' } as const;
export type IpRuleKind = (typeof IpRuleKind)[keyof typeof IpRuleKind];

/**
 * Who a rule applies to.
 *
 * `STAFF` is the useful, low-risk case: "our administrators sign in from the
 * office". `EVERYONE` includes customers, which is a business decision with
 * support consequences — a trader travelling is a trader locked out — so it is
 * never the default and the API says so when one is created.
 */
export const IpRuleScope = { STAFF: 'STAFF', EVERYONE: 'EVERYONE' } as const;
export type IpRuleScope = (typeof IpRuleScope)[keyof typeof IpRuleScope];

export interface IpRule {
  readonly cidr: string;
  readonly kind: IpRuleKind;
  readonly scope: IpRuleScope;
}

export type IpDecision =
  | { readonly allowed: true; readonly reason: 'no-rules' | 'allow-listed' | 'not-denied' }
  | {
      readonly allowed: false;
      readonly reason: 'denied' | 'not-allow-listed';
      readonly cidr?: string;
    };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * An address as a number, with the family it came from.
 *
 * Families are never compared across: `0.0.0.0/0` does not match an IPv6
 * address, however tempting the arithmetic makes it look. A firm that writes
 * an IPv4 allow-list and finds its IPv6 clients silently admitted has an
 * allow-list that does nothing on a modern network.
 */
interface Parsed {
  readonly value: bigint;
  readonly bits: 32 | 128;
}

/**
 * IPv4-mapped IPv6 (`::ffff:203.0.113.4`) is treated as the IPv4 address it is.
 *
 * Node hands these out for IPv4 clients on a dual-stack socket, so without this
 * every rule a firm writes for its office would fail to match its own office.
 */
function unmap(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address.trim());
  return mapped?.[1] ?? address.trim();
}

export function parseAddress(address: string): Parsed | null {
  const text = unmap(address);
  if (text.includes('.') && !text.includes(':')) {
    const parts = text.split('.');
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number(part);
      if (octet > 255) return null;
      value = (value << 8n) | BigInt(octet);
    }
    return { value, bits: 32 };
  }
  if (text.includes(':')) {
    const groups = expandIpv6(text);
    if (groups === null) return null;
    let value = 0n;
    for (const group of groups) value = (value << 16n) | BigInt(group);
    return { value, bits: 128 };
  }
  return null;
}

/** `2001:db8::1` to its eight groups, or null if it is not an address. */
function expandIpv6(text: string): number[] | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = toGroups(halves[1] ?? '');
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  /**
   * `::` must stand for at least one group. `1:2:3:4:5:6:7::8` has eight groups
   * already and a `::` that expands to nothing, which is not a valid address —
   * accepting it would let two spellings of different addresses compare equal.
   */
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

export interface ParsedCidr {
  readonly base: bigint;
  readonly bits: 32 | 128;
  readonly prefix: number;
}

/**
 * `203.0.113.0/24`, or a bare address meaning a single host.
 *
 * A bare address is accepted because that is what people type, and refusing it
 * would produce a form where the only way to allow one machine is to know that
 * `/32` exists.
 */
export function parseCidr(cidr: string): ParsedCidr | null {
  const [addressPart, prefixPart, ...rest] = cidr.trim().split('/');
  if (rest.length > 0 || addressPart === undefined) return null;

  const parsed = parseAddress(addressPart);
  if (parsed === null) return null;

  if (prefixPart === undefined) {
    return { base: parsed.value, bits: parsed.bits, prefix: parsed.bits };
  }
  if (!/^\d{1,3}$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  if (prefix > parsed.bits) return null;

  /**
   * The base is masked rather than required to be already-masked.
   *
   * `203.0.113.7/24` is what somebody types when they mean "that machine's
   * network", and refusing it teaches them to write something they understand
   * less well. Masking makes the two spellings identical, which is what they
   * meant.
   */
  const mask = prefix === 0 ? 0n : (~0n << BigInt(parsed.bits - prefix)) & maskFor(parsed.bits);
  return { base: parsed.value & mask, bits: parsed.bits, prefix };
}

function maskFor(bits: 32 | 128): bigint {
  return (1n << BigInt(bits)) - 1n;
}

/** Whether an address falls inside a range. Families never mix. */
export function inCidr(address: Parsed, cidr: ParsedCidr): boolean {
  if (address.bits !== cidr.bits) return false;
  if (cidr.prefix === 0) return true;
  const mask = (~0n << BigInt(cidr.bits - cidr.prefix)) & maskFor(cidr.bits);
  return (address.value & mask) === cidr.base;
}

/** Whether a string is something this platform can enforce a rule on. */
export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Whether this address may reach this scope.
 *
 * A malformed rule is **ignored**, not treated as a match either way. A typo in
 * one row must not silently widen an allow-list, and it must not lock a firm
 * out of the panel where the typo could be fixed. It is refused at the API
 * before it can be stored; this is the belt to that braces.
 */
export function evaluate(
  address: string,
  rules: readonly IpRule[],
  scope: IpRuleScope,
): IpDecision {
  const parsed = parseAddress(address);
  if (parsed === null) {
    /**
     * An address this platform cannot parse is not an address it can judge.
     * Enforcing on it would be enforcing on a guess.
     */
    return { allowed: true, reason: 'no-rules' };
  }

  /**
   * `STAFF` rules apply to staff. `EVERYONE` rules apply to everybody,
   * including staff — a firm that says "nobody from that network" means nobody.
   */
  const applicable = rules.filter(
    (rule) => rule.scope === IpRuleScope.EVERYONE || rule.scope === scope,
  );
  if (applicable.length === 0) return { allowed: true, reason: 'no-rules' };

  for (const rule of applicable) {
    if (rule.kind !== IpRuleKind.DENY) continue;
    const range = parseCidr(rule.cidr);
    if (range !== null && inCidr(parsed, range)) {
      return { allowed: false, reason: 'denied', cidr: rule.cidr };
    }
  }

  const allows = applicable.filter((rule) => rule.kind === IpRuleKind.ALLOW);
  if (allows.length === 0) return { allowed: true, reason: 'not-denied' };

  for (const rule of allows) {
    const range = parseCidr(rule.cidr);
    if (range !== null && inCidr(parsed, range)) {
      return { allowed: true, reason: 'allow-listed' };
    }
  }
  return { allowed: false, reason: 'not-allow-listed' };
}

/**
 * Would this rule set shut this address out?
 *
 * Asked **before** a rule is saved, against the address of the person saving
 * it. An allow-list that excludes the person writing it locks the firm out of
 * the screen where the mistake could be undone, and the only remaining fix is a
 * database console — which is not a support process, it is an outage.
 */
export function wouldLockOut(
  address: string,
  rules: readonly IpRule[],
  scope: IpRuleScope,
): boolean {
  return !evaluate(address, rules, scope).allowed;
}
