import type { NavItem } from './nav';
import type { SidebarGroup } from './sidebar';

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
  { href: '/dashboard', label: 'Dashboard', key: 'nav.dashboard' },
  { href: '/terminal', label: 'Terminal', key: 'nav.terminal' },
  { href: '/account', label: 'Account', key: 'nav.account' },
  { href: '/wallet', label: 'Wallet', key: 'nav.wallet' },
  { href: '/verification', label: 'Verification', key: 'nav.verification' },
  { href: '/history', label: 'History', key: 'nav.history' },
  { href: '/analytics', label: 'Analytics', key: 'nav.analytics' },
  { href: '/instruments', label: 'Instruments', key: 'nav.instruments' },
  { href: '/security', label: 'Security', key: 'nav.security' },
  { href: '/developer', label: 'Developer', key: 'nav.developer' },
  { href: '/settings', label: 'Settings', key: 'nav.settings' },
];

/**
 * The same sections, grouped and given icons, for the menu down the side of
 * every page but the terminal. Built from `TRADER_SECTIONS`, not beside it, so
 * the two cannot list different screens.
 */
const GROUPING: ReadonlyArray<{
  titleKey?: SidebarGroup['titleKey'];
  items: ReadonlyArray<[string, SidebarGroup['items'][number]['icon']]>;
}> = [
  {
    items: [
      ['/dashboard', 'dashboard'],
      ['/terminal', 'terminal'],
    ],
  },
  {
    titleKey: 'nav.group.trading',
    items: [
      ['/account', 'account'],
      ['/history', 'history'],
      ['/analytics', 'analytics'],
      ['/instruments', 'instruments'],
    ],
  },
  { titleKey: 'nav.group.money', items: [['/wallet', 'wallet']] },
  {
    titleKey: 'nav.group.you',
    items: [
      ['/verification', 'verification'],
      ['/security', 'security'],
      ['/settings', 'settings'],
      ['/developer', 'developer'],
    ],
  },
];

export const TRADER_GROUPS: readonly SidebarGroup[] = GROUPING.map((group) => ({
  ...(group.titleKey === undefined ? {} : { titleKey: group.titleKey }),
  items: group.items.map(([href, icon]) => {
    const section = TRADER_SECTIONS.find((item) => item.href === href);
    if (section === undefined) throw new Error(`${href} is not a trader section`);
    return { ...section, icon };
  }),
}));
