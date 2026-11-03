import { afterEach, describe, expect, it } from "vitest";
import type { PipelineCaseEvent } from "@/api/pipelines";
import { i18n } from "@/i18n";
import {
  formatFieldValue,
  formatPipelineItemEvent,
  itemHasChangedNotice,
} from "./pipeline-item-detail";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("pipeline item detail localization", () => {
  it("formats fields, notices, and events in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");

    expect(formatFieldValue(null)).toBe("无");
    expect(formatFieldValue(true)).toBe("是");
    expect(itemHasChangedNotice({ fields: { upstreamChanged: true } })).toEqual({
      title: "此项已更改",
      body: "此条目创建后，上游工作已发生变化。继续前请查看最新详情。",
    });
    expect(
      formatPipelineItemEvent(
        {
          type: "case.transitioned",
          actorType: "system",
          payload: { transitionClass: "automatic", reason: "children_terminal" },
          fromStageId: "todo",
          toStageId: "done",
        } as unknown as PipelineCaseEvent,
        { todo: "待处理", done: "已完成" },
      ),
    ).toBe("已从“待处理”移动到“已完成”——自动执行（所有子条目均已完成）。");
    expect(
      formatPipelineItemEvent({
        type: "case.reviewed",
        payload: { decision: "request_changes" },
      } as unknown as PipelineCaseEvent),
    ).toBe("评审要求修改。");
  });
});
