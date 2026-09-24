'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, type ButtonGate, inputClass } from '@/components/primitives';
import {
  useAdminUser,
  useAdminUserDevices,
  useAdminUsers,
  useAssignRole,
  useForceSignOut,
  useRevokeDevice,
  useSuspendUser,
  useUnlockUser,
} from '@/lib/admin-queries';
import { money, utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, ReasonedAction, SearchBox, StatusPill, Table } from './shared';

/**
 * Users, and what may be done to them.
 *
 * Three separate actions rather than one "disable", because they answer three
 * different situations and collapsing them would make the wrong one convenient:
 *
 *  - **suspend** — stop them signing in *and* end their sessions. Anything less
 *    leaves whoever is logged in able to keep trading, which reads afterwards
 *    as a suspension that did nothing.
 *  - **sign out** — end their sessions and let them straight back in. What a
 *    stolen laptop needs.
 *  - **unlock** — clear a lockout from failed attempts. What a forgotten
 *    password needs, and not a punishment to be lifted.
 */
export function PeoplePanel({
  selectedId = null,
  onSelect,
}: {
  /**
   * Which person is open, when the URL is the one deciding.
   *
   * `/admin/people/:id` passes it and handles `onSelect` by navigating. Left
   * undefined, the panel keeps its own state — which is what it did before this
   * became a route, and what a future embedding of it would want.
   */
  selectedId?: string | null;
  onSelect?: (userId: string | null) => void;
} = {}) {
  const [search, setSearch] = useState('');
  const [ownSelection, setOwnSelection] = useState<string | null>(null);
  const selected = onSelect === undefined ? ownSelection : selectedId;
  const select = onSelect ?? setOwnSelection;
  const users = useAdminUsers(search);
  const suspend = useSuspendUser();
  const signOut = useForceSignOut();
  const assignRole = useAssignRole();
  const unlock = useUnlockUser();

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-terminal-border px-3 py-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Email or name" />
        <span className="text-[10px] text-terminal-muted">
          {users.data === undefined ? '' : `${users.data.length} shown`}
        </span>
      </div>

      <ErrorLine
        error={users.error ?? assignRole.error ?? suspend.error ?? signOut.error ?? unlock.error}
      />

      {users.isLoading ? (
        <Loading />
      ) : (users.data ?? []).length === 0 ? (
        <Loading>Nobody matches that.</Loading>
      ) : (
        <Table>
          <Head
            columns={[
              'Email',
              'Name',
              'Role',
              'State',
              '2FA',
              { label: 'Accounts', right: true },
              'Last seen',
              { label: 'Actions', right: true },
            ]}
          />
          <tbody>
            {(users.data ?? []).map((user) => (
              <tr
                key={user.id}
                className={cn(
                  'border-t border-terminal-border/60',
                  selected === user.id ? 'bg-terminal-raised/50' : 'hover:bg-terminal-raised/30',
                )}
              >
                <td className="px-2 py-1.5 text-terminal-text">
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => select(selected === user.id ? null : user.id)}
                  >
                    {user.email}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">{user.displayName}</td>
                <td className="px-2 py-1.5 text-terminal-muted">
                  <RoleCell
                    userId={user.id}
                    role={user.role}
                    busy={assignRole.isPending}
                    onAssign={(role, reason) => assignRole.mutate({ id: user.id, role, reason })}
                    gate={assignRole}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <StatusPill status={user.isActive ? 'ACTIVE' : 'SUSPENDED'} />
                  {user.lockedUntil === null ? null : (
                    <span
                      className="ml-1 text-[9px] uppercase text-terminal-warning"
                      title={`Locked out until ${utcTime(user.lockedUntil)} UTC after ${user.failedLoginAttempts} failed attempts`}
                    >
                      locked
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">
                  {user.twoFactorEnabled ? 'on' : '—'}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  {user.accounts}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {user.lastLoginAt === null ? '—' : utcTime(user.lastLoginAt)}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap justify-end gap-1">
                    <ReasonedAction
                      gate={suspend}
                      label={user.isActive ? 'Suspend' : 'Reinstate'}
                      title={
                        user.isActive ? 'Why they are being suspended' : 'Why they are cleared'
                      }
                      variant={user.isActive ? 'danger' : 'neutral'}
                      busy={suspend.isPending}
                      onConfirm={(reason) =>
                        suspend.mutate({ userId: user.id, suspend: user.isActive, reason })
                      }
                    />
                    <ReasonedAction
                      gate={signOut}
                      label="Sign out"
                      title="Why their sessions are being ended"
                      busy={signOut.isPending}
                      onConfirm={(reason) => signOut.mutate({ userId: user.id, reason })}
                    />
                    {user.lockedUntil === null ? null : (
                      <Button
                        gate={unlock}
                        variant="ghost"
                        className="px-2 py-0.5"
                        disabled={unlock.isPending}
                        onClick={() => unlock.mutate({ userId: user.id })}
                      >
                        Unlock
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected === null ? null : <UserDetail userId={selected} />}
    </div>
  );
}

/** One person's accounts and live sessions. */
export function UserDetail({ userId }: { userId: string }) {
  const detail = useAdminUser(userId);

  if (detail.isLoading) return <Loading />;
  if (detail.error !== null) return <ErrorLine error={detail.error} />;
  const data = detail.data;
  if (data === undefined) return null;

  return (
    <div className="border-t border-terminal-border bg-terminal-bg px-3 py-3">
      <p className="mb-2 text-[10px] uppercase tracking-wider text-terminal-muted">
        {data.email} — accounts
      </p>
      {data.accounts.length === 0 ? (
        <p className="text-[11px] text-terminal-muted">No accounts.</p>
      ) : (
        <Table>
          <Head
            columns={[
              'Number',
              'Type',
              'State',
              'Currency',
              { label: 'Balance', right: true },
              { label: 'Leverage', right: true },
              { label: 'Positions', right: true },
              'Opened',
            ]}
          />
          <tbody>
            {data.accounts.map((account) => (
              <tr key={account.id} className="border-t border-terminal-border/60">
                <td className="numeric px-2 py-1.5 text-terminal-text">{account.number}</td>
                <td className="px-2 py-1.5 text-terminal-muted">{account.type}</td>
                <td className="px-2 py-1.5">
                  <StatusPill status={account.status} />
                </td>
                <td className="px-2 py-1.5 text-terminal-muted">{account.currency}</td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-text">
                  {money(account.balance, account.currency)}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  1:{account.leverage}
                </td>
                <td className="numeric px-2 py-1.5 text-right text-terminal-muted">
                  {account.positions}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(account.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <p className="mb-2 mt-4 text-[10px] uppercase tracking-wider text-terminal-muted">
        Live sessions
      </p>
      {data.sessions.length === 0 ? (
        <p className="text-[11px] text-terminal-muted">Nobody is signed in.</p>
      ) : (
        <Table>
          <Head columns={['Device', 'Address', 'Signed in', 'Last refreshed']} />
          <tbody>
            {data.sessions.map((session) => (
              <tr key={session.id} className="border-t border-terminal-border/60">
                <td className="px-2 py-1.5 text-terminal-text">{session.device}</td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {session.ipAddress ?? '—'}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(session.signedInAt)}
                </td>
                <td className="numeric px-2 py-1.5 text-terminal-muted">
                  {utcTime(session.lastSeenAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <DevicesSection userId={userId} email={data.email} />
    </div>
  );
}

/**
 * The handsets on an account, and the one control that switches one off.
 *
 * Why staff need this at all: the platform already raises a WARNING when a
 * device this account has never been seen on registers, and now sends it on as
 * a `security.alert` webhook. Until this section existed the person reading
 * that alarm could not see what devices the account had, when each was last
 * used, or stop one — an alarm with nothing to do about it.
 *
 * Revoking here is **not** the same as the person doing it themselves: it
 * survives the handset re-registering on its next launch, which the person's
 * own revocation deliberately does not.
 *
 * Both now end the sessions that installation holds. When this screen was
 * first built they did not, and the note under the button said so — an
 * operator who believed a revocation had signed the thief out would have
 * stopped looking. Sessions carry their installation now. What a revocation
 * still cannot reach is a *browser* session, which names no device, so the
 * note says that instead: `Sign out` is the control for a compromised account
 * rather than a lost handset.
 */
function DevicesSection({ userId, email }: { userId: string; email: string }) {
  const devices = useAdminUserDevices(userId);
  const revoke = useRevokeDevice();
  const [reason, setReason] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  return (
    <>
      <p className="mb-2 mt-4 text-[10px] uppercase tracking-wider text-terminal-muted">Devices</p>
      {devices.isLoading ? (
        <Loading />
      ) : devices.error !== null ? (
        <ErrorLine error={devices.error} />
      ) : (devices.data ?? []).length === 0 ? (
        <p className="text-[11px] text-terminal-muted">No devices registered.</p>
      ) : (
        <Table>
          <Head
            columns={['Device', 'App', 'Notifications', 'State', 'Last seen', 'First seen', '']}
          />
          <tbody>
            {(devices.data ?? []).map((device) => {
              const staffRevoked = device.revokedByStaffAt !== null;
              return (
                <tr key={device.id} className="border-t border-terminal-border/60">
                  <td className="px-2 py-1.5 text-terminal-text">
                    {device.model ?? device.platform}
                    <span className="ml-1 text-terminal-muted">{device.platform}</span>
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {device.appVersion ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 text-terminal-muted">
                    {device.pushTokenRejectedAt !== null
                      ? 'rejected by provider'
                      : device.hasPushToken
                        ? `on · ${device.pushTokenFingerprint ?? '····'}`
                        : 'off'}
                  </td>
                  <td className="px-2 py-1.5">
                    <StatusPill
                      status={staffRevoked ? 'REVOKED' : device.isActive ? 'ACTIVE' : 'INACTIVE'}
                    />
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {utcTime(device.lastSeenAt)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-terminal-muted">
                    {utcTime(device.createdAt)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      disabled={revoke.isPending || reason.trim().length === 0 || !revoke.allowed}
                      title={
                        revoke.allowed ? undefined : `Your role does not carry ${revoke.requires}`
                      }
                      onClick={() => {
                        setActing(device.id);
                        revoke.mutate(
                          {
                            userId,
                            deviceId: device.id,
                            reason: reason.trim(),
                            ...(staffRevoked ? { restore: true } : {}),
                          },
                          { onSettled: () => setActing(null) },
                        );
                      }}
                      className="border border-terminal-border px-2 py-0.5 text-[11px] text-terminal-text transition-colors hover:border-terminal-text disabled:opacity-40"
                    >
                      {acting === device.id ? '…' : staffRevoked ? 'Restore' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {(devices.data ?? []).length > 0 ? (
        <div className="mt-2">
          <label className="block">
            <span className="sr-only">{`Why a device of ${email} is being revoked`}</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why — required, and recorded in their security feed"
              className="w-full border border-terminal-border bg-terminal-bg px-2 py-1 text-[11px] text-terminal-text placeholder:text-terminal-muted"
            />
          </label>
          <p className="mt-1 text-[10px] text-terminal-muted">
            Revoking stops notifications, ends the sessions that device holds, and survives the app
            restarting. It cannot reach a browser session, which names no device — use Sign out when
            the account itself is compromised rather than one handset.
          </p>
          {revoke.error !== null ? <ErrorLine error={revoke.error} /> : null}
        </div>
      ) : null}
    </>
  );
}

const ROLES = ['USER', 'SUPPORT', 'OPERATOR', 'RISK_MANAGER', 'FINANCE', 'ADMIN'] as const;

/**
 * The role, and the one control that changes it.
 *
 * Changing a role ends every session the person has — the role travels in the
 * token — and needs a reason, because who may do what is the first thing an
 * auditor reads. The server refuses a change to your own role; the control
 * does not hide that case, so the refusal is the truth rather than a missing
 * button.
 */
function RoleCell({
  userId,
  role,
  busy,
  onAssign,
  gate,
}: {
  userId: string;
  role: string;
  busy: boolean;
  onAssign: (role: string, reason: string) => void;
  /** `roles.assign`. Without it the role is shown, not offered for change. */
  gate: ButtonGate;
}) {
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState(role);
  const [reason, setReason] = useState('');

  if (!gate.allowed) {
    return <span title={`Your role does not carry ${gate.requires}`}>{role}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 hover:text-terminal-text"
        title="Change role"
        onClick={() => {
          setNext(role);
          setEditing(true);
        }}
      >
        {role}
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1" data-user={userId}>
      <select
        aria-label="Role"
        className={cn(inputClass, 'w-36 py-1 text-xs')}
        value={next}
        onChange={(event) => setNext(event.target.value)}
      >
        {ROLES.map((one) => (
          <option key={one} value={one}>
            {one}
          </option>
        ))}
      </select>
      <input
        aria-label="Why this role changes"
        className={cn(inputClass, 'w-48 py-1 text-xs')}
        placeholder="Why — their sessions will end"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        variant={next === 'ADMIN' || next === 'FINANCE' ? 'danger' : 'neutral'}
        className="px-2 py-0.5"
        disabled={busy || next === role || reason.trim().length < 4}
        onClick={() => {
          onAssign(next, reason.trim());
          setEditing(false);
          setReason('');
        }}
      >
        Change
      </Button>
      <Button variant="ghost" className="px-2 py-0.5" onClick={() => setEditing(false)}>
        Cancel
      </Button>
    </div>
  );
}
