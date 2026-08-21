/**
 * Seeded pseudo-random source.
 *
 * `Math.random()` is banned in the market simulator: a market that cannot be
 * replayed cannot be used to reproduce a trading bug. Same seed, same tick
 * sequence, same fills, same P&L — on any machine, forever.
 *
 * mulberry32: small, fast, and good enough for price-path simulation. It is not
 * a cryptographic RNG and must never be used for tokens or secrets.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new TypeError('Seed must be an integer');
    // >>> 0 keeps the state an unsigned 32-bit integer across all operations.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  between(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Standard normal, via Box-Muller. Used for the price-path increments. */
  normal(): number {
    // u must be strictly positive for Math.log.
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
