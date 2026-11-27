import { useEffect, useRef, useState } from 'react';
import type { MedoDefaults, MedoProvider } from '../../shared/medo.ts';
import { apiFetch } from './api-request-id.ts';

/** Resolve both the inherited model and the selected model's inherited effort. */
export function useMedoDefaults(provider: MedoProvider, projectId: string, cwd: string, model: string, enabled: boolean) {
  const [values, setValues] = useState<Record<string, MedoDefaults | null>>({});
  const cache = useRef<Record<string, MedoDefaults | null>>({});
  const query = (selected: string) => new URLSearchParams({ provider, model: selected,
    ...(projectId ? { projectId } : { cwd: cwd.trim() }) }).toString();
  const baselineKey = query('');
  const selectedKey = query(model);
  useEffect(() => {
    if (!enabled || (!projectId && !cwd.trim())) return;
    const controller = new AbortController();
    // Coalesce edits to custom directory/model fields before starting a native CLI read.
    const timer = setTimeout(() => {
      for (const key of new Set([baselineKey, selectedKey])) {
        if (Object.hasOwn(cache.current, key)) continue;
        void apiFetch(`/api/medo/defaults?${key}`, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error('Defaults unavailable');
          return await response.json() as MedoDefaults;
        }).catch(() => null).then((value) => {
          if (controller.signal.aborted) return;
          cache.current[key] = value;
          setValues((current) => ({ ...current, [key]: value }));
        });
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [provider, projectId, cwd, baselineKey, selectedKey, enabled]);
  return { baseline: values[baselineKey], selected: values[selectedKey] };
}
