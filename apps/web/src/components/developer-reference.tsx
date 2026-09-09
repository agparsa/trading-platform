'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@tp/ui';
import { useSession } from '@/lib/session';
import { inputClass, Panel } from '@/components/primitives';

interface Operation {
  method: string;
  path: string;
  summary: string;
  tag: string;
  deprecated: boolean;
}

interface OpenApiDocument {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<
    string,
    Record<string, { summary?: string; tags?: string[]; deprecated?: boolean }>
  >;
}

interface Conventions {
  authentication: { header: string; scheme: string; credentials: string[] };
  idempotency: { header: string; requiredOn: string; semantics: string };
  webhooks: {
    signatureHeader: string;
    scheme: string;
    signedOver: string;
    algorithm: string;
    recommendedToleranceSeconds: number;
  };
  keyablePermissions: string[];
  serviceGrantablePermissions: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const METHOD_TONE: Record<string, string> = {
  GET: 'text-terminal-long',
  POST: 'text-terminal-text',
  PUT: 'text-terminal-warning',
  PATCH: 'text-terminal-warning',
  DELETE: 'text-terminal-short',
};

/**
 * The API, as the API describes itself.
 *
 * Everything on this page is fetched: the route list is the OpenAPI document
 * the server built at boot, and the conventions — which header carries a
 * signature, which capabilities a key may hold — come from the code that
 * enforces them. Nothing is typed in here, so nothing here can be a version
 * behind the platform it describes. A reference that drifts is worse than
 * none; it is read instead of the truth.
 */
export function DeveloperReference() {
  const { api } = useSession();
  const document = useQuery({
    queryKey: ['developer', 'openapi'],
    queryFn: () => api.get<OpenApiDocument>('/developer/openapi.json'),
    staleTime: 60 * 60_000,
  });
  const conventions = useQuery({
    queryKey: ['developer', 'conventions'],
    queryFn: () => api.get<Conventions>('/developer/conventions'),
    staleTime: 60 * 60_000,
  });
  const [filter, setFilter] = useState('');

  const operations = useMemo(() => {
    const paths = document.data?.paths ?? {};
    const rows: Operation[] = [];
    for (const [path, byMethod] of Object.entries(paths)) {
      for (const method of METHODS) {
        const op = byMethod[method];
        if (op === undefined) continue;
        rows.push({
          method: method.toUpperCase(),
          path,
          summary: op.summary ?? '',
          tag: op.tags?.[0] ?? 'other',
          deprecated: op.deprecated === true,
        });
      }
    }
    return rows.sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path));
  }, [document.data]);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? operations.filter(
        (op) =>
          op.path.toLowerCase().includes(needle) ||
          op.summary.toLowerCase().includes(needle) ||
          op.tag.toLowerCase().includes(needle),
      )
    : operations;
  const tags = [...new Set(shown.map((op) => op.tag))];

  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="developer-reference">
      <Panel className="p-4 lg:col-span-1">
        <p className="text-[10px] uppercase tracking-wider text-terminal-muted">Conventions</p>
        {conventions.isPending ? (
          <p className="mt-2 text-[11px] text-terminal-muted">Loading…</p>
        ) : conventions.isError || conventions.data === undefined ? (
          <p className="mt-2 text-[11px] text-terminal-short">Could not load the conventions.</p>
        ) : (
          <dl className="mt-2 space-y-3 text-[11px]">
            <div>
              <dt className="text-terminal-muted">Authentication</dt>
              <dd className="text-terminal-text">
                <code className="font-mono">
                  {conventions.data.authentication.header}: {conventions.data.authentication.scheme}{' '}
                  …
                </code>
                <ul className="mt-1 list-disc pl-4 text-terminal-muted">
                  {conventions.data.authentication.credentials.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt className="text-terminal-muted">Idempotency</dt>
              <dd className="text-terminal-text">
                <code className="font-mono">{conventions.data.idempotency.header}</code> on{' '}
                {conventions.data.idempotency.requiredOn}.{' '}
                <span className="text-terminal-muted">
                  {conventions.data.idempotency.semantics}.
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-terminal-muted">Webhook signatures</dt>
              <dd className="text-terminal-text">
                <code className="font-mono">
                  {conventions.data.webhooks.signatureHeader}: t=&lt;unix seconds&gt;,
                  {conventions.data.webhooks.scheme}=&lt;{conventions.data.webhooks.algorithm}&gt;
                </code>
                <p className="mt-1 text-terminal-muted">
                  Signed over{' '}
                  <code className="font-mono">{conventions.data.webhooks.signedOver}</code> — the
                  raw bytes, not re-serialised JSON. Refuse a delivery whose{' '}
                  <code className="font-mono">t</code> is more than{' '}
                  {conventions.data.webhooks.recommendedToleranceSeconds} seconds from your clock;
                  compare in constant time; accept if any <code className="font-mono">v1</code>{' '}
                  matches (there are two during a rotation). Answer 2xx; a redirect is a failure.
                </p>
              </dd>
            </div>
            <div>
              <dt className="text-terminal-muted">What an API key may hold</dt>
              <dd className="font-mono text-[10px] leading-relaxed text-terminal-text">
                {conventions.data.keyablePermissions.join(' · ')}
              </dd>
            </div>
            <div>
              <dt className="text-terminal-muted">What a service token may hold</dt>
              <dd className="font-mono text-[10px] leading-relaxed text-terminal-text">
                {conventions.data.serviceGrantablePermissions.join(' · ')}
              </dd>
            </div>
          </dl>
        )}
      </Panel>

      <Panel className="p-4 lg:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-terminal-muted">
              {document.data?.info?.title ?? 'Routes'}
              {document.data?.info?.version ? ` · ${document.data.info.version}` : ''}
            </p>
            <p className="mt-1 text-[11px] text-terminal-muted">
              {operations.length} routes, from the document the server built at boot. Which of them
              your credential may call is decided by the server on every request.
            </p>
          </div>
          <input
            className={cn(inputClass, 'w-56 py-1 text-xs')}
            placeholder="Filter by path, tag or summary"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>

        {document.isPending ? (
          <p className="mt-3 text-[11px] text-terminal-muted">Loading…</p>
        ) : document.isError ? (
          <p className="mt-3 text-[11px] text-terminal-short">Could not load the API document.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {tags.map((tag) => (
              <section key={tag}>
                <h3 className="text-[10px] uppercase tracking-wider text-terminal-muted">{tag}</h3>
                <ul className="mt-1 divide-y divide-terminal-border">
                  {shown
                    .filter((op) => op.tag === tag)
                    .map((op) => (
                      <li
                        key={`${op.method} ${op.path}`}
                        className="flex items-start gap-3 py-1.5 text-[11px]"
                      >
                        <span
                          className={cn(
                            'w-14 shrink-0 font-mono font-medium',
                            METHOD_TONE[op.method] ?? '',
                          )}
                        >
                          {op.method}
                        </span>
                        <code className="w-72 shrink-0 break-all font-mono text-terminal-text">
                          {op.path}
                        </code>
                        <span
                          className={cn(
                            'min-w-0 flex-1 text-terminal-muted',
                            op.deprecated ? 'line-through' : '',
                          )}
                        >
                          {op.summary}
                        </span>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
