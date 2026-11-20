'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Branding } from '@tp/shared-types';
import { useSession } from '@/lib/session';
import { useT } from '@/lib/use-locale';

const NONE: Branding = {
  name: null,
  accentDark: null,
  accentLight: null,
  supportEmail: null,
  websiteUrl: null,
};

/**
 * The firm's branding, from `GET /branding` — public, so the sign-in page
 * wears it too. Until it answers, and if it cannot, the platform's own look
 * stands: a missing brand is the default look, never a broken page.
 */
export function useBranding(): Branding {
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Branding>('/branding'),
    staleTime: 5 * 60_000,
    retry: 0,
  });
  return query.data ?? NONE;
}

/** The name to show for the platform: the firm's, or the default. */
export function useBrandName(): string {
  const t = useT();
  return useBranding().name ?? t('shell.brand');
}

/**
 * The CSS that puts a firm's accents on its own theme each, and nothing when
 * there are none. Pure, so the selectors can be tested: the dark accent must
 * not leak into the light theme, which has its own contrast check.
 */
export function brandingCss(branding: Pick<Branding, 'accentDark' | 'accentLight'>): string {
  const rules: string[] = [];
  if (branding.accentDark !== null) {
    rules.push(`:root:not([data-theme='light']){--color-terminal-accent:${branding.accentDark}}`);
  }
  if (branding.accentLight !== null) {
    rules.push(`:root[data-theme='light']{--color-terminal-accent:${branding.accentLight}}`);
  }
  return rules.join('\n');
}

const STYLE_ID = 'tp-branding';

/**
 * Applies the branding to the document: the accent colours as CSS variables,
 * and the name in the tab's title. Rendered once, in the providers.
 */
export function BrandingSync() {
  const branding = useBranding();
  const name = useBrandName();
  useEffect(() => {
    const css = brandingCss(branding);
    let style = document.getElementById(STYLE_ID);
    if (css === '') {
      style?.remove();
    } else {
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = css;
    }
  }, [branding]);
  useEffect(() => {
    document.title = name;
  }, [name]);
  return null;
}

/**
 * "Need help?" with the firm's support address and website, where a person
 * who cannot sign in would look for them. Nothing at all when neither is set.
 */
export function SupportLine() {
  const t = useT();
  const { supportEmail, websiteUrl } = useBranding();
  if (supportEmail === null && websiteUrl === null) return null;
  return (
    <p className="mt-3 text-center text-label text-terminal-muted" data-testid="support-line">
      {t('brand.help')}{' '}
      {supportEmail === null ? null : (
        <a className="text-terminal-accent hover:underline" href={`mailto:${supportEmail}`}>
          {supportEmail}
        </a>
      )}
      {supportEmail !== null && websiteUrl !== null ? ' · ' : null}
      {websiteUrl === null ? null : (
        <a
          className="text-terminal-accent hover:underline"
          href={websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {new URL(websiteUrl).host}
        </a>
      )}
    </p>
  );
}
