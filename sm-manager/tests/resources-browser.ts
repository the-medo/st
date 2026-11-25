import assert from "node:assert/strict";
import type { Page } from "playwright-core";

// Synthetic inventory and recorded activity; no agent connection or user files.
export const resourcesFixture = `
const resourceFetch=window.fetch;
window.fetch=async(input,init)=>{
 const u=new URL(input instanceof Request?input.url:input,location.href);
 if(u.pathname==='/agents/api/medo/resources'){
  window.__resourceReads=(window.__resourceReads??0)+1;
  if(window.__resourceError)return Response.json({error:{message:'Inventory temporarily unavailable'}},{status:400});
  if(window.__holdResources)await new Promise(resolve=>window.__releaseResources=resolve);
  return Response.json({skills:[{name:'review',description:'Review a change for correctness and test coverage.',path:'/fixtures/skills/review/SKILL.md',scope:'repo',enabled:true},{name:'design',description:'Build accessible interfaces.',path:'/fixtures/skills/design/SKILL.md',scope:'user',enabled:true}],servers:[{name:'documentation',status:'connected',authStatus:'oAuth',tools:[{name:'search_docs',description:'Search the project documentation.'}],toolsUnavailable:false},{name:'tracker',status:'authenticationRequired',authStatus:'notLoggedIn',tools:[],toolsUnavailable:true}],errors:[]});
 }
 const response=await resourceFetch(input,init);
 if(u.pathname.endsWith('/conversation')&&response.ok){
  const value=await response.clone().json();
  const turn=value.turns?.findLast(t=>t.role==='assistant');
  if(turn){turn.parts.push({kind:'skill',skill:{name:'review',path:'/fixtures/skills/review/SKILL.md',evidence:'instructions',status:'loaded'}},{kind:'tool',name:'search_docs',summary:'Search docs',input:'',output:'Fixture result',call_id:'resource-fixture',mcp:{server:'documentation',tool:'search_docs',status:'completed'}});return Response.json(value);}
 }
 return response;
};`;

export async function verifyResourcesPanel(page: Page, evidence?: string) {
  const toggle = page.getByRole("button", { name: "Skills & MCPs", exact: true });
  if (evidence) await page.screenshot({ path: evidence.replace(/\.png$/, "-resources-before.png") });
  assert.equal(await page.evaluate(() => Reflect.get(window, "__resourceReads") ?? 0), 0, "Closed pane does not request inventory");
  await toggle.click();
  const panel = page.getByRole("complementary", { name: "Skills & MCPs" });
  await panel.getByText("Instructions loaded", { exact: true }).waitFor();
  await panel.getByText("1 call", { exact: true }).waitFor();
  assert.deepEqual(await panel.getByRole("group", { name: "Resource view" }).getByRole("button").allTextContents(), ["Used", "Available"]);
  assert.equal(await page.evaluate(() => Reflect.get(window, "__resourceReads") ?? 0), 0, "Used reuses loaded chat history");
  const box = (await panel.boundingBox())!;
  const chat = (await page.locator(".pane-column").boundingBox())!;
  assert(box.x >= chat.x + chat.width - 1, "Resource pane sits beside chat");
  // Desktop is non-modal: opening the pane must not trap focus away from the composer.
  await page.locator(".composer-text:visible").focus();
  assert(await page.locator(".composer-text:visible").evaluate(el => el === document.activeElement));
  if (evidence) await page.screenshot({ path: evidence.replace(/\.png$/, "-resources-used.png") });
  await panel.getByRole("button", { name: "Available", exact: true }).click();
  await panel.getByText("Connected · 1 tool", { exact: true }).waitFor();
  await panel.getByText("Sign-in needed · 0 tools", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Reflect.get(window, "__resourceReads")), 1, "Available requests inventory once");
  await panel.getByLabel("Filter resources").fill("design");
  assert.equal(await panel.locator(".resources-row").count(), 1);
  await panel.getByLabel("Filter resources").fill("");
  if (evidence) await page.screenshot({ path: evidence.replace(/\.png$/, "-resources-available.png") });
  await page.evaluate(() => Reflect.set(window, "__resourceError", true));
  await panel.getByRole("button", { name: "Refresh resources" }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(await page.evaluate(() => Reflect.get(window, "__resourceReads")), 2, "Refresh requests inventory once more");
  await page.evaluate(() => Reflect.set(window, "__resourceError", false));
  await panel.getByRole("button", { name: "Close resources" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await toggle.click();
  const sheet = page.getByRole("dialog", { name: "Skills & MCPs", exact: true });
  await sheet.waitFor();
  assert((await sheet.boundingBox())!.width <= 390, "Mobile sheet fits screen");
  if (evidence) await page.screenshot({ path: evidence.replace(/\.png$/, "-resources-mobile.png") });
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => Reflect.set(window, "__holdResources", true));
  await toggle.click();
  await panel.getByRole("button", { name: "Available", exact: true }).click();
  await page.waitForFunction(() => typeof Reflect.get(window, "__releaseResources") === "function");
  await panel.getByRole("button", { name: "Used", exact: true }).click();
  await panel.getByText("Reading resources…", { exact: true }).waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Close resources" }).click();
  await toggle.click();
  await page.evaluate(() => { Reflect.set(window, "__holdResources", false); Reflect.get(window, "__releaseResources")(); });
  await panel.getByText("Instructions loaded", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Used", exact: true }).getAttribute("aria-pressed"), "true");
  await panel.getByRole("button", { name: "Close resources" }).click();
  console.log("Resources pane passed: evidence, inventory, unknown/error states, on-demand reads, responsive layout, close/reopen isolation.");
}
