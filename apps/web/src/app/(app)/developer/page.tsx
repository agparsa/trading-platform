'use client';

import { AppShell } from '@/components/shell/app-shell';
import { DeveloperReference } from '@/components/developer-reference';

/**
 * The developer reference. Every route the API serves and the conventions
 * it holds a caller to, fetched from the running platform rather than typed
 * in — so this page cannot describe a version other than the one answering.
 */
export default function DeveloperPage() {
  return (
    <AppShell
      title="Developer"
      description="The API this platform serves, as it describes itself: every route, how to authenticate, how to make a mutation idempotent, and how to verify a webhook."
    >
      <DeveloperReference />
    </AppShell>
  );
}
