import { redirect } from 'next/navigation';

/** The console has sections now; this is the one it opens on. */
export default function AdminIndex() {
  redirect('/admin/overview');
}
