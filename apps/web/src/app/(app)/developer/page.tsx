'use client';

import { AppShell } from '@/components/shell/app-shell';
import { useT } from '@/lib/use-locale';
import { DeveloperReference } from '@/components/developer-reference';

/**
 * The developer reference. Every route the API serves and the conventions
 * it holds a caller to, fetched from the running platform rather than typed
 * in — so this page cannot describe a version other than the one answering.
 */
export default function DeveloperPage() {
  const t = useT();
  return (
    <AppShell title={t('nav.developer')} description={t('developer.description')}>
      <DeveloperReference />
    </AppShell>
  );
}
