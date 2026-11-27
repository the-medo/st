import { defineConfig } from "vite";
import { excalidrawAssets } from "./excalidraw-assets";
import react from "@vitejs/plugin-react";
import { ovisHostPlugin } from "./ovis-plugin";
import { consoleStylePlugin } from "./console-style-plugin";
import { buildXtermSource } from "../integrations/ovis/app/scripts/build-xterm";
import { fileURLToPath } from "node:url";
const ovis = fileURLToPath(
  new URL("../integrations/ovis/app/", import.meta.url),
);
const xterm = buildXtermSource(ovis);

export default defineConfig({
  plugins: [consoleStylePlugin(), ovisHostPlugin(), excalidrawAssets(), react()],
  define: {
    __APP_VERSION__: JSON.stringify("0.5.9"),
    __APP_REVISION__: "null",
    __HERDR_TEST_HOOKS__: "false",
    "import.meta.env.VITE_MEDO_PROJECTS": JSON.stringify("1"),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: "@st/ovis-host",
        replacement: fileURLToPath(
          new URL("./src/features/ovis/host.ts", import.meta.url),
        ),
      },
      {
        find: /^@xterm\/xterm$/,
        replacement: `${xterm}/browser/public/Terminal.js`,
      },
      { find: /^browser\//, replacement: `${xterm}/browser/` },
      { find: /^common\//, replacement: `${xterm}/common/` },
      { find: /^vs\/nls$/, replacement: `${xterm}/vs/patches/nls.js` },
      { find: /^vs\//, replacement: `${xterm}/vs/` },
      { find: "@shared", replacement: `${ovis}/shared` },
    ],
  },
  build: { outDir: "../sm_manager/web", emptyOutDir: true, manifest: true },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: "http://127.0.0.1:18791", changeOrigin: false },
      "/planner": { target: "http://127.0.0.1:18791", changeOrigin: false },
    },
  },
});
