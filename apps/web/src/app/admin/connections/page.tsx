'use client';

import { ConnectionsPanel } from '@/components/admin/connections-panel';
import { UnconfirmedOrdersPanel } from '@/components/admin/unconfirmed-orders-panel';

export default function Page() {
  return (
    <div className="space-y-4">
      <ConnectionsPanel />
      <section className="border-t border-terminal-border pt-2">
        <h2 className="px-3 text-[10px] uppercase tracking-wider text-terminal-muted">
          Waiting on a venue
        </h2>
        <UnconfirmedOrdersPanel />
      </section>
    </div>
  );
}
