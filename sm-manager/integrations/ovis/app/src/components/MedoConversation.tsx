import { useState } from "react";
import { MedoAssistant } from "./MedoAssistant.tsx";
import type { MedoChat } from "../../shared/medo.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { ChatView } from "./ChatView.tsx";

export function MedoConversation({
  id,
  chat,
  loading,
}: {
  id: string;
  chat?: MedoChat;
  loading: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [active, setActive] = useState(false);
  return (
    <main
      className="medo-conversation-page"
      aria-label={chat?.title || "Saved conversation"}
    >
      <div className="medo-conversation-notice" role="status">
        {loading
          ? "Loading conversation…"
          : !chat
            ? "This saved conversation is no longer available."
            : chat.assistant
              ? "S.T. assistant · continue below"
              : chat.unavailable ||
                (chat.archived
                  ? "This conversation is archived. Saved history is read-only."
                  : !chat.paneId
                    ? "Terminal ended · Saved history is read-only."
                    : "Saved history is read-only.")}
      </div>
      {chat && (
        <MachineContext.Provider value="local">
          <div className="medo-reader-body">
            <ChatView
              key={id}
              paneId={`medo:${id}`}
              refreshKey={revision}
              connected
              ended={
                chat.assistant
                  ? !active
                  : !!chat.unavailable || chat.archived || !chat.paneId
              }
              agent={chat.provider ?? 'codex'}
              watching
              cwd={chat.cwd}
            />
          </div>
        </MachineContext.Provider>
      )}
      {chat?.assistant && (
        <MedoAssistant
          key={id}
          id={id}
          disabled={!!chat.unavailable || chat.archived}
          onChange={(state) => {
            setRevision(state.events.at(-1)?.seq ?? 0);
            setActive(["queued", "running", "waiting"].includes(state.status));
          }}
        />
      )}
    </main>
  );
}
