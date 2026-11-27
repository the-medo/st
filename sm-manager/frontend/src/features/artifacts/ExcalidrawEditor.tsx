import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { api } from "../../lib/api";
import { Notice } from "../../components/Ui";
import { fileUrl, type ArtifactDetail } from "./model";
import { loadExcalidraw } from "./excalidraw-loader";
import {
  normalizeDiagram,
  renderDiagram,
  type DiagramScene,
  type DiagramBundle,
} from "./excalidraw";

export function ExcalidrawEditor({
  item,
  close,
  save,
}: {
  item: ArtifactDetail | null;
  close: () => void;
  save: (
    bundle: DiagramBundle & {
      title?: string;
      project?: string;
      folder?: string;
      base_revision?: number;
      note: string;
    },
  ) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const drawing = useRef<ExcalidrawImperativeAPI | null>(null);
  const baseline = useRef<string | null>(null);
  const [sdk, setSdk] = useState<Awaited<
    ReturnType<typeof loadExcalidraw>
  > | null>(null);
  const [scene, setScene] = useState<DiagramScene | null>(null);
  const [title, setTitle] = useState(item?.title ?? "Untitled diagram");
  const [project, setProject] = useState("");
  const [folder, setFolder] = useState("");
  const [dirty, setDirty] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    let active = true;
    void (async () => {
      const module = await loadExcalidraw();
      const input = item
        ? await api<unknown>(
            fileUrl(
              item.id,
              item.selected_revision,
              item.manifest.editor!.source,
            ),
          )
        : { elements: [], appState: { viewBackgroundColor: "#ffffff" } };
      const initial = await normalizeDiagram(input);
      if (active) {
        setSdk(module);
        setScene(initial);
      }
    })().catch((error) => {
      if (active)
        setError(
          error instanceof Error
            ? error.message
            : "Could not open the drawing.",
        );
    });
    return () => {
      active = false;
      element.close();
      previous?.focus();
    };
  }, [item]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const requestClose = () => {
    if (!busy) dirty ? setDiscarding(true) : close();
  };
  const snapshot = () => {
    if (!drawing.current) throw new Error("Wait for the drawing to load.");
    return {
      type: "excalidraw",
      version: 2,
      elements: drawing.current.getSceneElements(),
      appState: drawing.current.getAppState(),
      files: drawing.current.getFiles(),
    };
  };
  const download = async () => {
    try {
      const data = await normalizeDiagram(snapshot());
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "diagram.excalidraw";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not export the drawing.",
      );
    }
  };
  return (
    <dialog
      ref={dialog}
      className="st-dialog artifact-editor-dialog"
      aria-label={item ? "Edit diagram" : "New diagram"}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <header>
        <div>
          <h2>{item ? item.title : "New diagram"}</h2>
          <p>
            {item
              ? `Editing revision ${item.selected_revision}`
              : "Draw something worth keeping"}
            {dirty ? " · Unsaved changes" : ""}
          </p>
        </div>
        <div className="artifact-actions">
          <button disabled={!ready || busy} onClick={() => void download()}>
            Download .excalidraw
          </button>
          <button
            className="artifact-primary"
            disabled={!ready || busy || !title.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const bundle = await renderDiagram(snapshot());
                await save({
                  ...bundle,
                  ...(item
                    ? { base_revision: item.revision }
                    : { title, project, folder }),
                  note: item ? "Edited diagram" : "Created diagram",
                });
              } catch (error) {
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not save the diagram.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Rendering & saving…" : "Save diagram"}
          </button>
          <button
            disabled={busy}
            onClick={requestClose}
            aria-label="Close diagram editor"
          >
            ✕
          </button>
        </div>
      </header>
      {!item && (
        <div className="artifact-editor-fields">
          <label>
            Title
            <input
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Project
            <input
              value={project}
              maxLength={200}
              placeholder="Personal"
              onChange={(event) => setProject(event.target.value)}
            />
          </label>
          <label>
            Folder
            <input
              value={folder}
              maxLength={200}
              placeholder="Optional"
              onChange={(event) => setFolder(event.target.value)}
            />
          </label>
        </div>
      )}
      {error && (
        <Notice>
          {error} Your drawing is still open; you can download the editable
          file.
        </Notice>
      )}
      {discarding && (
        <div className="artifact-editor-discard" role="alert">
          Discard unsaved changes?
          <button onClick={() => setDiscarding(false)}>Keep editing</button>
          <button onClick={close}>Discard changes</button>
        </div>
      )}
      <div className="st-artifact-editor-canvas">
        {sdk && scene ? (
          <sdk.Excalidraw
            initialData={{ ...scene, scrollToContent: true }}
            excalidrawAPI={(api) => {
              drawing.current = api;
              setReady(true);
            }}
            name={title}
            theme="light"
            handleKeyboardGlobally={false}
            isCollaborating={false}
            validateEmbeddable={() => false}
            onChange={(elements, state, files) => {
              const value = JSON.stringify({
                elements,
                files,
                background: state.viewBackgroundColor,
              });
              if (baseline.current === null) baseline.current = value;
              setDirty(value !== baseline.current);
            }}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                saveAsImage: false,
                export: false,
                toggleTheme: false,
              },
            }}
          >
            <sdk.MainMenu>
              <sdk.MainMenu.DefaultItems.ClearCanvas />
              <sdk.MainMenu.DefaultItems.ChangeCanvasBackground />
            </sdk.MainMenu>
          </sdk.Excalidraw>
        ) : (
          <p>Loading drawing tools…</p>
        )}
      </div>
    </dialog>
  );
}
