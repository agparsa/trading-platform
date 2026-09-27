import type { NavItem } from './nav';

/**
 * Every screen a trader has, in the order the header shows them.
 *
 * One list, read by the terminal's header and by the shell around every other
 * page, so that the two cannot disagree: a screen added here is reachable from
 * everywhere, and a screen reachable from the account page but not from the
 * terminal — which is where a trader spends the session — was the bug this
 * list replaced.
 *
 * The wallet link arrived with the wallet. It was deliberately absent until
 * there was one — §50 says not to build UI for functionality that does not
 * exist, and a page reading "Balance: —" is a promise the platform cannot keep.
 */
export const TRADER_SECTIONS: readonly NavItem[] = [
  { href: '/terminal', label: 'Terminal' },
  { href: '/account', label: 'Account' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/verification', label: 'Verification' },
  { href: '/history', label: 'History' },
  { href: '/security', label: 'Security' },
  { href: '/developer', label: 'Developer' },
  { href: '/settings', label: 'Settings' },
];
