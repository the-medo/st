import { useState } from "react";
import { api, usePoll } from "../lib/api";
import { Notice, Panel } from "../components/Ui";
type Night = {
  available: boolean;
  night_mode: boolean;
  mode: string;
  token: string;
  error?: string;
};
export function Faceplate() {
  const frame = usePoll<{ timestamp: number; image: string } | null>(
    "/api/faceplate",
    2000,
  );
  const night = usePoll<Night>("/api/night-mode", 5000);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = async () => {
    if (!night.data || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Night>("/api/night-mode", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SM-Token": night.data.token,
        },
        body: JSON.stringify({ action: night.data.night_mode ? "off" : "on" }),
      });
      if (result.error) throw new Error(result.error);
      night.refresh();
    } catch (e) {
      setError(String(e));
      night.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel
      title="Faceplate"
      actions={
        <button
          role="switch"
          aria-checked={night.data?.night_mode ?? false}
          disabled={busy || !night.data?.available || !!night.error}
          onClick={() => void change()}
        >
          {busy
            ? "Changing screen power…"
            : `Night mode ${night.data?.night_mode ? "on" : "off"}`}
        </button>
      }
    >
      {(error || night.error || night.data?.error) && (
        <Notice retry={night.refresh}>
          {error || night.error || night.data?.error}
        </Notice>
      )}
      <p>
        <small>
          {night.data?.available
            ? `${night.data.night_mode ? "Faceplate off" : "Faceplate on"} · ${night.data.mode} mode`
            : "Screen power unavailable"}
        </small>
      </p>
      {frame.error && (
        <Notice retry={frame.refresh}>
          Display connection unavailable. Any visible image is the last capture.
        </Notice>
      )}
      {frame.data ? (
        <>
          <p>
            <small>
              {Date.now() / 1000 - frame.data.timestamp > 10
                ? "Last known frame"
                : "Live"}{" "}
              · {new Date(frame.data.timestamp * 1000).toLocaleString()}
            </small>
          </p>
          <img
            className="st-faceplate"
            src={frame.data.image}
            alt="Most recent frame from the front touchscreen"
          />
        </>
      ) : (
        <Notice>Waiting for the first capture from the front screen.</Notice>
      )}
    </Panel>
  );
}
