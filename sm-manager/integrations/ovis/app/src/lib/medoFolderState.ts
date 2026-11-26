import { useEffect, useState } from 'react';

const KEY = 'ovis:project-folders:v1';

function load(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  } catch { return new Set(); }
}

/** Folders start closed; only explicit navigation changes the saved expansion. */
export function useMedoFolderState() {
  const [open, setOpen] = useState(load);
  useEffect(() => {
    const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) setOpen(load()); };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, []);
  useEffect(() => {
    try {
      const value = JSON.stringify([...open]);
      if (window.localStorage.getItem(KEY) !== value) window.localStorage.setItem(KEY, value);
    } catch { /* Expansion still works for this visit when browser storage is unavailable. */ }
  }, [open]);
  return [open, setOpen] as const;
}
