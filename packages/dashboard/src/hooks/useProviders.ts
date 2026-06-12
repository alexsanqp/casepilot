import { useEffect, useState } from 'react';
import { errorMessage, getProviders } from '../api/client';
import type { ProvidersResponse } from '../api/types';

export function useProviders(projectId: string): {
  providers: ProvidersResponse | null;
  providersError: string | null;
} {
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProviders(projectId)
      .then((result) => {
        if (cancelled) return;
        setProviders(result);
        setProvidersError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProviders(null);
        setProvidersError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { providers, providersError };
}
