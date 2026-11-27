import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  File,
  FolderOpen,
  History,
  Layers,
  Pencil,
  Plus,
  Search,
  Share2,
} from "lucide-react";
import { api, bytes, usePoll } from "../../lib/api";
import { Modal, Notice } from "../../components/Ui";
import {
  agentsSelection,
  recentConversations,
  recentDetails,
  recentRevision,
  subscribeRecent,
} from "../ovis/shortcuts";
import {
  fileUrl,
  improvePrompt,
  type Artifact,
  type ArtifactDetail,
  type Checkout,
} from "./model";
import "./artifacts.css";

function Preview({ item, large = false }: { item: Artifact; large?: boolean }) {
  const url = item.preview_base
    ? item.preview_base +
      item.entrypoint.split("/").map(encodeURIComponent).join("/")
    : fileUrl(item.id, item.revision, item.entrypoint);
  if (item.mime === "text/html")
    return (
      <div className={large ? "artifact-page" : "artifact-thumbnail"}>
        <iframe
          src={url}
          title={`${item.title} preview`}
          loading="lazy"
          sandbox={large ? "allow-scripts" : ""}
          tabIndex={large ? 0 : -1}
        />
      </div>
    );
  if (item.mime.startsWith("image/"))
    return (
      <img
        className="artifact-image"
        src={url}
        alt={item.title}
        loading="lazy"
      />
    );
  if (item.mime === "application/pdf" && large)
    return (
      <iframe className="artifact-page" src={url} title={`${item.title} PDF`} />
    );
  return (
    <div className="artifact-file-preview">
      <File size={large ? 72 : 48} />
      <span>
        {item.mime === "application/pdf"
          ? "PDF document"
          : item.entrypoint.split(".").pop()?.toUpperCase()}
      </span>
    </div>
  );
}

function encode(file: globalThis.File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () =>
      reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

export function Artifacts() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("id");
  const library = usePoll<{ artifacts: Artifact[]; token: string }>(
    "/api/artifacts",
    10000,
  );
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [folder, setFolder] = useState("");
  const [shared, setShared] = useState(false);
  const [upload, setUpload] = useState(false);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [improving, setImproving] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError("");
    setHistory(false);
    if (selected)
      void api<ArtifactDetail>(`/api/artifacts/${selected}`).then(
        (value) => {
          if (active) setDetail(value);
        },
        (cause) => {
          if (active) setError(String(cause.message));
        },
      );
    return () => {
      active = false;
    };
  }, [
    selected,
    JSON.stringify(library.data?.artifacts.find((a) => a.id === selected)),
  ]);
  const select = (id: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id) next.set("id", id);
      else next.delete("id");
      return next;
    });
  const action = async <T,>(path: string, payload: unknown): Promise<T> => {
    if (!library.data?.token)
      throw new Error("Wait for the library to load, then retry.");
    return api<T>(`/api/artifacts${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ST-Artifacts-Token": library.data.token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300000),
    });
  };
  const change = async (path: string, payload: unknown, message: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await action<ArtifactDetail>(path, payload);
      setDetail(next);
      library.refresh();
      setNotice(message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change could not be saved.",
      );
      library.refresh();
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Link copied.");
    } catch {
      setError(
        "Could not copy the link. Select and copy the link shown below.",
      );
    }
  };
  const items = library.data?.artifacts ?? [];
  const projects = [
    ...new Set(items.map((a) => a.project).filter(Boolean)),
  ].sort();
  const folders = [
    ...new Set(
      items
        .filter(
          (a) =>
            !project ||
            (project === "__personal" ? !a.project : a.project === project),
        )
        .map((a) => a.folder)
        .filter(Boolean),
    ),
  ].sort();
  const shown = items.filter(
    (a) =>
      (!project ||
        (project === "__personal" ? !a.project : a.project === project)) &&
      (!folder || a.folder === folder) &&
      (!shared || a.share_url) &&
      `${a.title} ${a.project} ${a.folder}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const preview = detail && {
    ...detail,
    revision: detail.selected_revision,
    entrypoint: detail.manifest.entrypoint,
    mime: detail.manifest.files.find(
      (f) => f.path === detail.manifest.entrypoint,
    )!.mime,
  };
  return (
    <section className="artifact-library">
      <header className="artifact-heading">
        <div>
          <span className="artifact-eyebrow">YOUR WORK, KEPT TOGETHER</span>
          <h1>{detail ? detail.title : "Artifacts"}</h1>
          <p>
            {detail
              ? [
                  detail.project || "Personal",
                  detail.folder,
                  `Revision ${detail.selected_revision}`,
                ]
                  .filter(Boolean)
                  .join(" / ")
              : "Diagrams, documents and ideas. Save them once, keep making them better."}
          </p>
        </div>
        <button className="artifact-primary" onClick={() => setUpload(true)}>
          <Plus size={16} />
          Save a file
        </button>
      </header>
      {(error || library.error) && (
        <Notice retry={() => library.refresh()}>
          {error || library.error}
        </Notice>
      )}
      {notice && (
        <div className="artifact-notice" role="status">
          {notice}
          <button aria-label="Dismiss message" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      {selected ? (
        <>
          <button className="artifact-back" onClick={() => select(null)}>
            <ArrowLeft size={16} />
            All artifacts
          </button>
          {detail && preview ? (
            <>
              <div className="artifact-actions">
                <button onClick={() => setImproving(true)}>
                  <Pencil size={16} />
                  Improve with agent
                </button>
                <button onClick={() => setEditing(true)}>
                  <FolderOpen size={16} />
                  Organize
                </button>
                <button
                  aria-pressed={history}
                  onClick={() => setHistory(!history)}
                >
                  <History size={16} />
                  History
                </button>
                <a
                  href={
                    fileUrl(
                      detail.id,
                      detail.selected_revision,
                      detail.manifest.entrypoint,
                    ) + "?download=1"
                  }
                  download
                >
                  <Download size={16} />
                  Download
                </a>
                <button
                  className="artifact-primary"
                  disabled={
                    busy || detail.selected_revision !== detail.revision
                  }
                  title={
                    detail.selected_revision !== detail.revision
                      ? "Select the current revision before sharing"
                      : undefined
                  }
                  onClick={() =>
                    void change(
                      `/${detail.id}/publish`,
                      { revision: detail.revision },
                      "Published. The share link now opens this revision.",
                    )
                  }
                >
                  <Share2 size={16} />
                  {detail.share_url
                    ? detail.published_revision === detail.revision
                      ? "Republish"
                      : "Update shared version"
                    : "Share artifact"}
                </button>
              </div>
              {detail.share_url && (
                <div className="artifact-share">
                  <span>
                    {detail.publication_pending
                      ? "Sharing status unconfirmed. Retry publishing or stop sharing."
                      : `Shared revision ${detail.published_revision}${detail.published_revision !== detail.revision ? " · You have unpublished changes" : ""}`}
                  </span>
                  <a
                    href={detail.share_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {detail.share_url}
                    <ExternalLink size={14} />
                  </a>
                  <button
                    aria-label="Copy share link"
                    onClick={() => void copy(detail.share_url!)}
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void change(
                        `/${detail.id}/unpublish`,
                        {},
                        "Sharing turned off.",
                      )
                    }
                  >
                    Stop sharing
                  </button>
                </div>
              )}
              <div
                className={
                  history ? "artifact-detail with-history" : "artifact-detail"
                }
              >
                <div className="artifact-preview">
                  <Preview item={preview} large />
                </div>
                {history && (
                  <aside className="artifact-history">
                    <h2>Revision history</h2>
                    {detail.history.map((revision) => (
                      <div
                        key={revision.number}
                        className={
                          revision.number === detail.selected_revision
                            ? "selected"
                            : ""
                        }
                      >
                        <button
                          onClick={() =>
                            void api<ArtifactDetail>(
                              `/api/artifacts/${detail.id}?revision=${revision.number}`,
                            )
                              .then(setDetail)
                              .catch((e) => setError(e.message))
                          }
                        >
                          Revision {revision.number}
                          <small>
                            {new Date(revision.created * 1000).toLocaleString()}
                          </small>
                          {revision.note && <small>{revision.note}</small>}
                        </button>
                        {revision.number !== detail.revision && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void change(
                                `/${detail.id}/restore`,
                                {
                                  revision: revision.number,
                                  base_revision: detail.revision,
                                },
                                "Restored as a new revision.",
                              )
                            }
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    ))}
                  </aside>
                )}
              </div>
              <details className="artifact-files">
                <summary>
                  {detail.manifest.files.length} files · Output and editable
                  source
                </summary>
                {detail.manifest.files.map((file) => (
                  <a
                    key={file.path}
                    href={
                      fileUrl(detail.id, detail.selected_revision, file.path) +
                      "?download=1"
                    }
                    download
                  >
                    <File size={14} />
                    {file.path}
                    <small>
                      {file.role === "source" ? "Private source" : "Output"} ·{" "}
                      {bytes(file.size)}
                    </small>
                  </a>
                ))}
              </details>
            </>
          ) : (
            !error && <p>Loading artifact…</p>
          )}
        </>
      ) : (
        <>
          <div className="artifact-toolbar">
            <label className="artifact-search">
              <Search size={17} />
              <input
                aria-label="Search artifacts"
                placeholder="Find an artifact…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="Project"
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setFolder("");
              }}
            >
              <option value="">All projects</option>
              <option value="__personal">Personal</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <select
              aria-label="Folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              <option value="">All folders</option>
              {folders.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
            <button aria-pressed={shared} onClick={() => setShared(!shared)}>
              <Share2 size={15} />
              Shared
            </button>
          </div>
          <div className="artifact-grid">
            {shown.map((item) => (
              <button
                key={item.id}
                className="artifact-card"
                onClick={() => select(item.id)}
              >
                <div className="artifact-card-preview">
                  <Preview item={item} />
                  <span className="artifact-format">
                    {item.mime === "text/html"
                      ? "HTML"
                      : item.entrypoint.split(".").pop()?.toUpperCase()}
                  </span>
                </div>
                <div className="artifact-card-body">
                  <strong>{item.title}</strong>
                  <span>
                    {[item.project || "Personal", item.folder]
                      .filter(Boolean)
                      .join(" / ")}
                  </span>
                  <div>
                    <small>
                      Updated{" "}
                      {new Date(item.updated * 1000).toLocaleDateString()}
                    </small>
                    <small>
                      {item.share_url ? (
                        <>
                          <Share2 size={12} />
                          {item.publication_pending
                            ? "Check sharing"
                            : "Shared"}
                        </>
                      ) : (
                        "Private"
                      )}
                    </small>
                  </div>
                </div>
              </button>
            ))}
          </div>
          {!shown.length && library.data && (
            <div className="artifact-empty">
              <Layers size={40} />
              <h2>
                {items.length
                  ? "No matching artifacts"
                  : "A home for what you make"}
              </h2>
              <p>
                {items.length
                  ? "Try another search or project."
                  : "Save an HTML page, PDF or image. Revisit it here, improve it with an agent, and share it when it’s ready."}
              </p>
              {!items.length && (
                <button onClick={() => setUpload(true)}>
                  Save your first artifact
                </button>
              )}
            </div>
          )}
        </>
      )}
      {upload && (
        <SaveDialog
          close={() => setUpload(false)}
          save={async (payload) => {
            const next = await action<ArtifactDetail>("", payload);
            library.refresh();
            select(next.id);
            setUpload(false);
          }}
        />
      )}
      {editing && detail && (
        <MetadataDialog
          item={detail}
          close={() => setEditing(false)}
          save={async (values) => {
            const next = await action<ArtifactDetail>(
              `/${detail.id}/metadata`,
              values,
            );
            setDetail(next);
            library.refresh();
            setEditing(false);
          }}
        />
      )}
      {improving && detail && (
        <ImproveDialog
          item={detail}
          close={() => setImproving(false)}
          checkout={() => action<Checkout>(`/${detail.id}/checkout`, {})}
        />
      )}
    </section>
  );
}

function SaveDialog({
  close,
  save,
}: {
  close: () => void;
  save: (payload: unknown) => Promise<void>;
}) {
  const [files, setFiles] = useState<globalThis.File[]>([]),
    [source, setSource] = useState<globalThis.File[]>([]);
  const [entrypoint, setEntrypoint] = useState("");
  const [title, setTitle] = useState(""),
    [project, setProject] = useState(""),
    [folder, setFolder] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Save an artifact" close={close}>
      <form
        className="artifact-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (!files.length) throw new Error("Choose an output file.");
            if (
              [...files, ...source].reduce((n, f) => n + f.size, 0) >
              32 * 1024 * 1024
            )
              throw new Error("Choose files totaling up to 32 MiB.");
            const encoded = await Promise.all(
              [
                ...files.map((file) => ({
                  file,
                  role: "output",
                  path: file.name,
                })),
                ...source.map((file) => ({
                  file,
                  role: "source",
                  path: "source/" + file.name,
                })),
              ].map(async (f) => ({
                path: f.path,
                role: f.role,
                base64: await encode(f.file),
              })),
            );
            await save({ title, project, folder, entrypoint, files: encoded });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Upload failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Output files
          <input
            type="file"
            multiple
            required
            onChange={(e) => {
              const next = [...(e.target.files ?? [])];
              setFiles(next);
              setEntrypoint(
                next.find((f) => f.name.endsWith(".html"))?.name ??
                  next[0]?.name ??
                  "",
              );
              if (!title) setTitle(next[0]?.name.replace(/\.[^.]+$/, "") ?? "");
            }}
          />
        </label>
        {files.length > 1 && (
          <label>
            Open this file
            <select
              value={entrypoint}
              onChange={(e) => setEntrypoint(e.target.value)}
            >
              {files.map((f) => (
                <option key={f.name}>{f.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Project
          <input
            maxLength={200}
            placeholder="Personal"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </label>
        <label>
          Folder
          <input
            maxLength={200}
            placeholder="Optional"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
        </label>
        <label>
          Editable source <small>Optional · stays private when sharing</small>
          <input
            type="file"
            multiple
            onChange={(e) => setSource([...(e.target.files ?? [])])}
          />
        </label>
        {error && <Notice>{error}</Notice>}
        <button className="artifact-primary" disabled={busy}>
          {busy ? "Saving…" : "Save artifact"}
        </button>
      </form>
    </Modal>
  );
}

function MetadataDialog({
  item,
  close,
  save,
}: {
  item: Artifact;
  close: () => void;
  save: (values: unknown) => Promise<void>;
}) {
  const [values, setValues] = useState({
    title: item.title,
    project: item.project,
    folder: item.folder,
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Organize artifact" close={close}>
      <form
        className="artifact-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save(values);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not save.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {(["title", "project", "folder"] as const).map((key) => (
          <label key={key}>
            {key[0]!.toUpperCase() + key.slice(1)}
            <input
              required={key === "title"}
              maxLength={200}
              value={values[key]}
              onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            />
          </label>
        ))}
        {error && <Notice>{error}</Notice>}
        <button disabled={busy}>Save details</button>
      </form>
    </Modal>
  );
}

function ImproveDialog({
  item,
  close,
  checkout,
}: {
  item: Artifact;
  close: () => void;
  checkout: () => Promise<Checkout>;
}) {
  useSyncExternalStore(subscribeRecent, recentRevision);
  const navigate = useNavigate();
  const choices = recentConversations()
    .map(recentDetails)
    .filter(
      (c) =>
        c.machineId === "local" &&
        c.view === "chat" &&
        c.agent &&
        !c.saved &&
        !["ended", "archived", "disconnected"].includes(c.status),
    );
  const [choice, setChoice] = useState(agentsSelection()?.paneId ?? "");
  const [change, setChange] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const prepare = async (sendToChat: boolean) => {
    setBusy(true);
    setError("");
    try {
      const text = improvePrompt(
        await checkout(),
        change || "Help me improve this artifact.",
      );
      setPrompt(text);
      if (sendToChat) {
        const target = choices.find((c) => c.paneId === choice);
        if (!target) throw new Error("Choose an open conversation.");
        const [
          { composerDraftKey },
          { paneStorageId },
          { appendArtifactDraft },
        ] = await Promise.all([
          import("../../../../integrations/ovis/app/src/lib/composerDraft"),
          import("../../../../integrations/ovis/app/shared/machines"),
          import("./handoff"),
        ]);
        const key = composerDraftKey(
          paneStorageId(target.machineId, target.paneId),
        );
        await appendArtifactDraft(key, text);
        navigate(
          "/agents" +
            (location.search.includes("workmode=1") ? "?workmode=1" : ""),
        );
        target.open();
        close();
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not prepare the artifact.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Improve ${item.title}`} close={close}>
      <div className="artifact-form">
        <label>
          What would you like to change?
          <textarea
            rows={4}
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="Make the diagram clearer and add a legend…"
          />
        </label>
        {choices.length > 0 && (
          <label>
            Conversation
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose an open conversation</option>
              {choices.map((c) => (
                <option key={c.id} value={c.paneId}>
                  {c.workspace} · {c.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <p>
          The agent gets an editable copy of revision {item.revision}. Saving it
          updates this artifact and preserves its history.
        </p>
        {error && <Notice>{error}</Notice>}
        <div className="artifact-actions">
          {choices.length > 0 && (
            <button
              className="artifact-primary"
              disabled={busy || !choices.some((c) => c.paneId === choice)}
              onClick={() => void prepare(true)}
            >
              Prepare in conversation
            </button>
          )}
          <button disabled={busy} onClick={() => void prepare(false)}>
            Copy instructions
          </button>
        </div>
        {prompt && (
          <label>
            Instructions ready
            <textarea readOnly rows={6} value={prompt} />
          </label>
        )}
      </div>
    </Modal>
  );
}
