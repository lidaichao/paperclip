// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Goal } from "@paperclipai/shared";
import { i18n } from "../i18n";
import { GoalTree } from "./GoalTree";

const mounted: Array<{ root: ReturnType<typeof createRoot>; node: HTMLDivElement }> = [];

afterEach(async () => {
  for (const { root, node } of mounted.splice(0)) {
    flushSync(() => root.unmount());
    node.remove();
  }
  await i18n.changeLanguage("en");
});

describe("GoalTree", () => {
  it("shows the goal level in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    mounted.push({ root, node });
    const goal: Goal = {
      id: "goal-1",
      companyId: "company-1",
      title: "发布 Alice",
      description: null,
      level: "company",
      status: "active",
      parentId: null,
      ownerAgentId: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    flushSync(() => root.render(<GoalTree goals={[goal]} />));

    expect(node.textContent).toContain("公司");
    expect(node.textContent).not.toContain("company");
  });
});
