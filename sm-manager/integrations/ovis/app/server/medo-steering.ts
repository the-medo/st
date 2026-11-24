import { medoCall } from "./medo.ts";

interface SteeringHistory {
  thread: { id: string };
  turns: { id: string; status?: string; items: { id: string; role?: string; text?: string }[] }[];
}

/** Bind confirmation to the active exchange before Enter, including messages already in it. */
export async function captureMedoSteering(paneId: string, text: string,
  read: (payload: Record<string, unknown>) => Promise<SteeringHistory | null> = (payload) => medoCall(payload, 1000),
): Promise<(() => Promise<boolean>) | undefined> {
  if (process.env["MEDO_PROJECTS"] !== "1") return undefined;
  try {
    const before = await read({ operation: "conversation", paneId });
    const turn = before?.turns.slice().reverse().find((turn) => turn.status === "inProgress");
    if (!before || !turn) return undefined;
    const seen = new Set(turn.items.map((item) => item.id));
    return async () => {
      try {
        const after = await read({ operation: "conversation", paneId });
        if (after?.thread.id !== before.thread.id) return false;
        return after.turns.find((item) => item.id === turn.id)?.items.some((item) =>
          item.role === "user" && !!item.id && !seen.has(item.id) && item.text?.trim() === text.trim()) === true;
      } catch { return false; }
    };
  } catch { return undefined; }
}
