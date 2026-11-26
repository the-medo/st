import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, ago, usePoll } from "../lib/api";
import { Notice, Panel } from "../components/Ui";
import "./assistant.css";

type Device = {
  device: string;
  seen: number;
  revision: number;
  settings: { microphone?: string; speaker?: string; muted?: boolean };
  report: {
    state?: string;
    muted?: boolean;
    speaking?: boolean;
    queue?: number;
    revision?: number;
    inputs?: string[];
    outputs?: string[];
    microphone?: string;
    speaker?: string;
    errors?: { source: string; message: string }[];
    test_recording?: { id: string; text: string; status: string };
  };
};
type Snapshot = {
  available: boolean;
  error?: string;
  worker_online: boolean;
  token: string;
  now: number;
  router?: { status?: string; checked_at?: number };
  devices: Device[];
  commands: {
    id: string;
    device: string;
    action: string;
    created: number;
    result?: { status: string; message: string };
  }[];
  requests: {
    id: string;
    device: string;
    text: string;
    status: string;
    thread?: string;
    updated: number;
  }[];
};
const routing: Record<string, string> = {
  classified: "Connected",
  uncertain: "Connected · general routing for the last request",
  provider_error: "Cloudflare unavailable · using general routing",
  invalid_or_unavailable: "Connection failed · using general routing",
  input_budget: "Long request · using general routing",
  busy: "Routing busy · using general routing",
  catalog_unavailable: "Routing setup needs attention · using general routing",
  configured_not_yet_called: "Token configured · awaiting a request",
  authentication: "Token rejected · replace the Cloudflare token on the host",
  missing_or_invalid_credentials: "Cloudflare credentials need attention",
  rate_limit: "Rate limited · using general routing",
  backoff: "Backing off · using general routing",
  timeout: "Timed out · using general routing",
  disabled: "Routing disabled",
};

function DeviceCard({
  device,
  now,
  busy,
  change,
}: {
  device: Device;
  now: number;
  busy: boolean;
  change: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [mic, setMic] = useState(""),
    [speaker, setSpeaker] = useState("");
  useEffect(() => {
    setMic(device.settings.microphone ?? device.report.microphone ?? "");
    setSpeaker(device.settings.speaker ?? device.report.speaker ?? "");
  }, [device.revision, device.device]);
  const online = device.seen > 0 && now - device.seen < 15;
  const muted =
    online && (device.report.revision ?? 0) >= device.revision
      ? !!device.report.muted
      : (device.settings.muted ?? device.report.muted ?? false);
  const ready =
    online &&
    device.report.state === "idle" &&
    !device.report.muted &&
    !device.report.speaking;
  const command = (action: string) =>
    change({ action, device: device.device, id: crypto.randomUUID() });
  const select = (
    label: string,
    value: string,
    set: (s: string) => void,
    names: string[] = [],
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">System default</option>
        {[...new Set([...names, ...(value ? [value] : [])])].map((name) => (
          <option key={name} value={name}>
            {name}
            {!names.includes(name) ? " (unavailable)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Panel
      title={device.device === "room" ? "Steam Machine" : "Windows PC"}
      className="assistant-device"
    >
      <p role="status">
        <strong>
          {!online
            ? device.seen
              ? "Offline"
              : "Not connected"
            : device.report.muted
              ? "Muted"
              : device.report.speaking
                ? "Speaking"
                : device.report.state === "offline"
                  ? "Microphone unavailable"
                  : device.report.state === "idle"
                    ? "Listening for Hey ST / Okay ST"
                    : device.report.state}
        </strong>{" "}
        · {device.report.queue ?? 0} unsent
      </p>
      {!online && (
        <p>
          {device.seen
            ? `Last connected ${ago(device.seen)}. Settings apply when it reconnects.`
            : "Start the paired ST voice client on this device to see its microphones and speakers."}
        </p>
      )}
      {online && (device.report.revision ?? 0) < device.revision && (
        <p role="status">Applying saved settings…</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void change({
            action: "settings",
            device: device.device,
            revision: device.revision,
            settings: { microphone: mic, speaker },
          });
        }}
      >
        <div className="assistant-fields">
          {select("Microphone", mic, setMic, device.report.inputs)}
          {select("Speaker", speaker, setSpeaker, device.report.outputs)}
        </div>
        <button disabled={busy}>Save audio devices</button>
      </form>
      <div className="assistant-actions">
        <button
          disabled={busy}
          onClick={() =>
            void change({
              action: "settings",
              device: device.device,
              revision: device.revision,
              settings: { muted: !muted },
            })
          }
        >
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          disabled={busy || !ready}
          onClick={() => void command("record")}
        >
          Dictate a request
        </button>
        <button disabled={busy || !online} onClick={() => void command("stop")}>
          Stop
        </button>
      </div>
      <p className="assistant-help">
        Dictation uses this device’s microphone without a wake phrase. Pause to
        send; Stop cancels pending work and speech.
      </p>
      <div className="assistant-actions">
        <button
          disabled={busy || !ready}
          onClick={() => void command("test_recording")}
        >
          Test microphone
        </button>
        <button
          disabled={
            busy ||
            !online ||
            device.report.speaking ||
            !["idle", "offline"].includes(device.report.state ?? "")
          }
          onClick={() => void command("test_speaker")}
        >
          Test speaker
        </button>
      </div>
      <p className="assistant-help">
        The microphone test shows a transcript here without sending a request to
        an agent. Raw audio is not saved.
      </p>
      {device.report.test_recording && (
        <blockquote aria-label="Microphone test result">
          {device.report.test_recording.status === "empty"
            ? "No speech detected. Try again closer to the microphone."
            : device.report.test_recording.text}
        </blockquote>
      )}
      {device.report.errors?.map((error) => (
        <Notice key={error.source}>
          {error.source}: {error.message}
        </Notice>
      ))}
    </Panel>
  );
}

export function Assistant() {
  const snapshot = usePoll<Snapshot>("/api/assistant", 2000);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const data = snapshot.data;
  const retry = useRef({ key: "", id: "" });
  const change = async (body: Record<string, unknown>) => {
    if (!data || busy) return;
    setBusy(true);
    setError("");
    if (body.id) {
      const key = JSON.stringify({ ...body, id: undefined });
      if (retry.current.key !== key)
        retry.current = { key, id: String(body.id) };
      body = { ...body, id: retry.current.id };
    }
    try {
      await api("/api/assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SM-Token": data.token,
        },
        body: JSON.stringify(body),
      });
      retry.current = { key: "", id: "" };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
    } finally {
      setBusy(false);
      snapshot.refresh();
    }
  };
  return (
    <div className="assistant-page">
      <Panel
        title="Voice assistant"
        actions={<button onClick={snapshot.refresh}>Refresh</button>}
      >
        <p>Manage your listening devices, test audio, and follow requests.</p>
        {(error || snapshot.error || data?.error) && (
          <Notice retry={snapshot.refresh}>
            {error || snapshot.error || data?.error}
          </Notice>
        )}
        {data?.available && (
          <div className="assistant-health">
            <p>
              <strong>Assistant</strong>
              <br />
              {data.worker_online
                ? "Ready"
                : "Worker unavailable · queued requests will wait"}
            </p>
            <p>
              <strong>Cloudflare routing</strong>
              <br />
              {routing[data.router?.status ?? ""] ??
                (data.router?.status === "unknown"
                  ? "No connection result yet"
                  : `General routing · ${data.router?.status ?? "unknown"}`)}
              <br />
              <small>
                {data.router?.checked_at
                  ? `Last check ${ago(data.router.checked_at)}`
                  : ""}
              </small>
            </p>
          </div>
        )}
      </Panel>
      {data?.available && (
        <>
          <div className="assistant-devices">
            {["room", "pc"].map((id) => (
              <DeviceCard
                key={id}
                device={
                  data.devices.find((d) => d.device === id) ?? {
                    device: id,
                    seen: 0,
                    revision: 0,
                    settings: {},
                    report: {},
                  }
                }
                now={data.now}
                busy={busy}
                change={change}
              />
            ))}
          </div>
          {data.commands.length > 0 && (
            <Panel title="Recent device actions">
              <ul>
                {data.commands.slice(0, 4).map((c) => (
                  <li key={c.id}>
                    {c.device === "pc" ? "Windows PC" : "Steam Machine"}:{" "}
                    {c.action.replaceAll("_", " ")} —{" "}
                    {c.result?.message ??
                      (data.now - c.created > 30
                        ? "Expired without confirmation"
                        : "Waiting for the device…")}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Recent requests">
            {!data.requests.length ? (
              <p>No assistant requests yet.</p>
            ) : (
              <div className="assistant-requests">
                {data.requests.map((r) => (
                  <article key={r.id}>
                    <strong>{r.text}</strong>
                    <p>
                      {r.status} · {r.device} · {ago(r.updated)}{" "}
                      {r.thread && (
                        <Link to={`/agents/chat/${r.thread}`}>
                          Open conversation
                        </Link>
                      )}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
