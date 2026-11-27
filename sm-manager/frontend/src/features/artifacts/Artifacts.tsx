import {
  lazy,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
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
  MessageCircle,
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
  type ArtifactProject,
  type Artifact,
  type ArtifactDetail,
  type Checkout,
} from "./model";
import "./artifacts.css";
import { ProjectBadge, ProjectPicker, projectStyle } from "./ProjectPicker";
const OriginalConversation = lazy(() => import("./OriginalConversation"));
const ExcalidrawEditor = lazy(() =>
  import("./ExcalidrawEditor").then((module) => ({
    default: module.ExcalidrawEditor,
  })),
);

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

function encode(file: Blob): Promise<string> {
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
  const library = usePoll<{
    artifacts: Artifact[];
    projects: ArtifactProject[];
    projects_error?: string;
    token: string;
  }>("/api/artifacts", 10000);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("__all");
  const [original, setOriginal] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [upload, setUpload] = useState(false);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [improving, setImproving] = useState(false);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState(false);
  // Freeze the base revision while editing; a background refresh must never
  // replace the drawing or silently advance its optimistic concurrency check.
  const [diagram, setDiagram] = useState<ArtifactDetail | null | undefined>(
    undefined,
  );
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
  const projects = library.data?.projects ?? [];
  const projectOf = (item: Artifact) =>
    projects.find((project) => project.id === item.project);
  const shown = items.filter(
    (item) =>
      (project === "__all" || item.project === project) &&
      (!shared || item.share_url) &&
      `${item.title} ${projectOf(item)?.name ?? ""}`
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
          {detail ? (
            <div className="artifact-detail-meta">
              <ProjectBadge project={projectOf(detail)} />
              <span>Revision {detail.selected_revision}</span>
            </div>
          ) : (
            <p>
              Diagrams, documents and ideas. Save them once, keep making them
              better.
            </p>
          )}
        </div>
        <div className="artifact-heading-actions">
          <button className="artifact-primary" onClick={() => setDiagram(null)}>
            <Plus size={16} />
            New diagram
          </button>
          <button onClick={() => setUpload(true)}>
            <Plus size={16} />
            Save a file
          </button>
        </div>
      </header>
      {library.data?.projects_error && (
        <Notice retry={library.refresh}>{library.data.projects_error}</Notice>
      )}
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
                {detail.source_chat && (
                  <button onClick={() => setOriginal(detail.source_chat)}>
                    <MessageCircle size={16} />
                    Original conversation
                  </button>
                )}

                {detail.manifest.editor?.type === "excalidraw" && (
                  <button
                    disabled={detail.selected_revision !== detail.revision}
                    title={
                      detail.selected_revision !== detail.revision
                        ? "Restore this revision before editing it"
                        : undefined
                    }
                    onClick={() => setDiagram(detail)}
                  >
                    <Pencil size={16} />
                    Edit diagram
                  </button>
                )}
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
            <ProjectPicker
              projects={projects}
              value={project}
              onChange={setProject}
              filter
            />
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
                style={projectStyle(projectOf(item))}
                onClick={() => select(item.id)}
              >
                <div className="artifact-card-preview">
                  <Preview item={item} />
                  <span className="artifact-format">
                    {item.editor?.type === "excalidraw"
                      ? "EXCALIDRAW"
                      : item.mime === "text/html"
                        ? "HTML"
                        : item.entrypoint.split(".").pop()?.toUpperCase()}
                  </span>
                </div>
                <div className="artifact-card-body">
                  <strong>{item.title}</strong>
                  <ProjectBadge project={projectOf(item)} />
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
                  : "Draw a diagram or save an HTML page, PDF or image. Revisit it here, improve it with an agent, and share it when it’s ready."}
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
      {diagram !== undefined && (
        <Suspense fallback={<p role="status">Loading drawing tools…</p>}>
          <ExcalidrawEditor
            projects={projects}
            initialProject={project === "__all" ? "" : project}
            item={diagram}
            close={() => setDiagram(undefined)}
            save={async (bundle) => {
              const replaced = new Set(bundle.files.map((file) => file.path));
              if (diagram?.manifest.editor)
                replaced.add(diagram.manifest.editor.source);
              const extras = await Promise.all(
                (diagram?.manifest.files ?? [])
                  .filter((file) => !replaced.has(file.path))
                  .map(async (file) => {
                    const response = await fetch(
                      fileUrl(
                        diagram!.id,
                        diagram!.selected_revision,
                        file.path,
                      ),
                    );
                    if (!response.ok)
                      throw new Error(
                        "Could not preserve an attached file. Please retry.",
                      );
                    return {
                      path: file.path,
                      role: file.role,
                      base64: await encode(await response.blob()),
                    };
                  }),
              );
              const next = await action<ArtifactDetail>(
                diagram ? `/${diagram.id}/save` : "",
                { ...bundle, files: [...bundle.files, ...extras] },
              );
              setDetail(next);
              library.refresh();
              select(next.id);
              setDiagram(undefined);
              setNotice("Diagram saved. SVG and PNG previews are ready.");
            }}
          />
        </Suspense>
      )}
      {upload && (
        <SaveDialog
          projects={projects}
          initialProject={project === "__all" ? "" : project}
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
          projects={projects}
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
      {original && (
        <Suspense fallback={<Notice>Loading conversation viewer…</Notice>}>
          <OriginalConversation id={original} close={() => setOriginal(null)} />
        </Suspense>
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
  projects,
  initialProject,
  close,
  save,
}: {
  close: () => void;
  save: (payload: unknown) => Promise<void>;
  projects: ArtifactProject[];
  initialProject: string;
}) {
  const [files, setFiles] = useState<globalThis.File[]>([]),
    [source, setSource] = useState<globalThis.File[]>([]);
  const [entrypoint, setEntrypoint] = useState("");
  const [title, setTitle] = useState(""),
    [project, setProject] = useState(initialProject);
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
            if (
              files.some((file) =>
                file.name.toLowerCase().endsWith(".excalidraw"),
              )
            ) {
              if (files.length !== 1 || source.length)
                throw new Error(
                  "Import one .excalidraw file at a time, with its images embedded.",
                );
              const { renderDiagram } = await import("./excalidraw");
              await save({
                title,
                project,
                ...(await renderDiagram(JSON.parse(await files[0]!.text()))),
              });
              return;
            }
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
            await save({ title, project, entrypoint, files: encoded });
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
        <small>
          Import .excalidraw files to keep them editable and generate previews
          automatically.
        </small>
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
        <div className="artifact-project-field">
          <span>Project</span>
          <ProjectPicker
            projects={projects}
            value={project}
            onChange={setProject}
          />
        </div>
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
  projects,
  item,
  close,
  save,
}: {
  item: Artifact;
  projects: ArtifactProject[];
  close: () => void;
  save: (values: unknown) => Promise<void>;
}) {
  const [values, setValues] = useState({
    title: item.title,
    project: item.project,
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
        {(["title"] as const).map((key) => (
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
        <div className="artifact-project-field">
          <span>Project</span>
          <ProjectPicker
            projects={projects}
            value={values.project}
            onChange={(project) => setValues({ ...values, project })}
          />
        </div>
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
