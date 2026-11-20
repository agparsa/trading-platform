'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  BRAND_BACKGROUND,
  BRAND_NAME_MAX,
  accentProblem,
  contrastRatio,
  isHexColour,
  type Branding,
} from '@tp/shared-types';
import { Button, Field, inputClass, wordInputClass } from '@/components/primitives';
import { useAdminBranding, useSaveBranding } from '@/lib/admin-queries';
import { ErrorLine, Loading } from './shared';

/** The platform's own accents — what an empty field means. */
const DEFAULT_ACCENT = { dark: '#5b9cff', light: '#1c5bc8' } as const;

interface Draft {
  name: string;
  accentDark: string;
  accentLight: string;
  supportEmail: string;
  websiteUrl: string;
}

function draftOf(branding: Branding): Draft {
  return {
    name: branding.name ?? '',
    accentDark: branding.accentDark ?? '',
    accentLight: branding.accentLight ?? '',
    supportEmail: branding.supportEmail ?? '',
    websiteUrl: branding.websiteUrl ?? '',
  };
}

/** An empty field is "the platform's own": sent as `null`, not as an empty string. */
function changeOf(draft: Draft): Partial<Branding> {
  const or = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    name: or(draft.name),
    accentDark: or(draft.accentDark.toLowerCase()),
    accentLight: or(draft.accentLight.toLowerCase()),
    supportEmail: or(draft.supportEmail),
    websiteUrl: or(draft.websiteUrl),
  };
}

/**
 * Branding: the name, the accent for each theme, and where a stuck person
 * finds help — what a visitor sees before and after signing in.
 *
 * Each accent is checked as it is typed, against the background it will be
 * drawn on, with the same rule the server applies: a colour that cannot be
 * read is refused, with its ratio, not saved and regretted. The preview draws
 * a link and a primary button in each theme with the colours as typed.
 */
export function BrandingPanel() {
  const branding = useAdminBranding();
  const save = useSaveBranding();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (branding.data !== undefined && draft === null) setDraft(draftOf(branding.data));
  }, [branding.data, draft]);

  const problems = useMemo(() => {
    if (draft === null) return { dark: null, light: null };
    const check = (value: string, theme: 'dark' | 'light') =>
      value.trim() === '' ? null : accentProblem(value.trim().toLowerCase(), theme);
    return { dark: check(draft.accentDark, 'dark'), light: check(draft.accentLight, 'light') };
  }, [draft]);

  if (branding.isLoading || (draft === null && branding.data !== undefined)) return <Loading />;
  if (branding.error !== null || draft === null) return <ErrorLine error={branding.error} />;

  const set = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setDraft({ ...draft, [field]: event.target.value });
  };
  const changed =
    branding.data !== undefined &&
    JSON.stringify(changeOf(draft)) !== JSON.stringify(changeOf(draftOf(branding.data)));
  const blocked = problems.dark !== null || problems.light !== null;

  return (
    <form
      className="grid items-start gap-4 p-4 lg:grid-cols-2"
      data-testid="branding"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || blocked) return;
        save.mutate(changeOf(draft), {
          onSuccess: (next) => {
            setDraft(draftOf(next));
            setSaved(true);
          },
        });
      }}
    >
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-terminal-text">Name and contact</h2>
        <Field label="Platform name">
          <input
            className={wordInputClass}
            value={draft.name}
            maxLength={BRAND_NAME_MAX}
            placeholder="Trading Platform"
            onChange={set('name')}
            data-testid="branding-name"
          />
        </Field>
        <p className="-mt-1 text-label text-terminal-muted">
          On the sign-in page, the menu, the terminal and the browser tab. Empty: “Trading
          Platform”.
        </p>
        <Field label="Support email">
          <input
            className={wordInputClass}
            type="email"
            value={draft.supportEmail}
            placeholder="support@example.com"
            onChange={set('supportEmail')}
            data-testid="branding-email"
          />
        </Field>
        <Field label="Website">
          <input
            className={wordInputClass}
            type="url"
            value={draft.websiteUrl}
            placeholder="https://example.com"
            onChange={set('websiteUrl')}
          />
        </Field>
        <p className="-mt-1 text-label text-terminal-muted">
          Shown as “Need help?” under the sign-in form and on the pages an emailed link opens.
        </p>

        <h2 className="pt-2 text-sm font-semibold text-terminal-text">Accent colour</h2>
        <p className="text-label leading-relaxed text-terminal-muted">
          Links, the selected tab and the main button. One per theme, because a colour that reads on
          dark rarely reads on light. Each must reach 4.5:1 against its background — the contrast
          text needs.
        </p>
        <AccentField
          theme="dark"
          value={draft.accentDark}
          problem={problems.dark}
          onChange={set('accentDark')}
        />
        <AccentField
          theme="light"
          value={draft.accentLight}
          problem={problems.light}
          onChange={set('accentLight')}
        />

        {save.error === null ? null : <ErrorLine error={save.error} />}
        {saved && !changed ? (
          <p className="text-caption text-terminal-long" role="status">
            Saved. Every page shows it within a minute.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            variant="neutral"
            gate={save}
            disabled={!changed || blocked || save.isPending}
            className="border-transparent bg-terminal-accent font-medium text-terminal-bg hover:opacity-90"
            data-testid="branding-save"
          >
            {save.isPending ? 'Saving…' : 'Save branding'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!changed}
            onClick={() => branding.data !== undefined && setDraft(draftOf(branding.data))}
          >
            Discard changes
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-terminal-text">Preview</h2>
        <Preview theme="dark" name={draft.name} accent={draft.accentDark} />
        <Preview theme="light" name={draft.name} accent={draft.accentLight} />
      </div>
    </form>
  );
}

function AccentField({
  theme,
  value,
  problem,
  onChange,
}: {
  theme: 'dark' | 'light';
  value: string;
  problem: string | null;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const hex = value.trim().toLowerCase();
  const shown = isHexColour(hex) ? hex : DEFAULT_ACCENT[theme];
  const ratio = contrastRatio(shown, BRAND_BACKGROUND[theme]);
  return (
    <div>
      <Field label={theme === 'dark' ? 'Dark theme' : 'Light theme'}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${theme} theme colour picker`}
            className="h-8 w-10 shrink-0 cursor-pointer rounded border border-terminal-border bg-transparent"
            value={shown}
            onChange={onChange}
          />
          <input
            className={inputClass}
            value={value}
            placeholder={`${DEFAULT_ACCENT[theme]} (default)`}
            onChange={onChange}
            data-testid={`branding-accent-${theme}`}
          />
        </div>
      </Field>
      <p
        className={
          problem === null
            ? 'mt-1 text-label text-terminal-muted'
            : 'mt-1 text-label text-terminal-short'
        }
        role={problem === null ? undefined : 'alert'}
      >
        {problem ?? `${ratio.toFixed(2)}:1 against the ${theme} background.`}
      </p>
    </div>
  );
}

/** A sliver of each theme, drawn with literal colours so it shows the draft, not the saved page. */
function Preview({
  theme,
  name,
  accent,
}: {
  theme: 'dark' | 'light';
  name: string;
  accent: string;
}) {
  const hex = accent.trim().toLowerCase();
  const colour = isHexColour(hex) ? hex : DEFAULT_ACCENT[theme];
  const page = BRAND_BACKGROUND[theme];
  const surface = theme === 'dark' ? '#12161d' : '#ffffff';
  const text = theme === 'dark' ? '#e6e9ef' : '#111720';
  const muted = theme === 'dark' ? '#8b94a3' : '#556070';
  return (
    <div
      className="rounded-lg border border-terminal-border p-4"
      style={{ background: page }}
      data-testid={`branding-preview-${theme}`}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-md text-caption font-semibold"
          style={{ background: colour, color: page }}
        >
          {(name.trim() === '' ? 'T' : name.trim()).slice(0, 1).toUpperCase()}
        </span>
        <span className="text-sm font-semibold" style={{ color: text }}>
          {name.trim() === '' ? 'Trading Platform' : name.trim()}
        </span>
        <span className="ms-auto text-label uppercase tracking-wider" style={{ color: muted }}>
          {theme}
        </span>
      </div>
      <div className="mt-3 space-y-2 rounded-md p-3" style={{ background: surface }}>
        <p className="text-caption" style={{ color: muted }}>
          Balance <span style={{ color: text }}>$10,000.00</span> ·{' '}
          <span style={{ color: colour }} className="underline">
            View history
          </span>
        </p>
        <span
          className="inline-block rounded px-3 py-1 text-caption font-medium"
          style={{ background: colour, color: page }}
        >
          Open terminal
        </span>
      </div>
    </div>
  );
}
