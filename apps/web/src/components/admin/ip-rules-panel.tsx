'use client';

import { useState } from 'react';
import { cn } from '@tp/ui';
import { Button, inputClass } from '@/components/primitives';
import {
  useCreateIpRule,
  useDeleteIpRule,
  useIpRules,
  useSetIpRuleEnabled,
  type IpRuleRow,
} from '@/lib/admin-queries';
import { utcTime } from '@/lib/format';
import { ErrorLine, Head, Loading, Table } from './shared';

/**
 * Where this firm may be reached from (§46).
 *
 * The screen leads with the caller's own address, in the largest thing on it,
 * because every mistake this feature can make begins with somebody not knowing
 * what they are coming from. The server refuses a rule that would shut its
 * author out; this shows them the fact that refusal turns on, before they type.
 *
 * Nothing here is a control. The guard on the server decides; hiding a button
 * would only make the screen disagree with the platform.
 */
export function IpRulesPanel() {
  const view = useIpRules();
  const data = view.data;

  return (
    <div className="flex flex-col" data-testid="ip-rules">
      <Standing view={data} loading={view.isLoading} />
      <ErrorLine error={view.error} />
      {view.isLoading ? <Loading /> : data === undefined ? null : <Rules data={data} />}
    </div>
  );
}

function Standing({
  view,
  loading,
}: {
  view: ReturnType<typeof useIpRules>['data'];
  loading: boolean;
}) {
  if (loading || view === undefined) return null;
  return (
    <div className="border-b border-terminal-border px-3 py-3">
      <div className="text-[10px] uppercase tracking-wide text-terminal-muted">
        You are calling from
      </div>
      <div className="numeric text-base text-terminal-text" data-testid="your-address">
        {view.yourAddress === '' ? 'unknown' : view.yourAddress}
      </div>
      {view.enforceable ? (
        <p className="mt-1 text-[11px] text-terminal-muted">
          Rules are enforced. A rule that would shut you out from this address is refused.
        </p>
      ) : (
        <p className="mt-1 text-[11px] text-terminal-warning" data-testid="not-enforceable">
          {view.yourAddressTrusted
            ? 'Rules cannot be added: this deployment has not said how many proxies sit in front of the API. Set TRUSTED_PROXY_HOPS (0 if nothing is in front of it).'
            : 'Rules are NOT being enforced: the API cannot establish the address a request came from, so every rule below is inert. Check TRUSTED_PROXY_HOPS against the proxies actually in front of it.'}
        </p>
      )}
    </div>
  );
}

function Rules({ data }: { data: NonNullable<ReturnType<typeof useIpRules>['data']> }) {
  const create = useCreateIpRule();
  const toggle = useSetIpRuleEnabled();
  const remove = useDeleteIpRule();

  const [cidr, setCidr] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'ALLOW' | 'DENY'>('ALLOW');
  const [scope, setScope] = useState<'STAFF' | 'EVERYONE'>('STAFF');

  const ready = cidr.trim().length > 0 && note.trim().length > 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-terminal-border px-3 py-2">
        <input
          aria-label="Address or range"
          className={cn(inputClass, 'w-44 py-1 text-xs')}
          placeholder="Address or range, e.g. 203.0.113.0/24"
          value={cidr}
          onChange={(event) => setCidr(event.target.value)}
        />
        <select
          aria-label="Allow or deny"
          className={cn(inputClass, 'w-auto py-1 text-xs')}
          value={kind}
          onChange={(event) => setKind(event.target.value as 'ALLOW' | 'DENY')}
        >
          <option value="ALLOW">Allow</option>
          <option value="DENY">Deny</option>
        </select>
        <select
          aria-label="Who the rule applies to"
          className={cn(inputClass, 'w-auto py-1 text-xs')}
          value={scope}
          onChange={(event) => setScope(event.target.value as 'STAFF' | 'EVERYONE')}
        >
          <option value="STAFF">Staff only</option>
          <option value="EVERYONE">Everyone, customers included</option>
        </select>
        <input
          aria-label="Why this rule exists"
          className={cn(inputClass, 'min-w-48 flex-1 py-1 text-xs')}
          placeholder="Why — the Amsterdam office, a range we saw stuffing from…"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          variant="neutral"
          className="px-2 py-0.5"
          disabled={!ready || !data.enforceable || create.isPending}
          onClick={() => {
            create.mutate(
              { cidr: cidr.trim(), kind, scope, note: note.trim() },
              {
                onSuccess: () => {
                  setCidr('');
                  setNote('');
                },
              },
            );
          }}
        >
          {create.isPending ? 'Adding…' : 'Add rule'}
        </Button>
      </div>

      {/**
       * The first ALLOW is the moment a deny-list becomes an allow-list and
       * everybody not named is refused. Said here rather than discovered.
       */}
      {kind === 'ALLOW' && data.rules.every((rule) => rule.kind !== 'ALLOW' || !rule.enabled) ? (
        <p className="border-b border-terminal-border px-3 py-1.5 text-[11px] text-terminal-warning">
          This would be the first Allow rule. From then on, only addresses named by an Allow rule
          can reach the platform in that scope — everyone else is refused.
        </p>
      ) : null}

      <ErrorLine error={create.error ?? toggle.error ?? remove.error} />

      {data.rules.length === 0 ? (
        <Loading>No rules. The platform is reachable from anywhere.</Loading>
      ) : (
        <Table>
          <Head columns={['Range', 'Rule', 'Applies to', 'Why', 'Added', 'By', '']} />
          <tbody>
            {data.rules.map((rule: IpRuleRow) => (
              <tr
                key={rule.id}
                className={cn(
                  'border-t border-terminal-border/60 align-top',
                  rule.enabled ? '' : 'opacity-50',
                )}
              >
                <td className="numeric px-3 py-1.5">{rule.cidr}</td>
                <td className="px-3 py-1.5">
                  <span
                    className={
                      rule.kind === 'DENY' ? 'text-terminal-danger' : 'text-terminal-success'
                    }
                  >
                    {rule.kind === 'DENY' ? 'Deny' : 'Allow'}
                  </span>
                  {rule.enabled ? null : (
                    <span className="ml-1 text-[10px] text-terminal-muted">(off)</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {rule.scope === 'STAFF' ? 'Staff' : 'Everyone'}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">{rule.note}</td>
                <td className="numeric px-3 py-1.5 text-terminal-muted">
                  {utcTime(rule.createdAt)}
                </td>
                <td className="px-3 py-1.5 text-terminal-muted">
                  {rule.createdBy?.displayName ?? rule.createdBy?.email ?? '—'}
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      className="px-2 py-0.5"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: rule.id, enabled: !rule.enabled })}
                    >
                      {rule.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    <Button
                      variant="danger"
                      className="px-2 py-0.5"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate({ id: rule.id })}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
