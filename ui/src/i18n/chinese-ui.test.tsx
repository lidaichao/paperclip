// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, l10n, englishPluralSuffix } from "./index";
import { displayText, enumLabel } from "./display";
import { defaultSkillMarkdown } from "../lib/skill-create";
import { formatCents, formatDate, formatProjectBudget } from "../lib/utils";

// Keep the navigation boundary inert. The real board still builds the href and
// renders the issue title; no translated function or tested component is mocked.
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, disableIssueQuicklook: _disable, ...props }: {
    children?: ReactNode;
    to: string;
    disableIssueQuicklook?: boolean;
  }) => <a href={to} {...props}>{children}</a>,
}));

let StatusIcon: typeof import("../components/StatusIcon").StatusIcon;
let PriorityIcon: typeof import("../components/PriorityIcon").PriorityIcon;
let KanbanBoard: typeof import("../components/KanbanBoard").KanbanBoard;
let resolveKanbanTargetStatus: typeof import("../components/KanbanBoard").resolveKanbanTargetStatus;
const roots: Root[] = [];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(node); });
  return container;
}

async function click(button: HTMLElement | null | undefined) {
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonNamed(name: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'))
    .find((button) => {
      const label = button.cloneNode(true) as HTMLElement;
      // SVG <title> repeats its accessible name in textContent but isn't
      // another visible label. Assert the actual menu text, not that duplicate.
      label.querySelectorAll("svg").forEach((svg) => svg.remove());
      return label.textContent?.trim() === name;
    });
}

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
  // Priority labels are deliberately evaluated on module load, as they are
  // after the production language switch reloads the page.
  ({ PriorityIcon } = await import("../components/PriorityIcon"));
  ({ StatusIcon } = await import("../components/StatusIcon"));
  ({ KanbanBoard, resolveKanbanTargetStatus } = await import("../components/KanbanBoard"));
});

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

afterEach(async () => {
  await act(async () => { while (roots.length) roots.pop()!.unmount(); });
  document.body.innerHTML = "";
  await i18n.changeLanguage("zh-CN");
});

describe("Chinese UI with the real locale catalog", () => {
  it("shows Chinese status choices while callbacks retain todo and in_progress", async () => {
    const onChange = vi.fn();
    const container = await render(<StatusIcon status="todo" onChange={onChange} showLabel />);
    expect(container.textContent).toContain("待办");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("更改状态");
    await click(container.querySelector("button"));
    await click(buttonNamed("进行中"));
    expect(onChange).toHaveBeenLastCalledWith("in_progress");
    await click(container.querySelector("button"));
    await click(buttonNamed("待办"));
    expect(onChange).toHaveBeenLastCalledWith("todo");
    expect(onChange.mock.calls).toEqual([["in_progress"], ["todo"]]);
  });

  it("shows Chinese priority choices but submits the original high enum", async () => {
    const onChange = vi.fn();
    const container = await render(<PriorityIcon priority="medium" onChange={onChange} showLabel />);
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("更改优先级");
    await click(container.querySelector("button"));
    await click(buttonNamed("高"));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("high");
  });

  it("localizes board columns without altering user text, task routes, or drag target enums", async () => {
    const title = "Review H:\\AIagent\\Luna\\tools\\agent.ts — todo / in_progress / Codex";
    const issue: Issue = {
      id: "issue-English-1", identifier: "LUN-731", companyId: "company-1",
      title, description: "Do not translate my API paths", status: "todo", priority: "high",
      workMode: "standard", parentId: null, assigneeAgentId: null, assigneeUserId: null,
      projectId: null, projectWorkspaceId: null, goalId: null, reviewPolicy: null,
      responsibleUserId: null, createdByAgentId: null, createdByUserId: null,
      issueNumber: 731, requestDepth: 0, billingCode: null, assigneeAdapterOverrides: null,
      executionWorkspaceId: null, executionWorkspacePreference: null, executionWorkspaceSettings: null,
      checkoutRunId: null, executionRunId: null, executionAgentNameKey: null,
      executionLockedAt: null, startedAt: null, completedAt: null, cancelledAt: null,
      hiddenAt: null, myLastTouchAt: null, lastExternalCommentAt: null,
      lastActivityAt: null, isUnreadForMe: false,
      labels: [], labelIds: [], createdAt: new Date("2026-09-03T00:00:00Z"),
      updatedAt: new Date("2026-09-03T00:00:00Z"),
    };
    const original = structuredClone(issue);
    const onUpdateIssue = vi.fn();
    const container = await render(<KanbanBoard issues={[issue]} onUpdateIssue={onUpdateIssue} />);
    expect(container.textContent).toContain("待办");
    expect(container.textContent).toContain("进行中");
    expect(container.textContent).toContain(title);
    expect(container.querySelector('a[href="/issues/LUN-731"]')?.textContent).toContain(title);
    expect(resolveKanbanTargetStatus("in_progress", [issue])).toBe("in_progress");
    expect(resolveKanbanTargetStatus(issue.id, [issue])).toBe("todo");
    expect(resolveKanbanTargetStatus("进行中", [issue])).toBeNull();
    expect(issue).toEqual(original);
    expect(onUpdateIssue).not.toHaveBeenCalled();
  });

  it("preserves arbitrary path and user interpolation values, including literal s and markup", async () => {
    const path = "H:\\AIagent\\Luna\\projects\\todo\\AGENTS.md";
    const userText = '<img src=x onerror="window.bad=true"> Save high / s';
    const key = "local.copy_value_value_e399427f";
    const translated = l10n(key, { v0: path, v1: userText });
    const container = await render(<p>{translated}</p>);
    expect(container.textContent).toBe(`复制 ${path} ${userText}`);
    expect(container.querySelector("img")).toBeNull();
    expect(l10n(key, { v0: "s", v1: "es" })).toBe("复制 s es");
    expect(displayText(path)).toBe(path);
    expect(enumLabel("in_progress")).toBe("进行中");
  });

  it("removes explicitly marked English plural suffixes only from Chinese presentation", async () => {
    const key = "local.value_metered_runvalue_fa4928af";
    expect(l10n(key, { v0: 2, v1: englishPluralSuffix("s") })).toBe("2 次计量运行");
    // An unmarked interpolation must never be silently treated as a suffix.
    expect(l10n(key, { v0: 2, v1: "s" })).toBe("2 次计量运行s");
    expect(englishPluralSuffix("")).toBe("");
    expect(englishPluralSuffix("es")).toBe("");
    expect(englishPluralSuffix("status")).toBe("status");
    expect(englishPluralSuffix("H:\\AIagent\\Luna\\files")).toBe("H:\\AIagent\\Luna\\files");
    await i18n.changeLanguage("en");
    expect(englishPluralSuffix("s")).toBe("s");
    expect(l10n(key, { v0: 2, v1: englishPluralSuffix("s") })).toBe("2 metered runs");
  });

  it("localizes calendar text while keeping dollar amounts and budget units intact", async () => {
    const date = new Date(2026, 8, 3, 12, 30);
    const time = date.getTime();
    const chinese = formatDate(date);
    expect(chinese).toMatch(/2026.*9.*3/);
    expect(chinese).toContain("月");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatProjectBudget({ amountCents: 123456, windowKind: "calendar_month_utc" })).toContain("月");
    expect(formatProjectBudget({ amountCents: 123456, windowKind: "lifetime" })).toBe("$1,234.56");
    await i18n.changeLanguage("en");
    expect(formatDate(date)).toBe("Sep 3, 2026");
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(date.getTime()).toBe(time);
  });

  it("keeps persisted default skill Markdown identical across interface languages", async () => {
    const chineseEmpty = defaultSkillMarkdown("", "");
    const chineseNamed = defaultSkillMarkdown("Code Review", "Read H:\\AIagent\\Luna\\AGENTS.md and keep API_KEY.");
    await i18n.changeLanguage("en");
    expect(defaultSkillMarkdown("", "")).toBe(chineseEmpty);
    expect(defaultSkillMarkdown("Code Review", "Read H:\\AIagent\\Luna\\AGENTS.md and keep API_KEY.")).toBe(chineseNamed);
    expect(chineseNamed).toContain("name: Code Review");
    expect(chineseNamed).toContain("Read H:\\AIagent\\Luna\\AGENTS.md and keep API_KEY.");
    expect(chineseNamed).toContain("## Workflow");
  });
});
