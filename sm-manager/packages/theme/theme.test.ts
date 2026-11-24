import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tokens, themeCss, themeVariables, type ThemeName } from "./index";
import { ovisTheme } from "./ovis";
import { ROLES } from "../../integrations/ovis/app/src/lib/themeRoles";
function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
for (const name of Object.keys(tokens.colors) as ThemeName[]) {
  test(`${name} preserves readable text and supplies every Ovis role`, () => {
    const colors = tokens.colors[name];
    for (const [foreground, background] of [
      [colors.ink, colors.bg],
      [colors.muted, colors.paper],
      [colors["primary-ink"], colors["primary-bg"]],
    ]) {
      const ratio =
        (luminance(foreground!) + 0.05) / (luminance(background!) + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    const entry = ovisTheme(name);
    for (const role of Object.keys(ROLES))
      expect(entry.vars[role]).toBeDefined();
    expect(entry.terminal.background).toBe(entry.vars["term-bg"]);
    expect(entry.terminal.foreground).toBe(entry.vars["text"]);
    expect(entry.terminal.cursor).toBe(colors.accent);
    expect(Object.keys(themeVariables(name))).toEqual(
      Object.keys(themeVariables("console")),
    );
  });
}
test("Python's shipped theme and package CSS stay in sync with the source", () => {
  for (const name of ["./theme.css", "../../sm_manager/static/st-theme.css"])
    expect(readFileSync(new URL(name, import.meta.url), "utf8")).toBe(
      themeCss(),
    );
  for (const name of ["planner.css", "planner.js"])
    expect(
      readFileSync(
        new URL(`../../sm_manager/static/st-${name}`, import.meta.url),
        "utf8",
      ),
    ).toBe(readFileSync(new URL(name, import.meta.url), "utf8"));
});
