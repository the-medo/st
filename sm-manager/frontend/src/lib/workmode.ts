import type { Database, Project, Snapshot, ZedGroup } from "./types";
const family = (s: string) => /^ydistri(?:$|[\s/_-])/i.test(s.trim());
const workPath = (s?: string) =>
  s?.split("/").some((p) => p.toLowerCase() === "ydistri") ?? false;
const repo = (s?: string) => {
  try {
    const u = new URL(s ?? "");
    return (
      u.hostname === "github.com" &&
      ["ydistri", "ydistri-customers"].includes(
        u.pathname.split("/")[1]!.toLowerCase(),
      )
    );
  } catch {
    return false;
  }
};
export function workScope(
  snapshot: Snapshot | null,
  groups: ZedGroup[] = [],
  connections: Database[] = [],
) {
  const paths = new Set<string>();
  for (const g of groups)
    for (const r of g.repositories)
      if (family(g.name) || workPath(r.primary_path)) {
        paths.add(r.primary_path);
        r.worktrees.forEach((w) => paths.add(w.path));
      }
  for (const d of connections)
    if (d.owner && (family(d.owner.group) || workPath(d.owner.primary_path))) {
      paths.add(d.owner.primary_path);
      paths.add(d.owner.worktree_path);
    }
  const projects = (snapshot?.projects ?? []).filter(
    (p) =>
      repo(p.info?.repository_url) ||
      [
        p.info?.path,
        p.info?.primary_path,
        ...p.worktrees.map((w) => w.path),
      ].some((p) => p && (workPath(p) || paths.has(p))),
  );
  for (const p of projects) for (const w of p.worktrees) paths.add(w.path);
  return {
    projects,
    paths,
    groups: groups
      .map((g) => ({
        ...g,
        repositories: g.repositories.filter(
          (r) =>
            family(g.name) ||
            paths.has(r.primary_path) ||
            r.worktrees.some((w) => paths.has(w.path)),
        ),
      }))
      .filter((g) => g.repositories.length),
    connections: connections.filter((d) =>
      d.owner
        ? family(d.owner.group) ||
          paths.has(d.owner.primary_path) ||
          paths.has(d.owner.worktree_path)
        : family(d.group ?? ""),
    ),
  };
}
export function workCodex(
  snapshot: Snapshot,
  projects: Project[],
  paths: Set<string>,
) {
  const trees = snapshot.projects
    .flatMap((p) => p.worktrees)
    .sort((a, b) => b.path.length - a.path.length);
  const processes = snapshot.codex.processes.filter((p) => {
    const w = trees.find(
      (w) => p.cwd === w.path || p.cwd?.startsWith(w.path + "/"),
    );
    return w && paths.has(w.path);
  });
  const worktrees = projects.flatMap((p) => p.worktrees);
  return {
    ...snapshot.codex,
    processes,
    recent_threads: worktrees.reduce((s, w) => s + w.recent_threads, 0),
    managed_worktrees: worktrees.filter((w) => w.codex_managed).length,
    memory_bytes: processes.reduce((s, p) => s + p.memory_bytes, 0),
    cpu_percent: processes.reduce((s, p) => s + (p.cpu_percent ?? 0), 0),
  };
}

export function isWorkmode(search: string) {
  const value = new URLSearchParams(search).get("workmode");
  return (
    value !== null && ["", "1", "true", "on"].includes(value.toLowerCase())
  );
}

/** Carry the host appearance/context across internal app navigation. */
export function withWorkmode(path: string, enabled: boolean) {
  const url = new URL(path, "http://st.invalid");
  if (enabled) url.searchParams.set("workmode", "1");
  else url.searchParams.delete("workmode");
  return url.pathname + url.search + url.hash;
}
