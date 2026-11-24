import type { Plugin } from "vite";
import postcss from "postcss";
export function ovisHostPlugin(): Plugin {
  return {
    name: "st-ovis-host",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/integrations/ovis/app/src/")) return null;
      if (/\.[cm]?[jt]sx?$/.test(id)) {
        const names: [string, string][] = [
          ["document", "hostDocument"],
          ["window", "hostWindow"],
          ["location", "hostLocation"],
          ["fetch", "hostFetch"],
          ["WebSocket", "HostWebSocket"],
          ["EventSource", "HostEventSource"],
        ];
        const selected = names.filter(([name]) =>
          new RegExp(`\\b${name}\\b`).test(code),
        );
        return selected.length
          ? {
              code: `import {${selected.map(([name, alias]) => `${alias} as ${name}`).join(",")}} from '@st/ovis-host';\n${code}`,
              map: null,
            }
          : null;
      }
      if (id.endsWith(".css")) {
        const root = postcss.parse(code);
        const scope = postcss.atRule({
          name: "scope",
          params: "(.st-ovis-root)",
        });
        for (const node of [...root.nodes]) {
          if (
            node.type === "atrule" &&
            [
              "import",
              "font-face",
              "keyframes",
              "-webkit-keyframes",
              "charset",
            ].includes(node.name)
          )
            continue;
          scope.append(node);
        }
        scope.walkRules((rule) => {
          if (
            rule.parent?.type === "atrule" &&
            /keyframes$/.test(rule.parent.name)
          )
            return;
          rule.selector = rule.selector
            .replace(
              /:root|(?<![\w-])(?:html|body)(?![\w-])|#root\b/g,
              ":scope",
            )
            .replace(/:scope\s*,\s*:scope/g, ":scope")
            .replace(/:scope\s+:scope/g, ":scope");
        });
        root.append(scope);
        return { code: root.toString(), map: null };
      }
      return null;
    },
  };
}
