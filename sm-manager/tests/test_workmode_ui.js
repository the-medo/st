const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const context = { URL };
vm.runInNewContext(readFileSync(join(__dirname, "../sm_manager/static/workmode.js"), "utf8") + "\nthis.workmode = Workmode;", context);
const workmode = context.workmode;

function project(id, path, extra = {}) {
  return { id, info: { primary_path: path, ...extra }, worktrees: [
    { path, recent_threads: 1, codex_managed: false },
    { path: `/checkouts/${id}`, recent_threads: 2, codex_managed: true },
  ] };
}
const ids = (items) => Array.from(items, (item) => item.id);

test("bookmarks, URL updates, and disabled values preserve other parameters and the selected page", () => {
  for (const value of ["", "1", "true", "on", "TRUE"])
    assert.equal(workmode.enabled(`https://monitor.example/?workmode=${value}#projects`), true);
  for (const suffix of ["", "?workmode=0", "?workmode=false", "?workmode=off", "?workmode=unknown"])
    assert.equal(workmode.enabled(`https://monitor.example/${suffix}`), false);
  const original = "https://monitor.example/?extra=keep#dbs";
  const enabled = workmode.urlFor(original, true);
  assert.equal(enabled.href, "https://monitor.example/?extra=keep&workmode=1#dbs");
  assert.equal(workmode.urlFor(enabled, false).href, original);
});

test("work repositories include all linked checkouts without matching personal names or branches", () => {
  const projects = [
    project("work", "/dev/ydistri/app"),
    project("remote", "/dev/math", { repository_url: "https://github.com/ydistri/forecast-math" }),
    project("customer", "/dev/customer", { repository_url: "https://github.com/ydistri-customers/example" }),
    project("personal", "/dev/ydistri-notes"),
    project("misleading", "/dev/personal", { repository_url: "https://github.com/personal/ydistri" }),
  ];
  projects[3].worktrees[1].branch = "feature/ydistri";
  const before = JSON.stringify(projects);
  const scope = workmode.scope({ projects });
  assert.deepEqual(ids(scope.projects), ["work", "remote", "customer"]);
  assert.ok(scope.paths.has("/checkouts/work"));
  assert.equal(JSON.stringify(projects), before, "the overview snapshot must stay intact");
});

test("catalog family and database ownership classify arbitrary checkout paths, including delayed catalogs", () => {
  const snapshot = { projects: [project("catalog", "/dev/app"), project("db", "/dev/integration"), project("personal", "/dev/personal")] };
  const groups = [{ name: "YDISTRI", repositories: [{ primary_path: "/dev/app", worktrees: [{ path: "/checkouts/catalog" }] }] }];
  const connections = [{ id: "owned", owner: { group: "ydistri", primary_path: "/dev/integration", worktree_path: "/checkouts/db" } }];
  assert.equal(workmode.scope(snapshot, null).projects.length, 0);
  const result = workmode.scope(snapshot, groups, connections);
  assert.deepEqual(ids(result.projects), ["catalog", "db"]);
  assert.deepEqual(ids(result.connections), ["owned"]);
  assert.equal(result.groups.length, 1);
  assert.equal(workmode.scope(null, groups, connections).groups.length, 1);
});

test("DB filtering includes Ydistri DEV and PROD but excludes personal and unassigned databases", () => {
  const snapshot = { projects: [project("work", "/dev/ydistri/app")] };
  const connections = [
    { id: "dev", group: "Ydistri DEV", owner: null },
    { id: "prod", group: "Ydistri PROD", owner: null },
    { id: "owned", owner: { worktree_path: "/checkouts/work" } },
    { id: "personal", group: "Personal", owner: null },
    { id: "unassigned", name: "ydistri-db", owner: null },
    { id: "similar", group: "ydistribution", owner: null },
  ];
  const before = JSON.stringify(connections);
  assert.deepEqual(ids(workmode.scope(snapshot, [], connections).connections), ["dev", "prod", "owned"]);
  assert.equal(JSON.stringify(connections), before);
});

test("mixed Zed groups retain only work repositories and drop empty families", () => {
  const snapshot = { projects: [project("work", "/dev/ydistri/app")] };
  const groups = [
    { name: "Mixed", repositories: [
      { id: "work", primary_path: "/dev/ydistri/app", worktrees: [] },
      { id: "personal", primary_path: "/dev/personal", worktrees: [] },
    ] },
    { name: "Personal", repositories: [{ primary_path: "/dev/other", worktrees: [] }] },
  ];
  const result = workmode.scope(snapshot, groups);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(ids(result.groups[0].repositories), ["work"]);
  assert.equal(groups[0].repositories.length, 2);
});

test("Codex shows work checkout activity and excludes shared, personal, and path-prefix lookalike processes", () => {
  const snapshot = {
    projects: [project("work", "/dev/ydistri/app"), project("personal", "/dev/personal")],
    codex: { recent_threads: 99, processes: [
      { id: "work", cwd: "/checkouts/work/src", memory_bytes: 64, cpu_percent: 2 },
      { id: "shared", cwd: "/home/user", memory_bytes: 100, cpu_percent: 3 },
      { id: "personal", cwd: "/dev/personal", memory_bytes: 200, cpu_percent: 4 },
      { id: "similar", cwd: "/checkouts/work-other", memory_bytes: 300, cpu_percent: 5 },
    ] },
  };
  const result = workmode.codex(snapshot, workmode.scope(snapshot));
  assert.deepEqual(ids(result.processes), ["work"]);
  assert.equal(result.memory_bytes, 64);
  assert.equal(result.cpu_percent, 2);
  assert.equal(result.recent_threads, 3);
  assert.equal(result.managed_worktrees, 1);
  assert.equal(snapshot.codex.processes.length, 4);
});

function dashboard() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, value: "", checked: false, innerHTML: "", attributes: {},
      classList: { toggle() {} }, addEventListener() {}, removeAttribute() {},
      setAttribute(key, value) { this.attributes[key] = value; },
      close() { this.open = false; },
    });
    return elements.get(id);
  };
  const ui = {
    URL, AbortSignal, setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: () => new Promise(() => {}),
    location: new URL("https://monitor.example/"),
    document: { getElementById: element, querySelector: element, querySelectorAll: () => [],
      documentElement: { dataset: {} }, addEventListener() {} },
    window: { addEventListener() {} },
    ResizeObserver: class { observe() {} },
    createNightMode: () => ({ refresh() {} }), initAirQuality() {},
  };
  ui.history = { replaceState(_state, _unused, url) { ui.location = new URL(url); } };
  vm.createContext(ui);
  for (const name of ["workmode", "dbs", "app"])
    vm.runInContext(readFileSync(join(__dirname, `../sm_manager/static/${name}.js`), "utf8"), ui);
  vm.runInContext("this.state = state; this.$ = $;", ui);
  return ui;
}

test("project, container, and storage views switch scope without changing the overview snapshot", () => {
  const ui = dashboard();
  const projects = [project("work", "/dev/ydistri/app"), project("personal", "/dev/personal")];
  for (const p of projects) {
    p.name = p.id;
    p.memory_bytes = 1;
    p.worktrees.forEach((tree, i) => Object.assign(tree, {
      branch: `branch-${i}`, running: true, containers: [{ id: `${p.id}-${i}`, memory_bytes: 1 }],
    }));
  }
  ui.state.snapshot = { projects, unassigned_containers: [{ id: "unassigned", memory_bytes: 1 }] };
  const original = JSON.stringify(ui.state.snapshot);
  ui.state.workmode = true;
  ui.state.view = "projects";
  assert.deepEqual(ids(ui.matchingProjects()), ["work"]);
  assert.deepEqual(ids(ui.allContainers()), ["work-0", "work-1"]);
  ui.renderStorage();
  assert.match(ui.$("storage-projects").innerHTML, /data-scan-project="work"/);
  assert.doesNotMatch(ui.$("storage-projects").innerHTML, /data-scan-project="personal"/);
  ui.state.view = "overview";
  assert.deepEqual(ids(ui.matchingProjects()), ["personal", "work"]);
  ui.state.workmode = false;
  ui.state.view = "projects";
  assert.deepEqual(ids(ui.matchingProjects()), ["personal", "work"]);
  assert.equal(ui.allContainers().length, 5);
  ui.renderStorage();
  assert.match(ui.$("storage-projects").innerHTML, /data-scan-project="personal"/);
  assert.equal(JSON.stringify(ui.state.snapshot), original);
});

test("device bookmarks fall back to overview and URL changes restore normal navigation", () => {
  const ui = dashboard();
  for (const device of ["faceplate", "air-quality"]) {
    ui.location = new URL(`https://monitor.example/?keep=yes&workmode=1#${device}`);
    ui.setView();
    assert.equal(ui.state.view, "overview");
    assert.equal(ui.location.hash, "#overview");
    assert.equal(ui.location.searchParams.get("keep"), "yes");
    assert.equal(ui.document.querySelector(".sidebar-devices").hidden, true);
    assert.equal(ui.$("workmode-toggle").attributes["aria-checked"], "true");
  }
  ui.location = new URL("https://monitor.example/?keep=yes#projects");
  ui.setView();
  assert.equal(ui.state.view, "projects");
  assert.equal(ui.state.workmode, false);
  assert.equal(ui.document.querySelector(".sidebar-devices").hidden, false);
  assert.equal(ui.$("workmode-toggle").attributes["aria-checked"], "false");
});
