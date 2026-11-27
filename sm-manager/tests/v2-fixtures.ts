import type { Snapshot, UiConfig } from "../frontend/src/lib/types";
import { githubFixture } from "./github-fixture";
export const snapshot: Snapshot = {
  timestamp: Date.now() / 1000,
  interval: 10,
  stale: false,
  system: {
    hostname: "fixture-machine",
    cores: 8,
    cpu_percent: 12.5,
    memory_total: 32e9,
    memory_used: 8e9,
    swap_used: 0,
    swap_total: 8e9,
  },
  projects: [
    {
      id: "project1",
      name: "Garden",
      memory_bytes: 1024 ** 3,
      cpu_percent: 2,
      running_worktrees: 1,
      container_count: 1,
      process_count: 1,
      info: {
        description: "A fixture project",
        languages: ["TypeScript"],
        version: "1.0.0",
        primary_path: "/fixtures/garden",
        repository_url: "https://example.test/garden",
      },
      worktrees: [
        {
          id: "tree1",
          project_id: "project1",
          path: "/fixtures/garden",
          branch: "main",
          is_main: true,
          codex_managed: false,
          running: true,
          memory_bytes: 1024 ** 3,
          cpu_percent: 2,
          ports: [3000],
          urls: [{ port: 3000, url: "https://garden.example.test" }],
          recent_threads: 1,
          last_codex_activity: Date.now() / 1000 - 7200,
          processes: [
            {
              name: "node",
              pid: 123,
              ppid: 1,
              start_ticks: 42,
              cwd: "/fixtures/garden",
              ownership: "cwd",
              memory_bytes: 1024 ** 3,
              cpu_percent: 2,
              ports: [3000],
            },
          ],
          containers: [
            {
              id: "fixture-container",
              name: "garden-db",
              image: "postgres",
              ports: [5432],
              pids: 3,
              stats_available: true,
              ownership: "label",
              worktree_id: "tree1",
              memory_bytes: 512e6,
              cpu_percent: 0.2,
            },
          ],
        },
      ],
    },
  ],
  totals: {
    memory_bytes: 1024 ** 3,
    cpu_percent: 2,
    project_count: 1,
    worktree_count: 1,
    running_worktrees: 1,
  },
  codex: {
    available: true,
    status: "Available",
    thread_count: 8,
    recent_threads: 2,
    managed_worktrees: 0,
    processes: [],
    memory_bytes: 0,
    cpu_percent: 0,
  },
  docker: { available: true, status: "Connected" },
  other_processes: [],
  unassigned_containers: [],
  warnings: [],
  machine_health: {
    checks: [
      {
        id: "docker",
        label: "Docker",
        value: "Connected",
        detail: "Fixture only",
        status: "ok",
      },
    ],
  },
  cleanup_candidates: [
    {
      worktree_id: "tree1",
      project_name: "Garden",
      branch: "main",
      path: "/fixtures/garden",
      memory_bytes: 1024 ** 3,
      cpu_average: 0.2,
      observed_seconds: 1000,
    },
  ],
};
export const ui: UiConfig = {
  planner: true,
  ovis: false,
  printer_url: null,
  services: [
    {
      name: "Books",
      url: "https://books.example.test",
      description: "Your library",
      category: "Listen",
      icon: "headphones",
      tone: "amber",
    },
    {
      name: "System monitor",
      url: "#overview",
      description: "Resources and activity",
      category: "System",
      icon: "system",
      tone: "mint",
      destination: "Overview",
    },
  ],
};
export function fixtureApi(url: URL, method: string) {
  const p = url.pathname;
  const now = Date.now() / 1000;
  if (p === "/api/ui-config") return ui;
  if (p === "/api/artifacts")
    return { artifacts: [], token: "synthetic-artifacts-token" };
  if (p === "/api/github") return githubFixture;
  if (p === "/api/health") return { status: "ok" };
  if (p === "/api/snapshot") return snapshot;
  if (p === "/api/history")
    return {
      entity: url.searchParams.get("entity"),
      hours: Number(url.searchParams.get("hours")),
      bucket_seconds: 60,
      started_at: now - 600,
      points: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - 600 + i * 60,
        memory_bytes: 8e9 + i * 1e7,
        cpu_percent: 10 + i,
        cpu_peak: 20,
        memory_peak: 9e9,
      })),
    };
  if (p === "/api/zed")
    return {
      groups: [
        {
          name: "Personal",
          repositories: [
            {
              name: "Garden",
              primary_path: "/fixtures/garden",
              worktrees: [
                {
                  name: "Garden",
                  path: "/fixtures/garden",
                  revision: "main",
                  is_main: true,
                  zed_url: "zed://ssh/example.test/fixtures/garden",
                },
              ],
            },
          ],
        },
      ],
      monitor_only: [],
    };
  if (p === "/api/dbs")
    return {
      checked_at: new Date().toISOString(),
      stale: false,
      fresh_for_seconds: 180,
      connections: [
        {
          id: "db",
          name: "Garden DB",
          database: "garden",
          engine: "PostgreSQL",
          host: "localhost",
          port: 5432,
          status: "available",
          group: "Personal",
          cloudbeaver_url:
            "https://db.example.test/cloudbeaver/open?id=fixture",
        },
      ],
    };
  if (p === "/api/disk-usage")
    return {
      scanning: null,
      projects: {
        project1: {
          bytes: 2e9,
          scanned_at: now,
          partial: true,
          worktrees: [
            {
              worktree_id: "tree1",
              branch: "main",
              path: "/fixtures/garden",
              bytes: 2e9,
              partial: true,
              notes: ["Time limit"],
              categories: {
                dependencies: 1e9,
                build_cache: 5e8,
                git: 3e8,
                other: 2e8,
              },
            },
          ],
        },
      },
    };
  if (p.startsWith("/api/cleanup-plan/"))
    return {
      prompt:
        "Verify fresh ownership and preserve databases, source and volumes.",
      resources: { processes: [{ pid: 123, start_ticks: 42 }] },
    };
  if (p === "/api/faceplate") return null;
  if (p === "/api/night-mode")
    return {
      available: true,
      night_mode: method === "POST",
      mode: "desktop",
      token: "fixture-only",
    };
  if (p === "/api/air-quality")
    return {
      enabled: true,
      source_url: "https://example.test/air",
      raw_url: "https://example.test/raw",
      latest: {
        timestamp: now,
        co2: 700,
        temperature: 22,
        humidity: 45,
        pm25: 5,
      },
      stale: false,
      error: null,
      now,
      hours: Number(url.searchParams.get("hours")),
      bucket_seconds: 60,
      poll_seconds: 60,
      started_at: now - 600,
      points: Array.from({ length: 10 }, (_, i) => ({
        timestamp: now - 600 + i * 60,
        co2: 700 + i * 10,
        co2_peak: 850,
        temperature: 22,
        humidity: 45,
        pm25: 5,
        pm25_peak: 7,
      })),
      daily: { pm25: { value: 5, coverage: 1, complete: true } },
    };
  return { error: "Unknown fixture API" };
}
