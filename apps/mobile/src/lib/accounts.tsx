import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from './session';
import { resolveSelection, type SelectableAccount } from './account-selection';
import { rememberedAccount } from './remembered-account';
import { secureStore } from './secure-store';

const remembered = rememberedAccount(secureStore);

/**
 * The account every screen acts on, in one place.
 *
 * Three screens used to fetch `/accounts` for themselves and take the first
 * one. That is three requests for one answer, and — worse — three chances for
 * them to disagree: the ticket could be on the account the orders tab was not.
 * Loading it once and sharing the choice is what makes "the account" a thing
 * the app has rather than a thing each screen decides.
 *
 * The choice survives a relaunch (`remembered-account.ts`): it is read back
 * as a *request*, which `resolveSelection` still checks against the list the
 * server returns, and forgotten at sign-out. Until 29 October it lasted only
 * as long as the app did, because the app had never run on a phone to prove
 * a stored one worked.
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
      setRequestedId(null);
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

  // The last launch's choice, as a request. A choice made on this launch
  // before the keychain answers is newer, and wins.
  useEffect(() => {
    if (!signedIn) return;
    let current = true;
    void remembered.load().then((id) => {
      if (current && id !== null) setRequestedId((chosen) => chosen ?? id);
    });
    return () => {
      current = false;
    };
  }, [signedIn]);

  const select = useCallback((id: string) => {
    setRequestedId(id);
    void remembered.save(id);
  }, []);

  const value = useMemo<AccountsValue>(
    () => ({
      accounts,
      // Re-resolved on every render of the list rather than stored, so an
      // account that disappears cannot leave a screen pointing at it.
      selected: resolveSelection(accounts, requestedId),
      loading,
      error,
      select,
      reload,
    }),
    [accounts, requestedId, loading, error, select, reload],
  );

  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): AccountsValue {
  const value = useContext(AccountsContext);
  if (value === null) throw new Error('useAccounts must be used inside an AccountsProvider');
  return value;
}
