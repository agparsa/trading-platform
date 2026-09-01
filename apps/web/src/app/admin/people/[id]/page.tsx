'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { PeoplePanel } from '@/components/admin/people-panel';

/**
 * One person, at an address.
 *
 * The list is still here above the detail, because an operator who followed a
 * link into somebody's record usually needs the person next to them too — and
 * because losing the search box on the way in would make the back button the
 * only way to keep looking.
 */
export default function Page() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = typeof params.id === 'string' ? params.id : null;

  return (
    <div>
      <div className="border-b border-terminal-border px-3 py-1.5">
        <Link
          href="/admin/people"
          className="text-[11px] text-terminal-muted transition-colors hover:text-terminal-text"
        >
          ← All people
        </Link>
      </div>
      <PeoplePanel
        selectedId={id}
        onSelect={(userId) => {
          router.push(userId === null ? '/admin/people' : `/admin/people/${userId}`);
        }}
      />
    </div>
  );
}
