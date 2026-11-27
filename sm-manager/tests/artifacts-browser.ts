import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureApi } from "./v2-fixtures";
import { createGateway } from "../services/web-gateway/gateway";
import { excalidrawFlow } from "./excalidraw-flow";

const cache = join(homedir(), ".cache/ovis-tmp/artifacts");
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, "qa-"));
const config = join(temporary, "config.json");
await Bun.write(
  config,
  JSON.stringify({
    data_dir: join(temporary, "library"),
    publish_url: "https://artifacts.example.test",
    cli: resolve("scripts/artifacts.py"),
  }),
);
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const gatewayPort = probe.port;
probe.stop(true);
const fixture = Bun.spawn(["python3", "-u", "tests/serve_v2_fixture.py"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    ST_ARTIFACTS_FIXTURE_CONFIG: config,
    ST_ARTIFACTS_FIXTURE_GATEWAY_PORT: String(gatewayPort),
  },
});
const routes = [
  "/api/ui-config",
  "/api/snapshot",
  "/api/zed",
  "/api/dbs",
  "/api/health",
  "/api/night-mode",
];
fixture.stdin.write(
  JSON.stringify(
    Object.fromEntries(
      routes.map((path) => [
        path,
        fixtureApi(new URL("https://fixture.test" + path), "GET"),
      ]),
    ),
  ) + "\n",
);
fixture.stdin.end();
const reader = fixture.stdout.getReader();
const port = new TextDecoder().decode((await reader.read()).value).trim();
assert.match(port, /^\d+$/);
const upstream = `http://127.0.0.1:${port}`;
const gateway = createGateway({
  port: gatewayPort!,
  publicOrigin: "https://st.example.test",
  ownerLogin: "fixture@example.test",
  ownerAuth: {
    origin: "https://node.example.ts.net",
    sessionSecret: "synthetic-preview-signing-secret-32-characters",
  },
  monitorOrigin: upstream,
  ovisOrigin: upstream,
});
const base = `http://127.0.0.1:${gateway.port}`;
const browsers = join(homedir(), ".cache/ms-playwright");
const version = readdirSync(browsers)
  .filter((name) => name.startsWith("chromium-"))
  .sort()
  .at(-1)!;
const executable = [
  join(browsers, version, "chrome-linux64/chrome"),
  join(browsers, version, "chrome-linux/chrome"),
].find(existsSync);
const browser = await chromium.launch({
  headless: true,
  executablePath: executable,
  args: ["--no-sandbox"],
});
const errors: string[] = [];
const html = `<!doctype html><html><head><meta charset="utf-8"><script src="helper.js"></script><style>body{margin:0;padding:56px;background:#f2f3ef;color:#223530;font:18px system-ui}small{color:#608071;letter-spacing:3px}h1{font-size:44px;letter-spacing:-2px;margin:20px 0 12px}.flow{display:flex;align-items:center;gap:20px;margin-top:64px}.box{background:white;border:1px solid #c8d7cb;border-radius:14px;padding:28px;font-size:19px}.arrow{color:#6f8e7b}.legend{margin-top:40px;color:#6a7972}</style></head><body><small>EXAMPLE PROJECT / ARCHITECTURE</small><h1>From idea to artifact</h1><p>A little work, with a lasting place.</p><div class="flow"><div class="box">Create</div><span class="arrow">→</span><div class="box">Keep & improve</div><span class="arrow">→</span><div class="box">Share</div></div><p class="legend">Private by default. Published when ready.</p><script>document.body.dataset.ready='yes';try{parent.document.body.dataset.escape='bad'}catch{document.body.dataset.isolated='yes'}</script></body></html>`;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/artifacts");
  await page
    .getByRole("heading", { name: "A home for what you make" })
    .waitFor();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "artifacts-empty.png"),
    });
  await page.getByRole("button", { name: "Save a file", exact: true }).click();
  await page.getByLabel("Output files").setInputFiles([
    { name: "index.html", mimeType: "text/html", buffer: Buffer.from(html) },
    {
      name: "helper.js",
      mimeType: "text/javascript",
      buffer: Buffer.from(
        "document.documentElement.dataset.bundleReady = 'yes';",
      ),
    },
  ]);
  await page.getByLabel("Title", { exact: true }).fill("Architecture diagram");
  await page
    .getByLabel("Project", { exact: true })
    .last()
    .fill("Example project");
  await page.getByLabel("Folder", { exact: true }).last().fill("Diagrams");
  await page.getByLabel("Editable source").setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("Private editable notes"),
  });
  await page
    .getByRole("button", { name: "Save artifact", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Architecture diagram", exact: true })
    .waitFor();
  const artifactId = new URL(page.url()).searchParams.get("id")!;
  assert.match(artifactId, /^[a-f0-9]{32}$/);
  const frame = page.frameLocator(".artifact-preview iframe");
  await frame.locator('body[data-ready="yes"][data-isolated="yes"]').waitFor();
  assert.equal(await page.locator("body").getAttribute("data-escape"), null);
  await frame
    .locator('html[data-bundle-ready="yes"]')
    .waitFor({ timeout: 3000 });
  const privatePreview = await page
    .locator(".artifact-preview iframe")
    .getAttribute("src");
  const publicHeaders = {
    host: "st.example.test",
    origin: "null",
    "sec-fetch-site": "cross-site",
  };
  assert.equal(
    (await fetch(base + privatePreview, { headers: publicHeaders })).status,
    200,
  );
  assert.equal(
    (
      await fetch(
        base + privatePreview!.replace("index.html", "source/notes.md"),
        { headers: publicHeaders },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + privatePreview!.replace(artifactId, "b".repeat(32)), {
        headers: publicHeaders,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/artifacts", {
        headers: publicHeaders,
        redirect: "manual",
      })
    ).status,
    403,
  );

  await page
    .getByRole("button", { name: "Share artifact", exact: true })
    .click();
  await page.getByText("Shared revision 1", { exact: true }).waitFor();
  const share = await page.locator(".artifact-share a").getAttribute("href");
  const checkoutProcess = Bun.spawn(
    [
      "python3",
      "scripts/artifacts.py",
      "--config",
      config,
      "checkout",
      artifactId,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const checkout = JSON.parse(
    await new Response(checkoutProcess.stdout).text(),
  );
  assert.equal(await checkoutProcess.exited, 0);
  await Bun.write(
    join(checkout.directory, "index.html"),
    html.replace("From idea to artifact", "A clearer picture"),
  );
  const save = Bun.spawn(
    [
      "python3",
      "scripts/artifacts.py",
      "--config",
      config,
      "save",
      checkout.directory,
      "--note",
      "Clarified the heading",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  assert.equal(await save.exited, 0, await new Response(save.stderr).text());
  await page.reload();
  await page
    .getByText("Shared revision 1 · You have unpublished changes", {
      exact: true,
    })
    .waitFor();
  await page
    .frameLocator(".artifact-preview iframe")
    .getByRole("heading", { name: "A clearer picture" })
    .waitFor();
  await page.getByRole("button", { name: "Update shared version" }).click();
  await page.getByText("Shared revision 2", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".artifact-share a").getAttribute("href"),
    share,
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .locator(".artifact-history")
    .getByRole("button", { name: /^Revision 1/ })
    .click();
  await page
    .frameLocator(".artifact-preview iframe")
    .getByRole("heading", { name: "From idea to artifact" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Republish", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page
    .getByText("Shared revision 2 · You have unpublished changes", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await page
    .getByRole("button", { name: "Share artifact", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Improve with agent", exact: true })
    .click();
  await page.getByLabel("What would you like to change?").fill("Add a legend");
  await page
    .getByRole("button", { name: "Copy instructions", exact: true })
    .click();
  await page.getByLabel("Instructions ready").waitFor();
  const instructions = await page.getByLabel("Instructions ready").inputValue();
  assert(instructions.includes(artifactId));
  assert(instructions.includes(" save "));
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Organize", exact: true }).click();
  await page.getByLabel("Project", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save details", exact: true }).click();
  await page
    .getByRole("button", { name: "All artifacts", exact: true })
    .click();
  await page.getByRole("button", { name: /Architecture diagram/ }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has("id"), false);
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption("__personal");
  await page
    .getByRole("combobox", { name: "Folder", exact: true })
    .selectOption("Diagrams");
  assert.equal(await page.locator(".artifact-card").count(), 1);
  await page
    .frameLocator(".artifact-thumbnail iframe")
    .getByRole("heading", { name: "From idea to artifact" })
    .waitFor();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "artifacts-gallery.png"),
    });
  await page.getByRole("button", { name: /Architecture diagram/ }).click();
  await page
    .frameLocator(".artifact-preview iframe")
    .getByRole("heading", { name: "From idea to artifact" })
    .waitFor();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "artifacts-detail.png"),
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "All artifacts", exact: true })
    .click();
  await page.getByRole("button", { name: /Architecture diagram/ }).waitFor();
  await page
    .frameLocator(".artifact-thumbnail iframe")
    .getByRole("heading", { name: "From idea to artifact" })
    .waitFor();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "artifacts-mobile.png"),
    });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    JSON.stringify(
      await page.evaluate(() =>
        [...document.querySelectorAll("body *")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.right > innerWidth + 1;
          })
          .map((e) => ({
            tag: e.tagName,
            class: e.className,
            right: e.getBoundingClientRect().right,
          }))
          .slice(0, 12),
      ),
    ),
  );
  await excalidrawFlow(page, base, config, temporary);
  assert.deepEqual(errors, []);
  console.log(
    "Artifact browser flow passed: import, isolated preview, revise, publish, restore, revoke, improve, organize, responsive gallery.",
  );
} finally {
  await browser.close();
  gateway.stop(true);
  fixture.kill();
  await fixture.exited;
  rmSync(temporary, { recursive: true, force: true });
}
