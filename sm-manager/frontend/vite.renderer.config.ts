import { defineConfig } from "vite";
import { excalidrawAssets } from "./excalidraw-assets";
export default defineConfig({
  root: "renderer",
  plugins: [excalidrawAssets()],
  build: {
    outDir: "../../sm_manager/artifact_renderer",
    emptyOutDir: true,
    manifest: true,
  },
});
