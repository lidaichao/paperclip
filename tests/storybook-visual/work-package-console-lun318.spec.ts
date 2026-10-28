import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const evidenceDir = process.env.PAPERCLIP_M2D_EVIDENCE_DIR?.trim();
const evidence: Record<string, unknown> = {};
const browserExecutable = process.env.PAPERCLIP_BROWSER_EXECUTABLE?.trim();

test.describe.configure({ mode: "serial" });
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

async function openStory(page: Page, story: "desktop" | "narrow" | "viewer" | "pending" | "error") {
  await page.goto(`/iframe.html?id=projects-work-package-console--${story}&viewMode=story`);
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("This page hit an error");
}

async function capture(page: Page, name: string) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
}

test.afterAll(() => {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "browser-evidence.json"), `${JSON.stringify({
    testedCommit: process.env.PAPERCLIP_M2D_TESTED_COMMIT ?? null,
    generatedAt: new Date().toISOString(),
    ...evidence,
  }, null, 2)}\n`);
});

test("successful live response proves running animation and queued truth", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openStory(page, "desktop");
  const running = page.locator('[data-testid="work-record-status"][data-state="running"]');
  const queued = page.locator('[data-testid="work-record-status"][data-state="queued"]');
  await expect(running).toHaveAttribute("data-animated", "true");
  await expect(queued).toHaveAttribute("data-animated", "false");
  const animationCount = await running.locator(".motion-safe\\:animate-ping").evaluate((node) => node.getAnimations().length);
  expect(animationCount).toBeGreaterThan(0);
  evidence.running = { animated: true, animationCount, queuedVisible: true };
  await capture(page, "desktop-running-queued");
});

test("viewer sees facts and role explanations while write actions stay disabled", async ({ page }) => {
  await openStory(page, "viewer");
  await expect(page.getByText("当前为只读权限", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "PO 验收通过" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "预览整个工作包" })).toBeEnabled();
  evidence.viewer = { factsReadable: true, poWriteDisabled: true, previewEnabled: true };
  await capture(page, "viewer-permission-explanation");
});

test("pending, error, and offline states fail closed without running animation", async ({ page, context }) => {
  for (const story of ["pending", "error"] as const) {
    await openStory(page, story);
    const unknown = page.locator('[data-testid="work-record-status"][data-state="unknown"]').first();
    await expect(unknown).toHaveAttribute("data-animated", "false");
    evidence[story] = { state: "unknown", animated: false };
    await capture(page, `live-${story}`);
  }
  await openStory(page, "desktop");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByText("当前离线", { exact: false })).toBeVisible();
  await expect(page.locator('[data-testid="work-record-status"][data-state="unknown"]').first()).toHaveAttribute("data-animated", "false");
  evidence.offline = { state: "unknown", animated: false };
  await capture(page, "live-offline");
});

test("390px controls keep 44px touch targets", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await openStory(page, "narrow");
  const targets = page.locator("button, a, select, textarea, label:has(input[type=checkbox])");
  const sizes = await targets.evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { tag: node.tagName, text: node.textContent?.trim().slice(0, 40), width: box.width, height: box.height };
  }));
  expect(sizes.filter((item) => item.width > 0 && item.height > 0 && (item.width < 44 || item.height < 44))).toEqual([]);
  evidence.narrow = { viewport: "390x844", targetsChecked: sizes.length, minimumCssPixels: 44 };
  await capture(page, "narrow-390px");
  await context.close();
});

test("reduced motion removes the running pulse", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStory(page, "desktop");
  const running = page.locator('[data-testid="work-record-status"][data-state="running"]');
  await expect(running).toHaveAttribute("data-animated", "true");
  const animationCount = await running.locator(".motion-safe\\:animate-ping").evaluate((node) => node.getAnimations().length);
  expect(animationCount).toBe(0);
  evidence.reducedMotion = { semanticRunning: true, animationCount };
  await capture(page, "reduced-motion");
});
