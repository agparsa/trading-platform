'use client';

import { useState } from 'react';
import { SecurityPanel } from '@/components/admin/security-panel';
import { IpRulesPanel } from '@/components/admin/ip-rules-panel';
import { Tabs } from '@/components/primitives';

type Tab = 'feed' | 'addresses';

/**
 * The firm's security screen: what has happened, and where the firm may be
 * reached from. Two tabs rather than two pages, because the feed is where a
 * strange sign-in is noticed and the rules are what somebody reaches for next.
 */
export default function Page() {
  const [tab, setTab] = useState<Tab>('feed');
  return (
    <div className="flex flex-col">
      <div className="border-b border-terminal-border px-3 py-2">
        <Tabs<Tab>
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'feed', label: 'Feed' },
            { id: 'addresses', label: 'Where we can be reached from' },
          ]}
        />
      </div>
      {tab === 'feed' ? <SecurityPanel /> : <IpRulesPanel />}
    </div>
  );
}
