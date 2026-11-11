import { expect, type Locator, type Page } from "@playwright/test";

export type DemoSurface = "plan" | "gantt" | "defect" | "mine";
export type DemoViewport = { width: number; height: number; label: string };
export type GeometryRect = { x: number; y: number; width: number; height: number };
export type GeometrySnapshot = Record<string, GeometryRect>;

export const DEMO_VIEWPORTS: DemoViewport[] = [
  { width: 1024, height: 768, label: "1024x768" },
  { width: 1319, height: 1012, label: "1319x1012" },
  { width: 1540, height: 1117, label: "1540x1117" },
  { width: 1574, height: 1038, label: "1574x1038" },
];

export async function geometryRect(locator: Locator, label: string): Promise<GeometryRect> {
  await expect(locator, label).toBeVisible();
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return Boolean(box && box.width > 0 && box.height > 0);
  }, { message: `${label} 应完成布局`, timeout: 5_000 }).toBe(true);
  return locator.evaluate((element) => {
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  });
}

export function expectGeometryWithin(
  actual: GeometrySnapshot,
  expected: GeometrySnapshot,
  label: string,
  tolerance = 1,
) {
  for (const key of Object.keys(expected)) {
    expect(actual[key], `${label} 缺少 ${key} 几何锚点`).toBeDefined();
    if (!actual[key]) continue;
    for (const field of ["x", "y", "width", "height"] as const) {
      expect.soft(
        Math.abs(actual[key][field] - expected[key][field]),
        `${label} ${key}.${field} 几何误差`,
      ).toBeLessThanOrEqual(tolerance);
    }
  }
}

export async function screenshotDifference(page: Page, reference: Buffer, implementation: Buffer) {
  const result = await page.evaluate(async ({ referenceUrl, implementationUrl }) => {
    const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("截图无法解码"));
      image.src = src;
    });
    const [left, right] = await Promise.all([load(referenceUrl), load(implementationUrl)]);
    if (left.width !== right.width || left.height !== right.height) {
      return { dimensionsMatch: false, differenceRatio: 1, heatmapUrl: "" };
    }
    const canvas = document.createElement("canvas");
    canvas.width = left.width;
    canvas.height = left.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("无法创建截图比较画布");
    context.drawImage(left, 0, 0);
    const a = context.getImageData(0, 0, left.width, left.height).data;
    context.clearRect(0, 0, left.width, left.height);
    context.drawImage(right, 0, 0);
    const b = context.getImageData(0, 0, right.width, right.height).data;
    const output = context.createImageData(left.width, left.height);
    let changed = 0;
    for (let index = 0; index < a.length; index += 4) {
      const delta = Math.abs(a[index] - b[index]) + Math.abs(a[index + 1] - b[index + 1]) + Math.abs(a[index + 2] - b[index + 2]);
      const differs = delta > 30;
      if (differs) changed += 1;
      output.data[index] = differs ? 230 : Math.round((a[index] + b[index]) / 8);
      output.data[index + 1] = differs ? 55 : Math.round((a[index + 1] + b[index + 1]) / 8);
      output.data[index + 2] = differs ? 55 : Math.round((a[index + 2] + b[index + 2]) / 8);
      output.data[index + 3] = differs ? 255 : 110;
    }
    context.putImageData(output, 0, 0);
    return {
      dimensionsMatch: true,
      differenceRatio: changed / (left.width * left.height),
      heatmapUrl: canvas.toDataURL("image/png"),
    };
  }, {
    referenceUrl: `data:image/png;base64,${reference.toString("base64")}`,
    implementationUrl: `data:image/png;base64,${implementation.toString("base64")}`,
  });
  return {
    dimensionsMatch: result.dimensionsMatch,
    differenceRatio: result.differenceRatio,
    heatmap: result.heatmapUrl ? Buffer.from(result.heatmapUrl.split(",", 2)[1], "base64") : Buffer.alloc(0),
  };
}
