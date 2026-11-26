import type { MedoChat } from "../../../../integrations/ovis/app/shared/medo";
import type { MedoReadState } from "../../../../integrations/ovis/app/src/lib/medoReadState";

export type AgentCounts = {
  working: number;
  unread: number;
  attention: number;
};

/** Count conversations once; user-completed and archived work is out of the inbox. */
export function countAgentActivity(
  chats: readonly MedoChat[],
  read: MedoReadState,
): AgentCounts {
  const counts = { working: 0, unread: 0, attention: 0 };
  for (const chat of chats) {
    if (chat.archived || chat.done) continue;
    if (chat.status === "blocked") counts.attention++;
    else if (chat.status === "working") counts.working++;
    else if (
      (!chat.status || chat.status === "idle" || chat.status === "done") &&
      read.get(chat.id)?.unread
    )
      counts.unread++;
  }
  return counts;
}

export function agentActivityLabel(
  counts: AgentCounts | null,
  unavailable: boolean,
) {
  if (!counts)
    return unavailable ? "Agent status unavailable" : "Checking agent activity";
  const summary = `${counts.working} working, ${counts.unread} finished and unread, ${counts.attention} need attention`;
  return unavailable
    ? `Last known agent activity: ${summary}. Status updates unavailable.`
    : summary;
}
