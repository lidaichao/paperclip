// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n";
import { SlackCapabilitiesView } from "./SlackToolSettings";

const mounted: Array<{ root: ReturnType<typeof createRoot>; node: HTMLDivElement }> = [];

function render(element: ReactNode) {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  mounted.push({ root, node });
  flushSync(() => root.render(element));
  return node;
}

afterEach(async () => {
  for (const { root, node } of mounted.splice(0)) {
    flushSync(() => root.unmount());
    node.remove();
  }
  await i18n.changeLanguage("en");
});

describe("SlackCapabilitiesView", () => {
  it("shows localized Slack tool names", async () => {
    await i18n.changeLanguage("zh-CN");
    const node = render(
      <SlackCapabilitiesView
        capabilities={{
          grantedScopes: [],
          missingScopes: [],
          tools: [
            {
              name: "slack_post_message",
              description: "Send a message",
              risk: "write",
              available: true,
            },
            {
              name: "slack_delete_message",
              description: "Delete a message",
              risk: "approval",
              available: false,
            },
          ],
        }}
      />,
    );

    expect(node.textContent).toContain("发送 Slack 消息");
    expect(node.textContent).toContain("删除 Slack 消息");
    expect(node.textContent).not.toContain("post message");
  });
});
