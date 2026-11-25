import type { GitHubData, GitHubTask } from "../frontend/src/features/GitHub";
const task = (
  id: string,
  status: string,
  assignees = ["owner"],
): GitHubTask => ({
  id,
  kind: "ISSUE",
  title: `${status} sprint task`,
  number: Number(id),
  url: `https://github.com/example/service/issues/${id}`,
  repository: "example/service",
  state: status === "Done" ? "CLOSED" : "OPEN",
  status,
  completed: ["Done", "Delivered"].includes(status),
  assignees,
  labels: ["enhancement"],
  sprint_id: "sprint",
  sprint: "Sprint 19",
  updated_at: new Date().toISOString(),
  pull_requests: [
    {
      number: 42,
      title: "Ship feature",
      url: "https://github.com/example/service/pull/42",
      state: "OPEN",
    },
  ],
});
export const githubFixture: GitHubData = {
  organization: "example",
  username: "owner",
  project_url: "https://github.com/orgs/example/projects/6",
  sprint_url: "https://github.com/orgs/example/projects/6/views/2",
  backlog_url: "https://github.com/orgs/example/projects/6/views/5",
  refreshing: false,
  refresh_after: 0,
  cache_seconds: 3600,
  project: {
    updated_at: Date.now() / 1000,
    stale: false,
    error: null,
    data: {
      title: "Example",
      current_sprint: {
        id: "sprint",
        title: "Sprint 19",
        startDate: "2026-11-20",
        endDate: "2026-12-03",
      },
      sprint_tasks: [
        task("1", "In Progress"),
        task("2", "Done"),
        task("3", "Delivered"),
      ],
      backlog: [
        task("1", "In Progress"),
        {
          ...task("4", "Todo", ["teammate"]),
          title: "Backlog improvement",
          sprint: null,
          sprint_id: null,
          repository: "example/platform",
        },
      ],
    },
  },
  pull_requests: {
    updated_at: Date.now() / 1000,
    stale: false,
    error: null,
    data: [
      {
        id: "pr",
        title: "Ship feature",
        number: 42,
        url: "https://github.com/example/service/pull/42",
        repository: "example/service",
        draft: true,
        review: "CHANGES_REQUESTED",
        mergeable: "CONFLICTING",
        checks: "FAILURE",
        additions: 32,
        deletions: 7,
        updated_at: new Date().toISOString(),
      },
    ],
  },
};
