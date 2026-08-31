import { describe, expect, it } from 'vitest';
import { SeenEvents } from './seen-events';

/**
 * The client half of §26.
 *
 * One occurrence reaches this app by up to three routes — a socket frame, a
 * push, and a re-snapshot after a reconnect — and each can arrive more than
 * once. The failure this prevents is a trader hearing their fill sound four
 * times because the train went through a tunnel.
 */
describe('remembering which events have been handled', () => {
  it('claims an event once', () => {
    const seen = new SeenEvents();
    expect(seen.claim('evt-1')).toBe(true);
    expect(seen.claim('evt-1')).toBe(false);
  });

  it('keeps different events apart', () => {
    const seen = new SeenEvents();
    expect(seen.claim('evt-1')).toBe(true);
    expect(seen.claim('evt-2')).toBe(true);
  });

  it('forgets the oldest rather than growing without limit', () => {
    const seen = new SeenEvents(3);
    seen.claim('a');
    seen.claim('b');
    seen.claim('c');
    seen.claim('d');

    expect(seen.size).toBe(3);
    // 'a' fell out, so it would be treated as new again. That is the accepted
    // cost of a bound: a duplicate arriving 500 events later is not the case
    // this defends against, and an unbounded set is a leak in the session of
    // every trader who leaves the app open all day.
    expect(seen.has('a')).toBe(false);
    expect(seen.has('d')).toBe(true);
  });

  it("does not refresh an event's place by re-claiming it", () => {
    const seen = new SeenEvents(3);
    seen.claim('a');
    seen.claim('b');
    // A duplicate must not keep 'a' alive at the expense of a genuinely newer
    // event — otherwise a repeatedly-redelivered push evicts everything else.
    seen.claim('a');
    seen.claim('c');
    seen.claim('d');
    expect(seen.has('a')).toBe(false);
    expect(seen.has('d')).toBe(true);
  });

  it('holds a realistic burst without evicting the start of it', () => {
    const seen = new SeenEvents(500);
    for (let i = 0; i < 400; i += 1) seen.claim(`evt-${i}`);
    // A reconnect replaying a busy minute must not push the beginning of that
    // same minute out of memory, or the replay's own first events sound twice.
    expect(seen.has('evt-0')).toBe(true);
    expect(seen.claim('evt-0')).toBe(false);
  });

  it('forgets everything on sign-out', () => {
    const seen = new SeenEvents();
    seen.claim('evt-1');
    seen.clear();
    // The next person to sign in on this phone starts with a clean memory.
    expect(seen.claim('evt-1')).toBe(true);
  });

  it('refuses a capacity that cannot hold anything', () => {
    expect(() => new SeenEvents(0)).toThrow();
  });
});
