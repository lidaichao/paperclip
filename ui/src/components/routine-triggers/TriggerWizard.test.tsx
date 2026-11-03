// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { defaultTriggerDraft, describeSchedule, RoutineTriggerWizard, webhookAgentInstructions } from "./TriggerWizard";

const { setBreadcrumbs } = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: () => {} }) }));
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => { await i18n.changeLanguage("en"); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await i18n.changeLanguage("en"); });

it("offers the shared app flow without a Fireflies-specific sender", async () => {
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook" }} routineTitle="Process meetings" routineId="routine-1" onSaveExit={() => {}} onFinish={() => {}} />));
  expect(container.textContent).toContain("Another app or script");
  expect(container.textContent).not.toContain("Fireflies");
  expect(container.textContent).toContain("publicly reachable HTTPS");
});

it("resumes generic setup with a signing secret and preserves the draft", async () => {
  const onSaveExit = vi.fn();
  await act(async () => root.render(<RoutineTriggerWizard initialDraft={{ ...defaultTriggerDraft, kind: "webhook", created: true, step: 1, availableStep: 1 }} routineTitle="Process meetings" routineId="routine-1" webhookUrl="https://paperclip.example/api/routine-triggers/public/test/fire" webhookSecret="test-signing-secret" onSaveExit={onSaveExit} onFinish={() => {}} />));
  expect(container.textContent).toContain("Secret key");
  expect(container.textContent).toContain("signing secret field");
  expect(container.textContent).not.toContain("Fireflies");
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Save & exit"))!;
  await act(async () => save.click());
  expect(onSaveExit).toHaveBeenCalledWith(expect.objectContaining({ sender: "custom", step: 1, created: true }));
});

it("explains both supported app authentication methods", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "signing-secret");
  expect(instructions).toContain("Secret key: signing-secret");
  expect(instructions).toContain("X-Hub-Signature");
  expect(instructions).toContain("Authorization: Bearer signing-secret");
  expect(instructions).toContain("They do not start the routine");
  expect(instructions).not.toContain("Fireflies");
});

it("keeps legacy bearer setup instructions accurate", () => {
  const instructions = webhookAgentInstructions("custom", "Meetings", "https://paperclip.example/webhook", "secret", true, "bearer");
  expect(instructions).toContain("Authorization: Bearer secret");
  expect(instructions).not.toContain("HMAC-SHA256");
});

it("renders schedules and setup instructions in Chinese", async () => {
  await i18n.changeLanguage("zh-CN");

  expect(
    describeSchedule({
      ...defaultTriggerDraft,
      frequency: "weekly",
      weekday: "Monday",
      time: "09:00",
    }),
  ).toBe("每周星期一 09:00");
  const instructions = webhookAgentInstructions(
    "custom",
    "部署检查",
    "https://alice.example/callback",
    "test-secret",
  );
  expect(instructions).toContain("将发送方应用连接到 Alice 例行任务");
  expect(instructions).toContain("回调通知地址：https://alice.example/callback");
  expect(instructions).toContain("在 Alice 中打开“检查连接”");
});
