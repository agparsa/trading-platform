'use client';

import { useMemo, useState } from 'react';
import { cn } from '@tp/ui';
import { Button } from '@/components/primitives';
import { ErrorLine, Loading } from './shared';
import {
  usePermissionCatalogue,
  useResetRolePermissions,
  useRoles,
  useSetRolePermissions,
} from '@/lib/admin-queries';

/**
 * What each role may do.
 *
 * Capabilities are compiled into the build — the checkbox list comes from
 * `/permissions/catalogue`, which reports what this version of the server knows
 * how to check. Which role carries which one is a row, and that is what this
 * screen edits.
 *
 * Every refusal shown here comes from the server. There are two, and neither is
 * re-implemented in the browser:
 *
 *  - an editor cannot grant a capability they do not hold themselves;
 *  - no single role may hold `accounts.adjust` alongside one that opens or
 *    reshapes a position — inventing money and using it must be two people.
 *
 * A browser-side copy of either would be a second statement of a rule that
 * exists precisely because it must be hard to bend, and the copy would be the
 * one that drifted.
 */
export function RolesPanel() {
  const roles = useRoles();
  const catalogue = usePermissionCatalogue();
  const save = useSetRolePermissions();
  const reset = useResetRolePermissions();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());

  const permissions = useMemo(() => catalogue.data?.permissions ?? [], [catalogue.data]);
  const grouped = useMemo(() => groupByResource(permissions), [permissions]);

  const rows = roles.data?.roles ?? [];
  const current = rows.find((role) => role.key === editing);

  const startEditing = (key: string, held: readonly string[]) => {
    setEditing(key);
    setDraft(new Set(held));
    save.reset();
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-terminal-border px-3 py-2">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Roles</p>
        <p className="mt-0.5 text-[11px] text-terminal-muted">
          Capabilities are part of this build. What each role carries is not — change it here and it
          applies to every session immediately.
        </p>
      </div>

      <ErrorLine error={roles.error ?? catalogue.error ?? save.error ?? reset.error} />

      {roles.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Loading>No roles. Run the roles seed for this tenant.</Loading>
      ) : (
        <div className="divide-y divide-terminal-border/60">
          {rows.map((role) => (
            <div key={role.key} className="px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12px] text-terminal-text">
                    {role.name}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-terminal-muted">
                      {role.key}
                    </span>
                    {role.isSystem ? (
                      <span
                        className="ml-2 text-[9px] uppercase tracking-wider text-terminal-muted"
                        title="Seeded with the platform. Its grants are editable; the role itself cannot be removed."
                      >
                        built in
                      </span>
                    ) : null}
                  </p>
                  {role.description === null ? null : (
                    <p className="mt-0.5 text-[11px] text-terminal-muted">{role.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="numeric text-[11px] text-terminal-muted">
                    {role.permissions.length} capabilities
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      editing === role.key
                        ? setEditing(null)
                        : startEditing(role.key, role.permissions)
                    }
                  >
                    {editing === role.key ? 'Cancel' : 'Edit'}
                  </Button>
                </div>
              </div>

              {editing !== role.key ? (
                <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-terminal-muted">
                  {role.permissions.join('  ')}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {grouped.map(([resource, verbs]) => (
                    <div key={resource}>
                      <p className="mb-1 text-[10px] uppercase tracking-wider text-terminal-muted">
                        {resource}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {verbs.map((permission) => {
                          const on = draft.has(permission);
                          return (
                            <button
                              key={permission}
                              type="button"
                              aria-pressed={on}
                              onClick={() =>
                                setDraft((previous) => {
                                  const next = new Set(previous);
                                  if (on) next.delete(permission);
                                  else next.add(permission);
                                  return next;
                                })
                              }
                              className={cn(
                                'rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors',
                                on
                                  ? 'border-terminal-accent bg-terminal-accent/15 text-terminal-text'
                                  : 'border-terminal-border text-terminal-muted hover:text-terminal-text',
                              )}
                            >
                              {permission}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() =>
                        save.mutate(
                          { key: role.key, permissions: [...draft].sort() },
                          { onSuccess: () => setEditing(null) },
                        )
                      }
                      disabled={save.isPending}
                    >
                      {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                    {role.isSystem ? (
                      <Button
                        variant="ghost"
                        onClick={() =>
                          reset.mutate({ key: role.key }, { onSuccess: () => setEditing(null) })
                        }
                        disabled={reset.isPending}
                        title="Put this role back to the capabilities this build ships with"
                      >
                        {reset.isPending ? 'Restoring…' : 'Restore defaults'}
                      </Button>
                    ) : null}
                    <span className="numeric text-[11px] text-terminal-muted">
                      {draft.size} selected
                      {current === undefined
                        ? ''
                        : ` · ${String(differenceSize(draft, current.permissions))} changed`}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** `orders.create` and `orders.cancel` belong together on screen. */
function groupByResource(permissions: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const permission of [...permissions].sort()) {
    const resource = permission.split('.')[0] ?? permission;
    groups.set(resource, [...(groups.get(resource) ?? []), permission]);
  }
  return [...groups.entries()];
}

function differenceSize(draft: ReadonlySet<string>, held: readonly string[]): number {
  const before = new Set(held);
  let changed = 0;
  for (const permission of draft) if (!before.has(permission)) changed += 1;
  for (const permission of before) if (!draft.has(permission)) changed += 1;
  return changed;
}
