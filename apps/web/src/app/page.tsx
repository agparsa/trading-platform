import { redirect } from 'next/navigation';

/**
 * The root is the trader's home, `/dashboard` (it was `/terminal` until the
 * dashboard existed).
 *
 * A redirect rather than a re-export, because the point of this phase is that
 * every screen has an address an operator can be sent. Two URLs rendering the
 * same terminal would leave "which one do I paste into the incident channel?"
 * an open question, and the answer would drift.
 *
 * It stays because bookmarks, the installed PWA and every link written before
 * today all point here.
 */
export default function Root() {
  redirect('/dashboard');
}
