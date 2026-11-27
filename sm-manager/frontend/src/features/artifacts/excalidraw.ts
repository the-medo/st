import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { loadExcalidraw } from "./excalidraw-loader";

export const diagramEditor = {
  type: "excalidraw",
  source: "source/diagram.excalidraw",
} as const;
export type DiagramScene = {
  type: "excalidraw";
  version: number;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};
export type DiagramBundle = {
  editor: typeof diagramEditor;
  entrypoint: string;
  files: { path: string; role: "source" | "output"; base64: string }[];
};

export async function normalizeDiagram(input: unknown): Promise<DiagramScene> {
  const sdk = await loadExcalidraw();
  const data = Array.isArray(input) ? { elements: input } : input;
  if (
    !data ||
    typeof data !== "object" ||
    !("elements" in data) ||
    !Array.isArray(data.elements)
  )
    throw new Error(
      "Choose an Excalidraw scene or a JSON object containing elements.",
    );
  const scene = data as {
    type?: string;
    elements: ExcalidrawElement[];
    appState?: Partial<AppState>;
    files?: BinaryFiles;
  };
  if (scene.type && scene.type !== "excalidraw")
    throw new Error("This file is not an Excalidraw drawing.");
  const allowed = new Set([
    "rectangle",
    "ellipse",
    "diamond",
    "text",
    "arrow",
    "line",
    "freedraw",
    "image",
    "frame",
  ]);
  const ids = new Set<string>();
  for (const el of scene.elements) {
    if (!el || !allowed.has(el.type))
      throw new Error(
        "Use drawing elements; embedded webpages are not supported.",
      );
    if (el.id && ids.has(el.id))
      throw new Error("Diagram element IDs must be unique.");
    if (el.id) ids.add(el.id);
    if (el.link && !/^(https?:|mailto:|#)/i.test(el.link))
      throw new Error(
        "Diagram links must use HTTPS, HTTP, mailto or an internal anchor.",
      );
  }
  for (const file of Object.values(scene.files ?? {})) {
    if (
      !file ||
      !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(file.dataURL)
    )
      throw new Error(
        "Include images inside the Excalidraw file; remote image references are not supported.",
      );
  }
  // Native scenes retain IDs, seeds, bindings and positions. Compact agent JSON
  // uses the SDK's skeleton converter for text sizing, bound labels and arrows.
  const elements =
    scene.type === "excalidraw"
      ? scene.elements
      : sdk.convertToExcalidrawElements(
          scene.elements as unknown as ExcalidrawElementSkeleton[],
          { regenerateIds: false },
        );
  const restored = sdk.restore(
    { elements, appState: scene.appState ?? {}, files: scene.files ?? {} },
    null,
    null,
    { repairBindings: true },
  );
  return JSON.parse(
    sdk.serializeAsJSON(
      restored.elements,
      restored.appState,
      restored.files,
      "local",
    ),
  );
}

const encode = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () =>
      reject(new Error("Could not encode the diagram export."));
    reader.readAsDataURL(blob);
  });

export async function renderDiagram(input: unknown): Promise<DiagramBundle> {
  const scene = await normalizeDiagram(input);
  const sdk = await loadExcalidraw();
  const elements = scene.elements.filter((el) => !el.isDeleted);
  if (!elements.length)
    throw new Error("Add something to the diagram before saving.");
  const appState = {
    ...scene.appState,
    exportEmbedScene: false,
    exportWithDarkMode: false,
    exportBackground: true,
  };
  const svg = await sdk.exportToSvg({
    elements,
    appState,
    files: scene.files,
    exportPadding: 24,
  });
  const png = await sdk.exportToBlob({
    elements,
    appState,
    files: scene.files,
    exportPadding: 24,
    maxWidthOrHeight: 2400,
    mimeType: "image/png",
  });
  const contents = [
    {
      path: diagramEditor.source,
      role: "source" as const,
      blob: new Blob([JSON.stringify(scene, null, 2)], {
        type: "application/json",
      }),
    },
    {
      path: "diagram.svg",
      role: "output" as const,
      blob: new Blob([svg.outerHTML], { type: "image/svg+xml" }),
    },
    { path: "diagram.png", role: "output" as const, blob: png },
  ];
  if (
    contents.reduce((total, file) => total + file.blob.size, 0) >
    32 * 1024 * 1024
  )
    throw new Error(
      "The drawing and its exports exceed the 32 MiB artifact limit.",
    );
  return {
    editor: diagramEditor,
    entrypoint: "diagram.svg",
    files: await Promise.all(
      contents.map(async (file) => ({
        path: file.path,
        role: file.role,
        base64: await encode(file.blob),
      })),
    ),
  };
}
