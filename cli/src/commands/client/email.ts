import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { emailSendSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  resolveCommandContext,
  printOutput,
  type BaseClientOptions,
} from "./common.js";

export function registerEmailCommands(program: Command) {
  const email = program
    .command("email")
    .description(
      "显式发送并检查绑定任务的 AgentMail 对话",
    );
  addCommonClientOptions(email.command("inboxes"), {
    includeCompany: true,
  }).action(async (opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(`/api/companies/${ctx.companyId}/email/inboxes`),
      { json: true },
    );
  });
  for (const verb of ["send", "reply"] as const) {
    addCommonClientOptions(
      email
        .command(verb)
        .requiredOption(
          "--file <path>",
          "JSON 请求文件，必须包含稳定的 idempotencyKey",
        ),
      { includeCompany: true },
    ).action(async (opts: BaseClientOptions & { file: string }) => {
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      const input = emailSendSchema.parse(
        JSON.parse(await readFile(opts.file, "utf8")),
      );
      if ((verb === "reply") !== Boolean(input.conversationId))
        throw new Error(
          `${verb} 需要${verb === "reply" ? "现有对话" : "父任务和新对话"}`,
        );
      printOutput(
        await ctx.api.post(`/api/companies/${ctx.companyId}/email/send`, input),
        { json: true },
      );
    });
  }
  addCommonClientOptions(
    email.command("thread").argument("<issueId>", "邮件任务编号"),
    { includeCompany: true },
  ).action(async (issueId: string, opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(
        `/api/companies/${ctx.companyId}/email/tasks/${encodeURIComponent(issueId)}`,
      ),
      { json: true },
    );
  });
  addCommonClientOptions(
    email
      .command("delivery")
      .argument("<publicationId>", "发送操作返回的发布编号"),
    { includeCompany: true },
  ).action(async (publicationId: string, opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(
        `/api/companies/${ctx.companyId}/email/deliveries/${encodeURIComponent(publicationId)}`,
      ),
      { json: true },
    );
  });
}
