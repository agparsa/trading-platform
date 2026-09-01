'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@tp/ui';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * A row of links that knows which one you are on.
 *
 * `startsWith` rather than equality so that `/admin/people/<id>` still lights up
 * "People" — an operator who followed a link into a detail page should be able
 * to see where they are without reading the URL.
 *
 * The exception is a link whose href is a prefix of every other one in the row.
 * `/admin` would match all of them, so an item marked `exact` compares whole.
 */
export function Nav({
  items,
  exactFirst = false,
}: {
  items: readonly NavItem[];
  exactFirst?: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-1" aria-label="Sections">
      {items.map((item, index) => {
        const exact = exactFirst && index === 0;
        const active = exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded px-2 py-1 text-[11px] transition-colors',
              active
                ? 'bg-terminal-raised text-terminal-text'
                : 'text-terminal-muted hover:text-terminal-text',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
