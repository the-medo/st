import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { ConversationResponse } from "../../../../integrations/ovis/app/shared/protocol";
import { Turn } from "../../../../integrations/ovis/app/src/components/ChatView";
import { SettingsProvider } from "../../../../integrations/ovis/app/src/lib/settings";
import { MachineContext } from "../../../../integrations/ovis/app/src/lib/machineContext";
import { ovisTheme } from "@st/theme/ovis";
import "@st/theme/ovis.css";
import "../../../../integrations/ovis/app/src/lib/builtins";
import "../../../../integrations/ovis/app/src/fonts/fonts.css";
import "../../../../integrations/ovis/app/src/styles.css";
import { Notice } from "../../components/Ui";

async function read(
  id: string,
  signal: AbortSignal,
  before?: string,
  history?: string,
) {
  const query = new URLSearchParams({ pane_id: `medo:${id}` });
  if (before) query.set("before", before);
  if (history) query.set("history_id", history);
  const response = await fetch(`/agents/api/medo/conversation?${query}`, {
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || "The original conversation is unavailable.",
    );
  if (data.unavailable)
    throw new Error(
      "The original conversation is unavailable. The artifact is still saved here.",
    );
  return data as ConversationResponse;
}

export default function OriginalConversation({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [page, setPage] = useState<ConversationResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const workmode = new URLSearchParams(location.search).get("workmode") === "1";
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    setPage(null);
    setError("");
    setBusy(true);
    void read(id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [id, retry]);
  const older = async () => {
    if (!page?.cursor || busy) return;
    setBusy(true);
    setError("");
    const oldHeight = body.current?.scrollHeight ?? 0;
    try {
      const next = await read(
        id,
        abort.current!.signal,
        page.cursor,
        page.history_id,
      );
      if (abort.current!.signal.aborted) return;
      setPage({ ...next, turns: [...next.turns, ...page.turns] });
      requestAnimationFrame(() => {
        if (body.current)
          body.current.scrollTop += body.current.scrollHeight - oldHeight;
      });
    } catch (error) {
      if (!abort.current!.signal.aborted)
        setError(
          error instanceof Error
            ? error.message
            : "Could not load older messages.",
        );
    } finally {
      if (!abort.current!.signal.aborted) setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      className="st-dialog artifact-conversation-dialog"
      aria-label="Original conversation"
      onCancel={close}
    >
      <header>
        <div>
          <h2>Original conversation</h2>
          <p>Saved history · Read-only</p>
        </div>
        <div className="artifact-actions">
          <a
            href={`/agents?saved=${encodeURIComponent(id)}${workmode ? "&workmode=1" : ""}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Agents
            <ExternalLink size={15} />
          </a>
          <button onClick={close} aria-label="Close original conversation">
            <X size={18} />
          </button>
        </div>
      </header>
      {error && (
        <Notice
          retry={() => (page ? void older() : setRetry((value) => value + 1))}
        >
          {error}
        </Notice>
      )}
      <div
        className="st-ovis-root artifact-conversation-body"
        data-st-host-theme={workmode ? "workmode" : "console"}
        ref={body}
      >
        <SettingsProvider
          hostAppearance={{
            entry: ovisTheme(workmode ? "workmode" : "console"),
            description: null,
          }}
        >
          <MachineContext.Provider value="local">
            {page?.cursor && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void older()}
              >
                {busy ? "Loading…" : "Load earlier messages"}
              </button>
            )}
            {!page && busy && <p role="status">Loading conversation…</p>}
            {page && !page.turns.length && (
              <p>No saved messages are available.</p>
            )}
            {page?.turns.map((turn, index) => (
              <Turn
                key={`${turn.turn_id ?? turn.ts}:${turn.role}:${index}`}
                paneId={`medo:${id}`}
                turn={turn}
                rowKey={`artifact-origin:${id}:${index}`}
                live={false}
                waiting={false}
                showThinking={false}
                foldWork
              />
            ))}
          </MachineContext.Provider>
        </SettingsProvider>
      </div>
    </dialog>
  );
}
