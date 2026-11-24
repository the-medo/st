import { useCallback, useEffect, useState } from "react";
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data
        ? String(data.error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}
export function usePoll<T>(
  path: string | null,
  interval = 10000,
  active = true,
) {
  const [value, setValue] = useState<{
    path: string;
    data: T;
    at: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    if (!path || !active) return;
    let stopped = false;
    let pending = false;
    const abort = new AbortController();
    const fetchNow = async () => {
      if (document.hidden || pending || stopped) return;
      pending = true;
      try {
        const data = await api<T>(path, {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
        });
        if (!stopped) {
          setValue({ path, data, at: Date.now() });
          setError("");
        }
      } catch (cause) {
        if (!stopped)
          setError(
            cause instanceof Error ? cause.message : "Connection unavailable",
          );
      } finally {
        pending = false;
      }
    };
    setError("");
    void fetchNow();
    const timer = setInterval(() => void fetchNow(), interval);
    document.addEventListener("visibilitychange", fetchNow);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", fetchNow);
    };
  }, [path, interval, active, revision]);
  return {
    data: value?.path === path ? value.data : null,
    at: value?.at ?? 0,
    error,
    refresh,
  };
}
export const bytes = (n?: number | null) =>
  n == null
    ? "—"
    : n < 1024 ** 2
      ? `${Math.round(n / 1024)} KiB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MiB`
        : `${(n / 1024 ** 3).toFixed(1)} GiB`;
export const percent = (n?: number | null) =>
  n == null ? "—" : `${n.toFixed(1)}%`;
export const ago = (ts?: number | null) =>
  !ts
    ? "No recent activity"
    : new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        -Math.floor(Math.max(0, Date.now() / 1000 - ts) / 60),
        "minute",
      );
export function safeUrl(value?: string, protocols = ["https:", "http:"]) {
  try {
    const u = new URL(value ?? "");
    return protocols.includes(u.protocol) && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
