import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
import {
  observeSharedMedoChats,
  MEDO_READ_EVENT,
  useMedoReadSnapshot,
} from "../../../../integrations/ovis/app/src/lib/medoReadState";
import { usePoll } from "../../lib/api";
import { agentsCatalog, subscribeRecent } from "./shortcuts";
import { countAgentActivity } from "./activity";
import { createAppBadge } from "./appBadge";

export function useAgentActivity(enabled: boolean, active: boolean) {
  const hosted = useSyncExternalStore(subscribeRecent, agentsCatalog);
  // Keep receiving the server's state on every page and while minimized. This
  // reads only the catalogue; it never opens a conversation or resumes an agent.
  const background = usePoll<MedoCatalog>(
    enabled ? "/agents/api/medo/catalog" : null,
    5000,
    true,
    true,
  );
  const catalog =
    hosted && hosted.at >= background.at ? hosted.data : background.data;
  const read = useMedoReadSnapshot();
  useEffect(() => {
    if (enabled && catalog) observeSharedMedoChats(catalog.chats);
  }, [enabled, catalog]);
  useEffect(() => {
    window.addEventListener(MEDO_READ_EVENT, background.refresh);
    return () => window.removeEventListener(MEDO_READ_EVENT, background.refresh);
  }, [background.refresh]);
  const counts = enabled && catalog ? countAgentActivity(catalog.chats, read) : null;
  const unavailable = !!background.error || (active && hosted?.unavailable === true);
  const badge = useMemo(() => createAppBadge(navigator), []);
  useEffect(() => { void badge(unavailable ? null : counts?.unread ?? null); }, [badge, counts?.unread, unavailable, catalog]);
  return {
    counts,
    unavailable,
  };
}
