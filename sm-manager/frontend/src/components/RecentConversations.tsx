import { useEffect, useRef, useSyncExternalStore } from "react";
import { History, MessageSquare, Terminal, X } from "lucide-react";
import { AgentMark } from "../../../integrations/ovis/app/src/components/AgentMark";
import {
  recentDetails,
  recentStatusLabels,
  subscribeRecent,
  recentRevision,
} from "../features/ovis/shortcuts";
import type { RecentPicker } from "../app/useSidebarShortcuts";

export function RecentConversations({
  picker,
  onOpen,
  onClose,
}: {
  picker: RecentPicker;
  onOpen: (index: number) => void;
  onClose: () => void;
}) {
  useSyncExternalStore(subscribeRecent, recentRevision);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = document.activeElement as HTMLIFrameElement | null;
    const previous = (
      frame?.tagName === "IFRAME" ? frame.contentDocument?.activeElement : frame
    ) as HTMLElement | null;
    list.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [picker.index]);
  return (
    <div
      className="st-recent-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="st-recent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Recent conversations and terminals"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            list.current?.focus();
          }
        }}
      >
        <header>
          <History size={17} />
          <h2>Jump back in</h2>
          <button aria-label="Close recent items" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <p className="st-recent-description">
          Recent conversations & terminals across all windows
        </p>
        {picker.error && <p className="st-recent-description" role="status">Couldn’t sync recent items. Showing this window’s last known list.</p>}
        <div
          className="st-recent-list"
          ref={list}
          role="listbox"
          tabIndex={0}
          aria-label="Recent items"
          aria-activedescendant={
            picker.items.length ? `st-recent-${picker.index}` : undefined
          }
        >
          {picker.items.map((entry, index) => {
            const item = recentDetails(entry);
            return (
              <button
                key={item.id}
                id={`st-recent-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === picker.index}
                aria-disabled={!item.available}
                onClick={() => {
                  if (item.available) onOpen(index);
                }}
              >
                {item.view === "terminal" ? (
                  <Terminal size={18} />
                ) : (
                  <MessageSquare size={18} />
                )}
                <span className="st-recent-copy">
                  <strong>{item.title}</strong>
                  <small>
                    {item.workspace} ·{" "}
                    {item.view === "terminal" ? "Terminal" : "Conversation"}
                    <span className={`st-recent-status is-${item.status}`}>
                      <i aria-hidden="true" />
                      {recentStatusLabels[item.status]}
                    </span>
                  </small>
                </span>
                <span className="st-recent-trailing">
                  {index === picker.index && item.available && <kbd>↵</kbd>}
                  {item.agent && <AgentMark agent={item.agent} size={20} />}
                </span>
              </button>
            );
          })}
          {picker.loading && <p className="st-recent-empty" role="status">Loading recent items…</p>}
          {!picker.loading && !picker.items.length && (
            <p className="st-recent-empty">
              Your conversations and terminals will appear here as you open
              them.
            </p>
          )}
        </div>
        <footer>
          <span>
            <kbd>E</kbd> / <kbd>↓</kbd> next
          </span>
          <span>
            <kbd>⇧ E</kbd> / <kbd>↑</kbd> previous
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> cancel
          </span>
        </footer>
      </section>
    </div>
  );
}
