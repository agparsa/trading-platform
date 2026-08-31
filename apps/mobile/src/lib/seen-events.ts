/**
 * Every event, once.
 *
 * §26 in one file. A single occurrence reaches this app by up to three routes —
 * a WebSocket frame, a push notification tapped or received in the foreground,
 * and a re-snapshot after a reconnect — and each of them can arrive more than
 * once. Without a memory of what has been handled, a reconnect during a busy
 * minute replays a dozen fills, each playing its sound.
 *
 * ## Why bounded, and why insertion-ordered
 *
 * An unbounded set is a leak that only shows up in the session of a trader who
 * leaves the app open all day — which is every serious one. A `Map` keeps
 * insertion order, so evicting the oldest is `keys().next()`; a `Set` would
 * work identically here, and `Map` is used because the timestamp is worth
 * keeping for the debug screen.
 *
 * ## Why not a timestamp cutoff
 *
 * Because clocks. A device that has drifted, or one whose user has just crossed
 * a timezone, would either forget everything or remember nothing. Counting is
 * the only thing that cannot be wrong.
 */
export class SeenEvents {
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity = 500) {
    if (capacity < 1) throw new Error('SeenEvents needs room for at least one event');
  }

  /**
   * Records the event and says whether it is new.
   *
   * Deliberately one call rather than `has` then `add`. Two calls invite the
   * shape where a caller checks, awaits something, and acts — by which time a
   * second copy has arrived and passed the same check.
   */
  claim(eventId: string, at: number = Date.now()): boolean {
    if (this.seen.has(eventId)) {
      return false;
    }
    this.seen.set(eventId, at);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  get size(): number {
    return this.seen.size;
  }

  /** Called on sign-out. One person's events must not be another's. */
  clear(): void {
    this.seen.clear();
  }
}
