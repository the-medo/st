import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("preview auth and stream cookies cannot reuse or clear standalone credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "st-ovis-cookie-"));
  try {
    const auth = resolve("integrations/ovis/app/server/auth.ts"),
      devices = resolve("integrations/ovis/app/server/devices.ts"),
      media = resolve("integrations/ovis/app/server/file-view.ts");
    const source = `import * as a from ${JSON.stringify(auth)};import {streamCookie} from ${JSON.stringify(devices)};import {pageMediaSource} from ${JSON.stringify(media)};console.log(JSON.stringify({cookies:[a.deviceCookie('fixture',true),streamCookie('a'.repeat(32),true),a.DEVICE_COOKIE_CLEARED,a.CLEAR_LEGACY_TOKEN_COOKIE],old:a.tokenCookie(new Map([['medo_ovis_token','fixture']]))??null,media:pageMediaSource('st.example.test',true)}));`;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      env: {
        ...process.env,
        HOME: dir,
        CODEX_HOME: join(dir, "codex"),
        OVIS_STATE_DIR: join(dir, "ovis"),
        MEDO_PROJECTS: "1",
        ST_OVIS_COOKIE_PREFIX: "st_fixture",
        ST_OVIS_BASE_PATH: "/agents",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, text, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(text);
    for (const cookie of result.cookies) {
      expect(cookie).toMatch(/^st_fixture_/);
      expect(cookie).toContain("Path=/agents;");
      expect(cookie).toContain("HttpOnly; SameSite=Strict;");
    }
    expect(result.old).toBe(null);
    expect(result.media).toBe(
      "https://st.example.test/agents/api/fs/page-media/",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
