export type Resource = { memory_bytes: number; cpu_percent: number | null };
export type Process = Resource & {
  pid: number;
  ppid: number;
  name: string;
  cwd: string;
  start_ticks: number;
  ports: number[];
  ownership: string;
};
export type Container = Resource & {
  id: string;
  name: string;
  image: string;
  ports: number[];
  stats_available: boolean;
  pids: number | null;
  ownership: string;
  worktree_id: string | null;
};
export type Worktree = Resource & {
  id: string;
  project_id: string;
  path: string;
  branch: string;
  is_main: boolean;
  codex_managed: boolean;
  running: boolean;
  processes: Process[];
  containers: Container[];
  ports: number[];
  urls: { url: string; port: number }[];
  recent_threads: number;
  last_codex_activity: number | null;
};
export type Project = Resource & {
  id: string;
  name: string;
  worktrees: Worktree[];
  running_worktrees: number;
  container_count: number;
  process_count: number;
  info?: {
    description?: string;
    version?: string;
    languages?: string[];
    repository_url?: string;
    primary_path?: string;
    path?: string;
    icon_url?: string;
  };
};
export type Snapshot = {
  timestamp: number;
  interval: number;
  stale: boolean;
  system: {
    hostname: string;
    platform?: string;
    cpu_percent: number | null;
    memory_total: number;
    memory_used: number;
    swap_used: number;
    swap_total: number;
    cores: number;
    uptime_seconds?: number;
  };
  projects: Project[];
  totals: Resource & {
    project_count: number;
    worktree_count: number;
    running_worktrees: number;
  };
  docker: { available: boolean; status: string };
  codex: Resource & {
    available: boolean;
    status: string;
    recent_threads: number;
    thread_count: number;
    managed_worktrees: number;
    processes: Process[];
  };
  other_processes: Process[];
  unassigned_containers: Container[];
  warnings: string[];
  machine_health?: {
    checks: {
      id: string;
      label: string;
      value: string;
      status: string;
      detail: string;
    }[];
  };
  cleanup_candidates: {
    worktree_id: string;
    project_name: string;
    branch: string;
    memory_bytes: number;
    cpu_average: number;
    observed_seconds: number;
    path: string;
  }[];
};
export type Service = {
  name: string;
  url: string;
  description: string;
  category: string;
  icon: string;
  tone: string;
  destination?: string;
};
export type UiConfig = {
  services: Service[];
  planner: boolean;
  ovis: boolean;
  printer_url: string | null;
};
export type Point = {
  timestamp: number;
  memory_bytes: number | null;
  cpu_percent: number | null;
  cpu_peak?: number;
  memory_peak?: number;
};
export type History = {
  entity: string;
  hours: number;
  bucket_seconds: number;
  started_at: number | null;
  points: Point[];
};
export type ZedTree = {
  path: string;
  branch: string;
  name?: string;
  is_main?: boolean;
  revision?: string;
  zed_url: string;
};
export type ZedRepo = {
  name: string;
  primary_path: string;
  worktrees: ZedTree[];
};
export type ZedGroup = { name: string; repositories: ZedRepo[] };
export type ZedCatalog = {
  groups: ZedGroup[];
  monitor_only?: { path: string; name: string; zed_url: string }[];
  ssh_base_url?: string;
};
export type Database = {
  id: string;
  name: string;
  database: string;
  engine: string;
  host?: string;
  port?: number;
  status: string;
  cloudbeaver_url?: string;
  group?: string;
  group_checked_at?: string;
  owner?: {
    group: string;
    repository: string;
    primary_path: string;
    worktree_path: string;
    worktree: string;
    branch: string;
  };
};
export type DbCatalog = {
  connections: Database[];
  checked_at: string;
  stale: boolean;
  fresh_for_seconds: number;
};
export type DiskUsage = {
  scanning: string | null;
  projects: Record<
    string,
    {
      bytes: number;
      scanned_at: number;
      partial: boolean;
      error?: string;
      worktrees: {
        worktree_id: string;
        branch: string;
        path: string;
        bytes: number;
        partial: boolean;
        notes: string[];
        categories: Record<string, number>;
      }[];
      docker?: {
        available: boolean;
        status: string;
        container_count: number;
        writable_bytes: number;
        image_bytes: number;
        volume_bytes: number;
        shared_images: boolean;
        shared_volumes: boolean;
        partial: boolean;
      };
    }
  >;
};
