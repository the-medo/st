# S.T. theme

`@st/theme` is the shared, framework-independent appearance package for the
console, hosted Ovis and DAVe planner. `tokens.ts` owns the original S.T. blue
console and amber Workmode palettes, fonts, spacing, radii, status colors and
syntax colors. Names describe roles rather than individual components.

```ts
import { tokens, themeName, themeVariables } from "@st/theme";
import "@st/theme/theme.css";
```

CSS consumers use `--st-bg`, `--st-paper`, `--st-surface`, `--st-ink`,
`--st-muted`, `--st-accent`, `--st-line`, `--st-font-ui`, `--st-font-mono`,
`--st-radius-*` and `--st-space-*`. Set `data-st-theme="console"` or
`data-st-theme="workmode"` on a theme boundary. The console's existing
`data-workmode` attribute is also supported. All palettes use the same keys;
`themeVariables(name)` supplies the complete concrete token map to other hosts.

Adapters:

- `theme.css` provides the canonical properties and legacy console aliases.
- `ovis.ts` returns an Ovis appearance entry, including the concrete colors used
  by its canvas terminal. `ovis.css` shares fonts, spacing and corner shapes.
  The optional Ovis host appearance overrides its resolved theme, leaves saved
  standalone preferences intact, and identifies the host in Appearance settings.
- `planner.css` maps DAVe/Tailwind and FullCalendar roles. `planner.js` sets the
  initial theme before rendering and accepts updates only from the same-origin
  parent frame. It preserves DAVe preferences and explains why its color selector
  is controlled by S.T. The monitor injects these assets into proxied planner HTML
  only for the React frontend; the independent DAVe installation is unchanged.

Run `bun run theme:build` from `sm-manager` after editing tokens or the planner
adapter. Generated CSS/JS is checked in under `sm_manager/static` so the Python
runtime and legacy console work without Bun. `bun run theme:check` detects stale
outputs. The production build regenerates them automatically.

The design follows the existing S.T. interface as requested. Ovis's shipped Codex
palette and semantic role system were reviewed; the adapter keeps that role
structure, chat density, status meaning and touch targets while using the host's
established colors and shapes. Home service illustrations retain their distinct
category accents. This package does not introduce a new light theme.
