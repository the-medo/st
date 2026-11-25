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
              refreshKey={0}
              connected
              ended={!!chat.unavailable || chat.archived || !chat.paneId}
              agent="codex"
              watching
              cwd={chat.cwd}
            />
          </div>
        </MachineContext.Provider>
      )}
    </main>
  );
}
