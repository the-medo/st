type BadgeNavigator = {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** Serialize writes so a slow older count cannot replace a newer clear. */
export function createAppBadge(target: BadgeNavigator) {
  let desired: number | null = null;
  let applied: number | null = null;
  let running: Promise<void> | null = null;
  return (count: number | null): Promise<void> => {
    // An unavailable snapshot is not evidence that everything was read.
    if (count === null || !Number.isSafeInteger(count) || count < 0 || !target.setAppBadge)
      return Promise.resolve();
    desired = count;
    if (running) return running;
    running = (async () => {
      while (desired !== applied) {
        const next = desired!;
        try {
          if (next === 0 && target.clearAppBadge) await target.clearAppBadge();
          else await target.setAppBadge!(next);
          applied = next;
        } catch {
          // Unsupported OS, denied permission or a transient browser failure:
          // leave the in-app count intact and retry on the next snapshot.
          break;
        }
      }
    })().finally(() => { running = null; });
    return running;
  };
}
