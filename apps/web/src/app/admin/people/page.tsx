'use client';

import { useRouter } from 'next/navigation';
import { PeoplePanel } from '@/components/admin/people-panel';

export default function Page() {
  const router = useRouter();
  return (
    <PeoplePanel
      selectedId={null}
      onSelect={(userId) => {
        if (userId !== null) router.push(`/admin/people/${userId}`);
      }}
    />
  );
}
