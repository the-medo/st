import type { Plugin } from "vite";
import postcss from "postcss";

/** Share the original console styles without styling the embedded Ovis app. */
export function consoleStylePlugin(): Plugin {
  return {
    name: "st-console-styles",
    enforce: "pre",
    transform(code, id) {
      if (!/\/sm_manager\/static\/(style|home)\.css$/.test(id)) return null;
      const root = postcss.parse(code);
      const scope = postcss.atRule({
        name: "scope",
        params: "(.st-app) to (.st-ovis-root, .st-artifact-editor-canvas)",
      });
      for (const node of [...root.nodes]) scope.append(node);
      scope.walkRules((rule) => {
        if (
          rule.parent?.type === "atrule" &&
          /keyframes$/.test(rule.parent.name)
        )
          return;
        rule.selector = rule.selector.replace(/:root|\bbody\b/g, ":scope");
      });
      // The original document uses a 12px root. Keep its sizes while leaving
      // the browser's 16px rem baseline intact for Ovis.
      scope.walkDecls((decl) => {
        decl.value = decl.value.replace(
          /([\d.]+)rem\b/g,
          (_, size) => `${Number(size) * 12}px`,
        );
      });
      root.append(scope);
      return { code: root.toString(), map: null };
    },
  };
}
