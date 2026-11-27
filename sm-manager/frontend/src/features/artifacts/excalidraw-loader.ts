// Set before the SDK is evaluated; no public CDN is needed by the editor/exporter.
Object.assign(window, {
  EXCALIDRAW_ASSET_PATH: new URL(
    "assets/excalidraw-0.18.1/",
    location.origin + "/",
  ).href,
});
export const loadExcalidraw = () => import("@excalidraw/excalidraw");
