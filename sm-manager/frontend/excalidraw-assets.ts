import type { Plugin } from "vite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Excalidraw resolves its optional fonts at runtime. Keep them local and declare
// every emitted file in Vite's manifest so the console's asset allowlist applies.
export function excalidrawAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@excalidraw/excalidraw"));
  return {
    name: "herdr-excalidraw-fonts",
    transform(code, id) {
      if (
        !id.includes("/@excalidraw/excalidraw/dist/") ||
        !code.includes("ASSETS_FALLBACK_URL")
      )
        return null;
      // 0.18.1 always appends a CDN fallback, even with EXCALIDRAW_ASSET_PATH.
      // Keep that fallback local too: FontFace otherwise probes hundreds of
      // remote URLs, producing CSP failures despite usable local fonts.
      const replacement = code.replace(
        /("ASSETS_FALLBACK_URL",\s*)`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/,
        '$1new URL("/assets/excalidraw-0.18.1/", window.location.origin).href',
      );
      if (replacement === code)
        this.error(
          "The Excalidraw font fallback changed; review local asset handling.",
        );
      return { code: replacement, map: null };
    },
    generateBundle() {
      const notice = fileURLToPath(
        new URL("./EXCALIDRAW-LICENSE.txt", import.meta.url),
      );
      this.emitFile({
        type: "asset",
        fileName: "assets/excalidraw-0.18.1/LICENSE.txt",
        name: "Excalidraw license",
        originalFileName: notice,
        source: readFileSync(notice),
      });
      const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.name.endsWith(".woff2")) {
            const name = relative(root, path);
            this.emitFile({
              type: "asset",
              fileName: `assets/excalidraw-0.18.1/${name}`,
              name,
              originalFileName: path,
              source: readFileSync(path),
            });
          }
        }
      };
      visit(join(root, "fonts"));
    },
  };
}
