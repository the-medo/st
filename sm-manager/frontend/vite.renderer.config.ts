import { defineConfig } from "vite";
import { excalidrawAssets } from "./excalidraw-assets";
export default defineConfig({
  root: "renderer",
  plugins: [excalidrawAssets()],
  build: {
    // Keep this in the updater's atomically exchanged build directory. The
    // main web manifest does not expose these standalone renderer files.
    outDir: "../../sm_manager/web/diagram-renderer",
    emptyOutDir: true,
    manifest: true,
  },
});
