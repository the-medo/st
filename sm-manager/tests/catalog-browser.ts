import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type {
  Database,
  DbCatalog,
  ZedCatalog,
} from "../frontend/src/lib/types";

export async function verifyCatalogs(page: Page, base: string) {
  const branch = "feature/a-long-branch-name-for-the-database-catalog";
  const owner = {
    group: "Personal",
    repository: "Garden",
    primary_path: "/fixtures/garden",
    worktree_path: "/fixtures/worktrees/garden-feature",
    worktree: "garden-feature",
    branch,
  };
  const connection: Database = {
    id: "garden-main",
    name: "garden-development-postgresql-container-with-a-long-connection-name",
    database: "garden_analytics_with_a_long_database_name",
    engine: "PostgreSQL",
    host: "localhost",
    port: 5432,
    status: "available",
    cloudbeaver_url: "https://db.example.test/cloudbeaver/open?id=garden",
    owner,
  };
  const catalog: DbCatalog = {
    checked_at: new Date().toISOString(),
    stale: false,
    fresh_for_seconds: 180,
    connections: [
      connection,
      {
        ...connection,
        id: "garden-test",
        name: "Garden test",
        database: "test",
        status: "configured",
        cloudbeaver_url: undefined,
      },
      {
        ...connection,
        id: "garden-stopped",
        name: "Garden archive",
        database: "archive",
        status: "stopped",
        cloudbeaver_url: undefined,
        owner: {
          ...owner,
          branch: "main",
          worktree: "garden",
          worktree_path: "/fixtures/garden",
        },
      },
      {
        ...connection,
        id: "metrics",
        name: "Metrics",
        database: "metrics",
        engine: "Microsoft SQL Server",
        port: 1433,
        status: "unreachable",
        cloudbeaver_url: undefined,
        owner: {
          ...owner,
          repository: "Observatory",
          primary_path: "/fixtures/observatory",
          branch: "main",
        },
      },
      {
        ...connection,
        id: "detached",
        name: "Detached database",
        database: "detached",
        owner: {
          ...owner,
          repository: "Observatory",
          primary_path: "/fixtures/observatory",
          branch: null,
        },
      },
      {
        ...connection,
        id: "external",
        name: "Shared SQL Server",
        database: "shared",
        engine: "Microsoft SQL Server",
        host: "2001:db8::1",
        port: 1433,
        owner: null,
        group: "External",
      },
    ],
  };
  const zed: ZedCatalog = {
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
          {
            name: "Observatory",
            primary_path: "/fixtures/observatory",
            worktrees: [
              {
                name: "Observatory checkout with a deliberately long name",
                path: "/fixtures/worktrees/a-very-long-path-that-must-not-resize-other-project-tables",
                revision: branch,
                zed_url: "zed://ssh/example.test/fixtures/observatory",
              },
            ],
          },
        ],
      },
    ],
    monitor_only: [
      {
        name: "Other checkout",
        path: "/fixtures/other",
        zed_url: "zed://ssh/example.test/fixtures/other",
      },
    ],
  };
  const dbRoute = "**/api/dbs",
    zedRoute = "**/api/zed";
  await page.route(dbRoute, (route) => route.fulfill({ json: catalog }));
  await page.route(zedRoute, (route) => route.fulfill({ json: zed }));
  const sameColumns = async (selector: string) => {
    const tables = await page.locator(selector).evaluateAll((tables) =>
      tables.map((table) =>
        [...table.querySelectorAll("thead th")].map((cell) => ({
          x: cell.getBoundingClientRect().x,
          width: cell.getBoundingClientRect().width,
        })),
      ),
    );
    assert(tables.length >= 3);
    for (const columns of tables.slice(1))
      for (let i = 0; i < columns.length; i++) {
        assert(
          Math.abs(columns[i]!.x - tables[0]![i]!.x) <= 1,
          "Column starts align across projects",
        );
        assert(
          Math.abs(columns[i]!.width - tables[0]![i]!.width) <= 1,
          "Column widths align across projects",
        );
      }
  };
  try {
    await page.goto(`${base}/zed`);
    await page.locator(".st-zed-table").nth(2).waitFor();
    await sameColumns(".st-zed-table");
    assert.equal(
      await page
        .locator('.st-zed-table a.st-launch img[src="/zed.svg"]')
        .count(),
      3,
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: "Open /fixtures/garden in Zed",
          exact: true,
        })
        .getAttribute("href"),
      "zed://ssh/example.test/fixtures/garden",
    );
    if (process.env.ST_V2_CATALOG_EVIDENCE)
      await page.screenshot({
        path: process.env.ST_V2_CATALOG_EVIDENCE + "-zed.png",
      });
    await page.goto(`${base}/dbs`);
    await page.locator(".st-db-table").nth(2).waitFor();
    await sameColumns(".st-db-table");
    assert.equal(
      await page.locator(".st-db-table").count(),
      3,
      "Worktrees share their repository table",
    );
    assert.equal(await page.locator(".st-db-table tbody tr").count(), 6);
    assert.equal(
      await page.locator('.st-db-table a.st-launch img[src="/db.svg"]').count(),
      3,
      "Only available databases launch",
    );
    assert.equal(
      await page
        .locator(".st-db-table tbody tr")
        .first()
        .locator("td")
        .nth(1)
        .innerText(),
      branch,
    );
    assert(
      await page
        .locator(".st-db-table tbody tr")
        .first()
        .locator("td")
        .nth(2)
        .locator("span")
        .evaluate(
          (el) =>
            el.scrollWidth > el.clientWidth &&
            getComputedStyle(el).textOverflow === "ellipsis",
        ),
    );
    assert.equal(
      await page
        .locator(".st-engine-icon")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      true,
    );
    const colors = await page
      .locator(".st-db-status")
      .evaluateAll((tags) => [
        ...new Set(tags.map((tag) => getComputedStyle(tag).color)),
      ]);
    assert.equal(
      colors.length,
      4,
      "Each database status has a distinct tag color",
    );
    const trigger = page
      .getByRole("button", { name: branch, exact: true })
      .first();
    const tooltip = page.locator(".st-details-tooltip:popover-open");
    await trigger.hover();
    await tooltip.waitFor();
    const details = await tooltip.innerText();
    for (const text of [
      branch,
      owner.worktree,
      owner.worktree_path,
      connection.name,
      connection.database,
    ])
      assert(details.includes(text));
    await tooltip.hover();
    assert(await tooltip.isVisible());
    if (process.env.ST_V2_CATALOG_EVIDENCE)
      await page.screenshot({
        path: process.env.ST_V2_CATALOG_EVIDENCE + "-dbs.png",
      });
    await page.keyboard.press("Escape");
    await tooltip.waitFor({ state: "hidden" });
    await trigger.focus();
    await tooltip.waitFor();
    await page.keyboard.press("Escape");
    await tooltip.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    await tooltip.waitFor();
    const box = (await tooltip.boundingBox())!;
    assert(
      box.x >= 0 &&
        box.x + box.width <= 390 &&
        box.y >= 0 &&
        box.y + box.height <= 844,
      JSON.stringify(box),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (process.env.ST_V2_CATALOG_EVIDENCE)
      await page.screenshot({
        path: process.env.ST_V2_CATALOG_EVIDENCE + "-mobile.png",
      });
    await page.getByRole("heading", { name: "Personal", exact: true }).click();
    await tooltip.waitFor({ state: "hidden" });
    const touch = await page
      .context()
      .browser()!
      .newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
    try {
      await touch.route(dbRoute, (route) => route.fulfill({ json: catalog }));
      await touch.goto(`${base}/dbs`);
      await touch
        .getByRole("button", { name: branch, exact: true })
        .first()
        .tap();
      const tip = touch.locator(".st-details-tooltip:popover-open");
      await tip.waitFor();
      assert((await tip.innerText()).includes(connection.database));
      await touch.getByRole("heading", { name: "Personal", exact: true }).tap();
      await tip.waitFor({ state: "hidden" });
    } finally {
      await touch.close();
    }
    catalog.stale = true;
    await page.reload();
    await page.getByText(/Stale catalog · launch links disabled/).waitFor();
    assert.equal(await page.locator(".st-db-table a.st-launch").count(), 0);
  } finally {
    await page.unroute(dbRoute);
    await page.unroute(zedRoute);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
}
