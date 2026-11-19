'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@tp/ui';
import type { MessageKey } from '@/lib/messages';
import { useT } from '@/lib/use-locale';
import { NavIcon, type NavIconName } from './nav-icons';

export interface SidebarItem {
  readonly href: string;
  readonly label: string;
  readonly key?: MessageKey;
  readonly icon: NavIconName;
  /** Light up only on this exact path — for a root every other link starts with. */
  readonly exact?: boolean;
}

export interface SidebarGroup {
  readonly title?: string;
  readonly titleKey?: MessageKey;
  readonly items: readonly SidebarItem[];
}

/**
 * The menu down the side of every page that is not the terminal.
 *
 * Grouped, with an icon per screen: a single row of eleven words — and, in
 * the admin, two rows of twenty-three — was every screen at once with nothing
 * to find them by. On a phone it folds into a drawer behind a menu button.
 *
 * Every link is still a plain `<a href>` to the screen's own address, and the
 * whole menu is one `<nav>` named "Sections", which is what the browser smoke
 * reads to check nothing a trader can reach is missing from it.
 */
export function Sidebar({
  brand,
  groups,
  footer,
  children,
}: {
  brand: ReactNode;
  groups: readonly SidebarGroup[];
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const t = useT();

  // A drawer that stays open over the page it just navigated to is in the way.
  useEffect(() => setOpen(false), [pathname]);

  const panel = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
        {brand}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-terminal-muted hover:text-terminal-text lg:hidden"
          aria-label="Close menu"
        >
          <NavIcon name="close" />
        </button>
      </div>
      <nav
        aria-label={t('nav.sections')}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4 pt-2"
      >
        {groups.map((group, index) => (
          <div key={group.titleKey ?? group.title ?? index}>
            {group.title === undefined && group.titleKey === undefined ? null : (
              <p className="mb-1.5 px-2 text-micro font-medium uppercase tracking-wider text-terminal-muted">
                {group.titleKey === undefined ? group.title : t(group.titleKey)}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active =
                  item.exact === true ? pathname === item.href : pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-terminal-accent/15 font-medium text-terminal-text'
                          : 'text-terminal-muted hover:bg-terminal-raised hover:text-terminal-text',
                      )}
                    >
                      <span className={active ? 'text-terminal-accent' : undefined}>
                        <NavIcon name={item.icon} />
                      </span>
                      {item.key === undefined ? item.label : t(item.key)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {footer === undefined ? null : (
        <div className="shrink-0 border-t border-terminal-border p-3">{footer}</div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-screen bg-terminal-bg">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-e border-terminal-border bg-terminal-surface lg:block">
        {panel}
      </aside>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 start-0 w-72 max-w-[85vw] border-e border-terminal-border bg-terminal-surface shadow-xl">
            {panel}
          </aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <OpenMenu.Provider value={() => setOpen(true)}>{children}</OpenMenu.Provider>
      </div>
    </div>
  );
}

/** The phone's way into the menu, placed by the page's own top bar. */
const OpenMenu = createContext<() => void>(() => undefined);

export function MenuButton() {
  const open = useContext(OpenMenu);
  return (
    <button
      type="button"
      aria-label="Menu"
      onClick={open}
      className="rounded p-1.5 text-terminal-muted hover:bg-terminal-raised hover:text-terminal-text lg:hidden"
    >
      <NavIcon name="menu" />
    </button>
  );
}
