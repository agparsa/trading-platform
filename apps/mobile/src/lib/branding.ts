import { useEffect, useState } from 'react';
import type { ApiClient } from '@tp/api-client';
import type { Branding } from '@tp/shared-types';

/**
 * The firm's branding, from the public `GET /branding` the web reads too.
 * The name and support contact only: the app's colours are compiled into its
 * theme, and a colour the server could change under a running app is a
 * colour nobody checked against it. Until the answer arrives, and if it
 * never does, the platform's own name stands — a missing brand is the
 * default look, never an error on the sign-in screen.
 */
export function useBranding(api: Pick<ApiClient, 'get'>): Branding | null {
  const [branding, setBranding] = useState<Branding | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<Branding>('/branding')
      .then((value) => {
        if (live) setBranding(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  return branding;
}

/** The firm's name when it has set one, else the platform's. */
export function brandName(branding: Branding | null, fallback: string): string {
  const name = branding?.name?.trim() ?? '';
  return name === '' ? fallback : name;
}
