import { createContext } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";

export interface ResourceActivity {
  paneId: string;
  machineId: string;
  turns: readonly ConversationTurn[];
  more: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
}
export const ResourceActivityContext = createContext<((activity: ResourceActivity) => void) | null>(null);

export function usedResources(turns: readonly ConversationTurn[]) {
  const skills = new Map<string, { name: string; path?: string; status: string }>();
  const calls = new Map<string, { server: string; tool: string; status: string }>();
  for (const [turnIndex, turn] of turns.entries()) {
    for (const [partIndex, part] of turn.parts.entries()) {
      if (part.kind !== "skill" && part.kind !== "tool") continue;
      if (part.skill) skills.set(part.skill.path ?? part.skill.name, part.skill);
      if (part.kind === "tool" && part.mcp) calls.set(part.call_id ?? `${turnIndex}:${partIndex}`, part.mcp);
    }
  }
  const servers = new Map<string, { name: string; calls: number; failed: number; pending: number; tools: Set<string> }>();
  for (const call of calls.values()) {
    const server = servers.get(call.server) ?? { name: call.server, calls: 0, failed: 0, pending: 0, tools: new Set<string>() };
    server.calls++;
    server.failed += Number(call.status === "failed");
    server.pending += Number(call.status === "inProgress");
    server.tools.add(call.tool);
    servers.set(call.server, server);
  }
  return { skills: [...skills.values()], servers: [...servers.values()] };
}
