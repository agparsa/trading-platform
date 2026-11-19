/**
 * The shell's icons: outline glyphs on a 24-unit grid, drawn here so the menu
 * needs no icon font. The same shapes as the mobile app's.
 */
export type NavIconName =
  | 'dashboard'
  | 'terminal'
  | 'account'
  | 'wallet'
  | 'verification'
  | 'history'
  | 'analytics'
  | 'instruments'
  | 'security'
  | 'developer'
  | 'settings'
  | 'people'
  | 'book'
  | 'market'
  | 'risk'
  | 'desks'
  | 'payments'
  | 'withdrawals'
  | 'reconciliation'
  | 'reports'
  | 'roles'
  | 'credentials'
  | 'connections'
  | 'notifications'
  | 'webhooks'
  | 'features'
  | 'brokers'
  | 'audit'
  | 'menu'
  | 'close'
  | 'logout'
  | 'admin';

const PATHS: Readonly<Record<NavIconName, string>> = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  terminal:
    'M4 20V4M4 20h16M7.5 9.5v6M7.5 7v2.5M7.5 15.5V17M12.5 7v5M12.5 5v2M12.5 12v3M17.5 10v4M17.5 8v2M17.5 14v2',
  account:
    'M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM3 9.5h18M15 15h3',
  wallet:
    'M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v1M4 7.5v10A2.5 2.5 0 0 0 6.5 20H19a1 1 0 0 0 1-1v-3M4 7.5A2.5 2.5 0 0 0 6.5 10H19a1 1 0 0 1 1 1v5h-4a2.5 2.5 0 0 1 0-5h4',
  verification: 'M12 21s7.5-3.6 7.5-10V5.5L12 3 4.5 5.5V11c0 6.4 7.5 10 7.5 10zM9 12l2 2 4-4',
  history: 'M12 20.5a8.5 8.5 0 1 0-8.5-8.5M3.5 12 1.8 10.3M3.5 12l1.8-1.8M12 7.5V12l3 2',
  analytics: 'M4 17l5-5 3.5 3.5L20 8M15 8h5v5',
  instruments: 'M4 6h16M4 12h16M4 18h10',
  security: 'M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5zM12 14v2.5',
  developer: 'M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
  people:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.8c1.8.7 3 2.4 3.5 5.2',
  book: 'M5 4.5h11a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
  market: 'M3 12h3l2.5-6 4 12 3-9 2 3H21',
  risk: 'M12 4 2.5 20h19zM12 10v4.5M12 17.2v.3',
  desks: 'M3 7h18v4H3zM5 11v9M19 11v9M9 15h6',
  payments: 'M3 6h18v12H3zM3 10h18M7 15h3',
  withdrawals: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14',
  reconciliation: 'M4 9h13l-3-3M20 15H7l3 3',
  reports: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  roles: 'M12 3l7 4v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V7zM9.5 12.5l2 2 3.5-4',
  credentials: 'M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 12 3 20M5.5 17.5l2 2M8 15l2 2',
  connections:
    'M9 15 15 9M7.5 11.5 5 14a3.5 3.5 0 0 0 5 5l2.5-2.5M16.5 12.5 19 10a3.5 3.5 0 0 0-5-5l-2.5 2.5',
  notifications: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  webhooks:
    'M9.5 7.5a3 3 0 1 1 3 3L9 17M7 17a3 3 0 1 1-1.2-2.4M17 17a3 3 0 1 0 0-6c-.6 0-1.2.2-1.7.5L12.5 7',
  features: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  brokers: 'M3 21h18M5 21V10M19 21V10M9 21v-6h6v6M2.5 10 12 4l9.5 6',
  audit: 'M8 4h8M6 4v16h12V4M9 9h6M9 13h6M9 17h3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  logout: 'M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14M10 12h10M17 9l3 3-3 3',
  admin: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z',
};

export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className ?? 'h-[18px] w-[18px] shrink-0'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
