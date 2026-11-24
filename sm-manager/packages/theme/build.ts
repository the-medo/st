import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { themeCss } from "./index";
const output = themeCss();
const paths = [
  new URL("./theme.css", import.meta.url),
  new URL("../../sm_manager/static/st-theme.css", import.meta.url),
];
for (const path of paths) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output)
      throw new Error(
        `Stale theme output: ${fileURLToPath(path)}. Run bun run theme:build.`,
      );
  } else writeFileSync(path, output);
}

for (const name of ["planner.css", "planner.js"]) {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  const path = new URL(`../../sm_manager/static/st-${name}`, import.meta.url);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== source)
      throw new Error(`Stale planner theme: ${fileURLToPath(path)}`);
  } else writeFileSync(path, source);
}
