import type { Snapshot } from "./types";

const palette = [
  "#58a6ff",
  "#63cf8c",
  "#d2a8ff",
  "#f0b65f",
  "#f778ba",
  "#56d4dd",
  "#ff7b72",
  "#a5d6ff",
  "#b6dc7b",
  "#c9b1fa",
  "#e8ce97",
  "#9cd5cb",
];
const assigned = new Map<string, string>();
export const codexColor = "#c4b5fd",
  otherColor = "#91a0b2";

/** Match the original palette and keep a project's color as sources/polls change. */
export function projectColors(projects: Snapshot["projects"]) {
  for (const project of [...projects].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!assigned.has(project.id)) {
      const index = assigned.size;
      assigned.set(
        project.id,
        palette[index] ?? `hsl(${(index * 137.5) % 360} 70% 70%)`,
      );
    }
  }
  return assigned;
}

export function historySources(snapshot: Snapshot) {
  const colors = projectColors(snapshot.projects);
  return [
    { id: "host", label: "Whole machine", color: "#f0f6fc", total: true },
    {
      id: "projects",
      label: "All projects",
      color: "#aab5c4",
      total: true,
      dash: "6 4",
    },
    { id: "codex", label: "Codex processes", color: codexColor },
    {
      id: "other",
      label: "System & other",
      color: otherColor,
      dash: "3 4",
      description:
        "Remainder after projects and Codex; includes system, other apps and unassigned containers.",
    },
    ...[...snapshot.projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((project) => [
        {
          id: `project:${project.id}`,
          label: project.name,
          color: colors.get(project.id)!,
        },
        ...project.worktrees.map((worktree) => ({
          id: `worktree:${worktree.id}`,
          label: `${project.name} / ${worktree.branch}`,
          color: colors.get(project.id)!,
        })),
      ]),
  ];
}

export function resourceCeiling(
  memory: boolean,
  scale: "usage" | "capacity",
  capacity: number,
  highest: number,
) {
  if (scale === "capacity")
    return Math.max(memory ? capacity : 100, highest, 1);
  const maximum = Math.max(memory ? 64 * 1024 ** 2 : 1, highest * 1.12);
  const step = memory
    ? maximum >= 1024 ** 3
      ? 256 * 1024 ** 2
      : 16 * 1024 ** 2
    : maximum < 5
      ? 0.5
      : 5;
  return Math.ceil(maximum / step) * step;
}
