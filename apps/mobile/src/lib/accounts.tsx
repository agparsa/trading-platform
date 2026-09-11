import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from './session';
import { resolveSelection, type SelectableAccount } from './account-selection';

/**
 * The account every screen acts on, in one place.
 *
 * Three screens used to fetch `/accounts` for themselves and take the first
 * one. That is three requests for one answer, and — worse — three chances for
 * them to disagree: the ticket could be on the account the orders tab was not.
 * Loading it once and sharing the choice is what makes "the account" a thing
 * the app has rather than a thing each screen decides.
 *
 * The choice is **not persisted across launches**. It could be: the only store
 * this app has is `expo-secure-store`, which is for secrets, and a preference
 * does not belong in it. Adding a storage module to an app that has never run
 * on a device (§105) would be a change nobody could verify, so the honest
 * version is a choice that lasts as long as the app does, and this note so the
 * next person knows it was a decision rather than an oversight.
 */
export interface Account extends SelectableAccount {
  readonly id: string;
  readonly number: string;
  readonly currency: string;
}

interface AccountsValue {
  readonly accounts: readonly Account[];
  /** The account to act on, or null while loading or when there are none. */
  readonly selected: Account | null;
  readonly loading: boolean;
  readonly error: string | null;
  select(id: string): void;
  reload(): Promise<void>;
}

const AccountsContext = createContext<AccountsValue | null>(null);

export function AccountsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { api, signedIn } = useSession();
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!signedIn) {
      setAccounts([]);
      setLoading(false);
      return;
    }
    try {
      setAccounts(await api.get<Account[]>('/accounts'));
      setError(null);
    } catch {
      // The list is left as it was: a failed refresh should not empty a screen
      // that was working a second ago.
      setError('Could not load your accounts.');
    } finally {
      setLoading(false);
    }
  }, [api, signedIn]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo<AccountsValue>(
    () => ({
      accounts,
      // Re-resolved on every render of the list rather than stored, so an
      // account that disappears cannot leave a screen pointing at it.
      selected: resolveSelection(accounts, requestedId),
      loading,
      error,
      select: setRequestedId,
      reload,
    }),
    [accounts, requestedId, loading, error, reload],
  );

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): AccountsValue {
  const value = useContext(AccountsContext);
  if (value === null) throw new Error('useAccounts must be used inside an AccountsProvider');
  return value;
}
