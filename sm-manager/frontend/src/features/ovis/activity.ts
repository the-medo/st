import type { MedoChat } from "../../../../integrations/ovis/app/shared/medo";
import { medoActivityOf, type MedoReadState } from "../../../../integrations/ovis/app/src/lib/medoReadState";

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
    const activity = medoActivityOf(chat, read);
    const status = activity?.status ?? chat.status;
    if (status === "blocked") counts.attention++;
    else if (status === "working") counts.working++;
    else if (
      (!status || status === "idle" || status === "done") &&
      activity?.unread
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
