/* Workmode is a presentation filter. Keep the original catalogs and snapshot intact. */
const Workmode = (() => {
  const family = (value) => /^ydistri(?:$|[\s/_-])/i.test(String(value || "").trim());
  const workPath = (value) => String(value || "").split("/").some((part) => part.toLowerCase() === "ydistri");
  function workRepository(value) {
    try {
      const url = new URL(value);
      return url.hostname === "github.com" && ["ydistri", "ydistri-customers"].includes(url.pathname.split("/")[1].toLowerCase());
    } catch {
      return false;
    }
  }
  const projectPaths = (project) => [project.info?.primary_path, project.info?.path, ...project.worktrees.map((tree) => tree.path)].filter(Boolean);

  function scope(snapshot, groups = [], connections = []) {
    groups ||= [];
    const paths = new Set();
    const add = (...values) => values.filter(Boolean).forEach((path) => paths.add(path));
    for (const group of groups) {
      for (const repo of group.repositories) {
        if (family(group.name) || workPath(repo.primary_path))
          add(repo.primary_path, ...repo.worktrees.map((tree) => tree.path));
      }
    }
    for (const db of connections) {
      if (db.owner && (family(db.owner.group) || workPath(db.owner.primary_path)))
        add(db.owner.primary_path, db.owner.worktree_path);
    }
    const projects = (snapshot?.projects || []).filter((project) =>
      workRepository(project.info?.repository_url) || projectPaths(project).some((path) => workPath(path) || paths.has(path))
    );
    for (const project of projects) add(...projectPaths(project));
    return {
      projects,
      paths,
      groups: groups.map((group) => ({
        ...group,
        repositories: group.repositories.filter((repo) => family(group.name) || paths.has(repo.primary_path) || repo.worktrees.some((tree) => paths.has(tree.path))),
      })).filter((group) => group.repositories.length),
      connections: connections.filter((db) => db.owner
        ? family(db.owner.group) || paths.has(db.owner.primary_path) || paths.has(db.owner.worktree_path)
        : family(db.group)),
    };
  }

  function codex(snapshot, work) {
    // Shared Codex host processes cannot be attributed to a work project.
    // Match the nearest known checkout so a nested personal repository stays out.
    const trees = snapshot.projects.flatMap((project) => project.worktrees).sort((a, b) => b.path.length - a.path.length);
    const processes = snapshot.codex.processes.filter((process) => {
      const owner = trees.find((tree) => process.cwd === tree.path || process.cwd?.startsWith(tree.path + "/"));
      return owner && work.paths.has(owner.path);
    });
    const worktrees = work.projects.flatMap((project) => project.worktrees);
    return {
      ...snapshot.codex,
      recent_threads: worktrees.reduce((sum, tree) => sum + tree.recent_threads, 0),
      managed_worktrees: worktrees.filter((tree) => tree.codex_managed).length,
      processes,
      memory_bytes: processes.reduce((sum, process) => sum + process.memory_bytes, 0),
      cpu_percent: processes.reduce((sum, process) => sum + (process.cpu_percent || 0), 0),
    };
  }

  function enabled(url) {
    const value = new URL(url).searchParams.get("workmode");
    return value !== null && ["", "1", "true", "on"].includes(value.toLowerCase());
  }
  function urlFor(url, on) {
    const next = new URL(url);
    if (on) next.searchParams.set("workmode", "1");
    else next.searchParams.delete("workmode");
    return next;
  }
  return { scope, codex, enabled, urlFor };
})();
