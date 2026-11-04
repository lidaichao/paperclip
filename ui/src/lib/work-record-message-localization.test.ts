import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import { localizeWorkRecordRecoveryMessage } from "./work-record-message-localization";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("work record recovery message localization", () => {
  it.each([
    ["projection_stale", "执行投影已过期，请重新核对。"],
    ["Release is waiting for durable delivery", "正在等待可靠交付完成。"],
    [null, "状态需要重新核对。"],
  ])("localizes known recovery state %s", async (message, expected) => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeWorkRecordRecoveryMessage(message)).toBe(expected);
  });

  it("preserves an unknown diagnostic", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(localizeWorkRecordRecoveryMessage("Delivery worker returned exit code 7")).toBe(
      "Delivery worker returned exit code 7",
    );
  });
});
