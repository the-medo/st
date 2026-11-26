import { useEffect, useSyncExternalStore } from "react";
import type { MedoCatalog } from "../../../../integrations/ovis/app/shared/medo";
import {
  observeSharedMedoChats,
  useMedoReadSnapshot,
} from "../../../../integrations/ovis/app/src/lib/medoReadState";
import { usePoll } from "../../lib/api";
import { agentsCatalog, subscribeRecent } from "./shortcuts";
import { countAgentActivity } from "./activity";

export function useAgentActivity(enabled: boolean, active: boolean) {
  const hosted = useSyncExternalStore(subscribeRecent, agentsCatalog);
  // The embedded view owns its catalog while active. Poll independently before
  // its first visit and on other pages without loading or opening any session.
  const background = usePoll<MedoCatalog>(
    enabled ? "/agents/api/medo/catalog" : null,
    8000,
    !active || !hosted,
  );
  const catalog =
    hosted && hosted.at >= background.at ? hosted.data : background.data;
  const read = useMedoReadSnapshot();
  useEffect(() => {
    if (enabled && !active && catalog)
      observeSharedMedoChats(catalog.chats, null);
  }, [enabled, active, catalog]);
  return {
    counts: enabled && catalog ? countAgentActivity(catalog.chats, read) : null,
    unavailable: active && hosted ? hosted.unavailable : !!background.error,
  };
}
