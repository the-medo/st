import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";

/** Uses the artifact suite's disposable library; never touches live projects. */
export async function excalidrawFlow(
  page: Page,
  base: string,
  config: string,
  temporary: string,
) {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      ["python3", "scripts/artifacts.py", "--config", config, ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout);
  };
  const scenePath = join(temporary, "flow.json");
  await Bun.write(
    scenePath,
    JSON.stringify({
      elements: [
        {
          id: "input",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 180,
          height: 90,
          label: { text: "Input" },
          backgroundColor: "#d3f9d8",
        },
        {
          id: "result",
          type: "rectangle",
          x: 320,
          y: 0,
          width: 180,
          height: 90,
          label: { text: "Result" },
          backgroundColor: "#d0ebff",
        },
        {
          id: "flow",
          type: "arrow",
          x: 180,
          y: 45,
          width: 140,
          height: 0,
          start: { id: "input" },
          end: { id: "result" },
        },
      ],
    }),
  );
  const created = await cli(
    "diagram",
    scenePath,
    "--title",
    "Editable flow",
    "--project",
    "Example project",
    "--conversation",
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(created.manifest.editor.type, "excalidraw");
  assert.equal(created.project, "example-project");
  assert.equal(created.manifest.entrypoint, "diagram.svg");
  const id = created.id;
  const work = await cli("checkout", id);
  const sourcePath = join(work.directory, work.editor.source);
  const source = await Bun.file(sourcePath).json();
  assert(source.elements.find((el: any) => el.id === "input"));
  assert.equal(
    source.elements.find((el: any) => el.id === "flow").startBinding.elementId,
    "input",
  );
  assert.equal(
    source.elements.find((el: any) => el.id === "flow").endBinding.elementId,
    "result",
  );
  assert(
    (await Bun.file(join(work.directory, "diagram.svg")).text()).includes(
      "data:font",
    ),
  );
  assert(
    !(await Bun.file(join(work.directory, "diagram.svg")).text()).includes(
      "payload-start",
    ),
  );
  assert.equal(
    Buffer.from(
      await Bun.file(join(work.directory, "diagram.png")).arrayBuffer(),
    )
      .subarray(0, 8)
      .toString("hex"),
    "89504e470d0a1a0a",
  );
  const title = source.elements.find(
    (el: any) => el.type === "text" && el.text === "Input",
  );
  title.text = title.originalText = "Source";
  await Bun.write(sourcePath, JSON.stringify(source));
  await Bun.write(
    join(work.directory, "source/notes.md"),
    "Keep these private notes",
  );
  const updated = await cli(
    "save",
    work.directory,
    "--note",
    "Changed input label",
  );
  assert.equal(updated.id, id);
  assert.equal(updated.revision, 2);
  assert.notEqual(
    updated.manifest.files.find((f: any) => f.path === "diagram.svg").sha256,
    created.manifest.files.find((f: any) => f.path === "diagram.svg").sha256,
  );
  assert(
    (await Bun.file(join(work.directory, "diagram.svg")).text()).includes(
      "Source",
    ),
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  const external: string[] = [];
  const errors: string[] = [];
  const watch = (request: any) => {
    if (
      /^https?:/.test(request.url()) &&
      new URL(request.url()).origin !== base
    )
      external.push(request.url());
  };
  page.on("request", watch);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/artifacts?id=" + id);
  const conversationMutations: string[] = [];
  const watchConversation = (request: any) => {
    if (
      request.url().includes("/agents/api/") &&
      !["GET", "HEAD"].includes(request.method())
    )
      conversationMutations.push(request.method() + " " + request.url());
  };
  page.on("request", watchConversation);
  let unavailable = true;
  await page.route("**/agents/api/medo/conversation?*", async (route) => {
    assert.equal(route.request().method(), "GET");
    const query = new URL(route.request().url()).searchParams;
    assert.equal(
      query.get("pane_id"),
      "medo:00000000-0000-4000-8000-000000000001",
    );
    if (unavailable) {
      unavailable = false;
      await route.fulfill({ json: { unavailable: true } });
      return;
    }
    const older = query.has("before");
    if (older) {
      assert.equal(query.get("before"), "older");
      assert.equal(query.get("history_id"), "medo:fixture");
    }
    await route.fulfill({
      json: {
        source: "codex-transcript",
        history_id: "medo:fixture",
        cursor: older ? null : "older",
        turns: [
          {
            role: older ? "user" : "assistant",
            ts: "2026-01-01T12:00:00Z",
            turn_id: older ? "first" : "second",
            parts: [
              {
                kind: "text",
                text: older
                  ? "Please create a diagram of the input flow."
                  : "I created the editable flow diagram.",
              },
            ],
          },
        ],
      },
    });
  });
  await page
    .getByRole("button", { name: "Original conversation", exact: true })
    .click();
  const origin = page.getByRole("dialog", {
    name: "Original conversation",
    exact: true,
  });
  await origin
    .getByText(
      "The original conversation is unavailable. The artifact is still saved here.",
    )
    .waitFor();
  await origin.getByRole("button", { name: "Retry", exact: true }).click();
  await origin
    .getByText("I created the editable flow diagram.", { exact: true })
    .waitFor();
  await origin
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  await origin
    .getByText("Please create a diagram of the input flow.", { exact: true })
    .waitFor();
  assert.equal(
    await origin.locator("textarea").count(),
    0,
    "Original conversation has no message composer",
  );
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(
        process.env.ST_ARTIFACTS_EVIDENCE,
        "original-conversation.png",
      ),
    });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await origin.evaluate((el) => el.scrollWidth <= innerWidth));
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(
        process.env.ST_ARTIFACTS_EVIDENCE,
        "original-conversation-mobile.png",
      ),
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await origin
    .getByRole("button", { name: "Close original conversation" })
    .click();
  assert.deepEqual(
    conversationMutations,
    [],
    "Reading the original conversation must not change or resume it",
  );
  page.off("request", watchConversation);
  assert.equal(new URL(page.url()).searchParams.get("id"), id);
  await page.getByRole("button", { name: "Edit diagram", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Edit diagram",
    exact: true,
  });
  await editor.locator(".excalidraw canvas.interactive").waitFor();
  await editor
    .getByRole("button", { name: "Save diagram", exact: true })
    .waitFor();
  const draw = async () => {
    const canvas = page.locator(".excalidraw canvas.interactive");
    const box = (await canvas.boundingBox())!;
    // Use the real toolbar and pointer gestures, not a test-only canvas API.
    await page.locator('.excalidraw label[title^="Rectangle"]').click();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.72);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.85, {
      steps: 8,
    });
    await page.mouse.up();
    await page.getByText(/Unsaved changes/).waitFor();
  };
  await draw();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "diagram-editor.png"),
    });
  await editor
    .getByRole("button", { name: "Save diagram", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  const edited = await cli("get", id);
  assert.equal(edited.revision, 3);
  assert.equal(edited.source_chat, created.source_chat);
  assert.equal(
    edited.manifest.files.find((f: any) => f.path === "source/notes.md").role,
    "source",
  );
  const editedWork = await cli("checkout", id);
  const editedSource = await Bun.file(
    join(editedWork.directory, editedWork.editor.source),
  ).json();
  assert.equal(
    await Bun.file(join(editedWork.directory, "source/notes.md")).text(),
    "Keep these private notes",
  );
  assert.equal(editedSource.elements.length, source.elements.length + 1);
  assert(editedSource.elements.find((el: any) => el.id === "input"));
  assert.equal(
    editedSource.elements.find((el: any) => el.id === "flow").endBinding
      .elementId,
    "result",
  );

  // Hold a browser draft while an agent saves. The stale save must preserve it.
  await page.getByRole("button", { name: "Edit diagram", exact: true }).click();
  await editor.locator(".excalidraw canvas.interactive").waitFor();
  await draw();
  await cli(
    "save",
    editedWork.directory,
    "--note",
    "Concurrent agent revision",
  );
  await editor
    .getByRole("button", { name: "Save diagram", exact: true })
    .click();
  await editor.getByText(/This artifact changed/).waitFor();
  assert.equal((await cli("get", id)).revision, 4);
  assert(
    await editor
      .getByRole("button", { name: "Download .excalidraw", exact: true })
      .isEnabled(),
  );
  await editor.getByRole("button", { name: "Close diagram editor" }).click();
  await editor
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();

  // Import native JSON through the normal upload flow.
  await page.getByRole("button", { name: "Save a file", exact: true }).click();
  await page.getByLabel("Output files").setInputFiles(sourcePath);
  await page.getByLabel("Title", { exact: true }).fill("Imported drawing");
  await page
    .getByRole("button", { name: "Save artifact", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Imported drawing", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Edit diagram", exact: true })
    .waitFor();

  // New drawings are first-class artifacts, including on a narrow screen.
  await page.getByRole("button", { name: "New diagram", exact: true }).click();
  const fresh = page.getByRole("dialog", { name: "New diagram", exact: true });
  await fresh.locator(".excalidraw canvas.interactive").waitFor();
  await fresh.getByLabel("Title", { exact: true }).fill("Drawn in Herdr");
  await draw();
  await page.setViewportSize({ width: 390, height: 844 });
  await fresh.locator(".excalidraw.excalidraw--mobile").waitFor();
  if (process.env.ST_ARTIFACTS_EVIDENCE)
    await page.screenshot({
      path: join(process.env.ST_ARTIFACTS_EVIDENCE, "diagram-mobile.png"),
    });
  assert(await fresh.evaluate((element) => element.scrollWidth <= innerWidth));
  await fresh
    .getByRole("button", { name: "Save diagram", exact: true })
    .click();
  await fresh.waitFor({ state: "hidden" });
  await page
    .getByRole("heading", { name: "Drawn in Herdr", exact: true })
    .waitFor();
  assert.deepEqual(
    external,
    [],
    "Diagram editor must use local fonts and assets",
  );
  assert.deepEqual(errors, []);
  page.off("request", watch);
  console.log(
    "Excalidraw passed: CLI render/revise, native import, browser create/edit, stable IDs/bindings, stale-save recovery, local fonts, mobile.",
  );
}
