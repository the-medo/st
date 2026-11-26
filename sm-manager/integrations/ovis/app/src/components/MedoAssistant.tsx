import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api-request-id.ts";
type State = {
  id: string;
  thread: string;
  status: string;
  device: string;
  events: { seq: number; kind: string; text: string }[];
};
export function MedoAssistant({
  id,
  disabled,
  onChange,
}: {
  id: string;
  disabled: boolean;
  onChange: (state: State) => void;
}) {
  const [state, setState] = useState<State | null>(null),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const receipt = useRef({ key: "", nonce: "" });
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let closed = false,
      pending = false;
    const abort = new AbortController();
    const poll = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const response = await apiFetch(
          `/api/medo/assistant?thread=${encodeURIComponent(id)}`,
          {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
          },
        );
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error?.message || "Assistant unavailable");
        if (!closed && !value) setError("This conversation is not linked to an assistant request.");
        if (!closed && value) {
          setState(value);
          changed.current(value);
        }
      } catch (cause) {
        if (!closed)
          setError(
            cause instanceof Error ? cause.message : "Assistant unavailable",
          );
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      closed = true;
      abort.abort();
      clearInterval(timer);
    };
  }, [id]);
  const question =
    state?.status === "waiting"
      ? [...state.events].reverse().find((e) => e.kind === "question")
      : undefined;
  const active =
    !!state && ["queued", "running", "waiting"].includes(state.status);
  const act = async (action: "send" | "answer" | "stop") => {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    const key = JSON.stringify([
      action,
      action === "answer" ? question?.seq : null,
      text,
    ]);
    if (receipt.current.key !== key)
      receipt.current = { key, nonce: crypto.randomUUID() };
    try {
      const response = await apiFetch("/api/medo/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          threadId: id,
          job: state.id,
          question: question?.seq,
          text,
          nonce: receipt.current.nonce,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Could not send this request");
      if (action !== "stop") setText("");
      receipt.current = { key: "", nonce: "" };
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send this request",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="medo-assistant" aria-label="Assistant follow-up">
      <p role="status">
        {state
          ? `${state.status === "waiting" ? "Waiting for your answer" : state.status} · replies stay with ${state.device}`
          : "Connecting to the assistant…"}
      </p>
      {error && <p role="alert">{error}</p>}
      {question && <p>{question.text}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(question ? "answer" : "send");
        }}
      >
        <label htmlFor="assistant-followup">
          {question ? "Your answer" : "Continue this conversation"}
        </label>
        <textarea
          id="assistant-followup"
          value={text}
          maxLength={32000}
          onChange={(e) => setText(e.target.value)}
          placeholder="Actually, move that to tomorrow…"
          disabled={disabled || busy || !state || (active && !question)}
          rows={2}
        />
        <div>
          <button
            disabled={
              disabled ||
              busy ||
              !state ||
              !text.trim() ||
              (active && !question)
            }
          >
            {busy ? "Sending…" : question ? "Answer" : "Send follow-up"}
          </button>
          {active && (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void act("stop")}
            >
              Stop request
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
