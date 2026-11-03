import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface CompanyOptions extends BaseClientOptions {
  companyId?: string;
}

interface JsonPayloadOptions extends CompanyOptions {
  payloadJson?: string;
}

interface QueryOptions extends CompanyOptions {
  query?: string;
  status?: string;
  requestType?: string;
  url?: string;
}

export function registerAccessCommands(program: Command): void {
  addWhoamiCommand(program);
  addCommonClientOptions(
    program
      .command("health")
      .description("检查 API 健康状态")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/health"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const access = program.command("access").description("访问权限与认证检查操作");
  addWhoamiCommand(access);

  addCommonClientOptions(
    program
      .command("openapi")
      .description("输出 OpenAPI 文档")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/openapi.json"), { json: true });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const profile = program.command("profile").description("当前用户资料操作");
  addSimpleGet(profile, "session", "获取认证会话", "/api/auth/get-session");
  addSimpleGet(profile, "get", "获取当前认证资料", "/api/auth/profile");
  addJsonPatch(profile, "update", "更新当前认证资料", "/api/auth/profile");
  addCommonClientOptions(
    profile
      .command("company-user")
      .description("获取公司内的用户资料")
      .argument("<userSlug>", "用户标识")
      .option("-C, --company-id <id>", "公司 ID")
      .action(async (userSlug: string, opts: CompanyOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          printOutput(await ctx.api.get(apiPath`/api/companies/${ctx.companyId}/users/${userSlug}/profile`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const invite = program.command("invite").description("邀请操作");
  addCompanyList(invite, "list", "列出公司邀请", "invites");
  addCompanyPost(invite, "create", "创建邀请", "invites");
  addCommonClientOptions(
    invite
      .command("revoke")
      .description("撤销邀请")
      .argument("<inviteId>", "邀请 ID")
      .action(async (inviteId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/invites/${inviteId}/revoke`, {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  for (const [name, suffix, description] of [
    ["show", "", "获取邀请详情"],
    ["logo", "logo", "获取邀请标志"],
    ["onboarding", "onboarding", "获取邀请引导内容"],
    ["onboarding:text", "onboarding.txt", "获取邀请引导文本"],
    ["skills:index", "skills/index", "获取邀请技能索引"],
  ] as const) {
    addCommonClientOptions(
      invite
        .command(name)
        .description(description)
        .argument("<token>", "邀请令牌")
        .action(async (token: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const path = `${apiPath`/api/invites/${token}`}${suffix ? `/${suffix}` : ""}`;
            printOutput(await ctx.api.get(path), { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
      }),
    );
  }
  addCommonClientOptions(
    invite
      .command("test-resolution")
      .description("测试邀请链接解析")
      .argument("<token>", "邀请令牌")
      .requiredOption("--url <url>", "要测试的 URL")
      .action(async (token: string, opts: QueryOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = new URLSearchParams({ url: opts.url ?? "" });
          printOutput(await ctx.api.get(`${apiPath`/api/invites/${token}/test-resolution`}?${query.toString()}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    invite
      .command("skill")
      .description("获取邀请技能的 Markdown 内容")
      .argument("<token>", "邀请令牌")
      .argument("<skillName>", "技能名称")
      .action(async (token: string, skillName: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/invites/${token}/skills/${skillName}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    invite
      .command("accept")
      .description("接受邀请")
      .argument("<token>", "邀请令牌")
      .option("--payload-json <json>", "接受邀请所需的 JSON 数据", "{}")
      .action(async (token: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/invites/${token}/accept`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const join = program.command("join").description("加入申请操作");
  addCommonClientOptions(
    join
      .command("list")
      .description("列出加入申请")
      .option("-C, --company-id <id>", "公司 ID")
      .option("--status <status>", "按状态筛选（pending_approval、approved、rejected；也接受 pending）")
      .option("--request-type <type>", "按申请类型筛选")
      .action(async (opts: QueryOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const params = new URLSearchParams();
          const status = normalizeJoinStatus(opts.status);
          if (status) params.set("status", status);
          if (opts.requestType) params.set("requestType", opts.requestType);
          const query = params.toString();
          printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}/join-requests`}${query ? `?${query}` : ""}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
  addJoinAction(join, "approve");
  addJoinAction(join, "reject");
  addCommonClientOptions(
    join
      .command("claim-key")
      .description("为已批准的加入申请领取智能体 API 密钥")
      .argument("<requestId>", "加入申请 ID")
      .requiredOption("--claim-secret <secret>", "领取密钥")
      .action(async (requestId: string, opts: BaseClientOptions & { claimSecret: string }) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/join-requests/${requestId}/claim-api-key`, { claimSecret: opts.claimSecret }), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const member = program.command("member").description("公司成员操作");
  addCompanyList(member, "list", "列出公司成员", "members");
  addCompanyList(member, "user-directory", "列出公司用户目录", "user-directory");
  addMemberPatch(member, "update", "members");
  addMemberPatch(member, "role-and-grants", "members", "role-and-grants");
  addMemberPatch(member, "permissions", "members", "permissions");
  addMemberPost(member, "archive", "members", "archive");

  const admin = program.command("admin").description("实例管理员操作");
  const user = admin.command("user").description("管理员用户操作");
  addCommonClientOptions(
    user
      .command("list")
      .description("列出用户")
      .option("--query <text>", "搜索内容")
      .action(async (opts: QueryOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const query = opts.query ? `?${new URLSearchParams({ query: opts.query }).toString()}` : "";
          printOutput(await ctx.api.get(`/api/admin/users${query}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addAdminUserPost(user, "promote", "promote-instance-admin");
  addAdminUserPost(user, "demote", "demote-instance-admin");
  addCommonClientOptions(
    user
      .command("company-access")
      .description("获取用户的公司访问权限")
      .argument("<userId>", "用户 ID")
      .action(async (userId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/admin/users/${userId}/company-access`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    user
      .command("company-access:update")
      .description("更新用户的公司访问权限")
      .argument("<userId>", "用户 ID")
      .requiredOption("--payload-json <json>", "UpdateUserCompanyAccess JSON 数据")
      .action(async (userId: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.put(apiPath`/api/admin/users/${userId}/company-access`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const instance = program.command("instance").description("实例操作");
  addSimpleGet(instance, "scheduler-heartbeats", "列出调度器心跳智能体", "/api/instance/scheduler-heartbeats");
  addSimpleGet(instance, "settings:general", "获取实例常规设置", "/api/instance/settings/general");
  addJsonPatch(instance, "settings:general:update", "更新实例常规设置", "/api/instance/settings/general");
  addSimpleGet(instance, "settings:experimental", "获取实例实验性设置", "/api/instance/settings/experimental");
  addJsonPatch(instance, "settings:experimental:update", "更新实例实验性设置", "/api/instance/settings/experimental");
  addCommonClientOptions(
    instance
      .command("database-backup")
      .description("创建数据库备份")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post("/api/instance/database-backups", {}), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const sidebar = program.command("sidebar").description("侧边栏偏好与徽标操作");
  addSimpleGet(sidebar, "preferences", "获取当前侧边栏偏好", "/api/sidebar-preferences/me");
  addJsonPut(sidebar, "preferences:update", "更新当前侧边栏偏好", "/api/sidebar-preferences/me");
  addCompanyList(sidebar, "project-preferences", "获取当前项目侧边栏偏好", "sidebar-preferences/me");
  addCompanyPut(sidebar, "project-preferences:update", "更新当前项目侧边栏偏好", "sidebar-preferences/me");
  addCompanyList(sidebar, "badges", "获取侧边栏徽标", "sidebar-badges");

  const inbox = program.command("inbox").description("工作台收件箱操作");
  addCompanyList(inbox, "dismissals", "列出已忽略的收件箱项目", "inbox-dismissals");
  addCompanyPost(inbox, "dismiss", "忽略收件箱项目", "inbox-dismissals");

  const boardClaim = program.command("board-claim").description("工作台领取令牌操作");
  addCommonClientOptions(
    boardClaim
      .command("show")
      .description("检查工作台领取令牌")
      .argument("<token>", "领取令牌")
      .action(async (token: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/board-claim/${token}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
  addCommonClientOptions(
    boardClaim
      .command("claim")
      .description("使用工作台领取令牌")
      .argument("<token>", "领取令牌")
      .option("--payload-json <json>", "领取所需的 JSON 数据", "{}")
      .action(async (token: string, opts: JsonPayloadOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.post(apiPath`/api/board-claim/${token}/claim`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const openclaw = program.command("openclaw").description("OpenClaw 集成工具");
  addCompanyPost(openclaw, "invite-prompt", "创建 OpenClaw 邀请提示词", "openclaw/invite-prompt");

  const publicSkills = program.command("available-skill").description("公共技能目录操作");
  addSimpleGet(publicSkills, "list", "列出可用技能", "/api/skills/available");
  addSimpleGet(publicSkills, "index", "获取可用技能索引", "/api/skills/index");
  addCommonClientOptions(
    publicSkills
      .command("get")
      .description("获取可用技能的 Markdown 内容")
      .argument("<skillName>", "技能名称")
      .action(async (skillName: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(apiPath`/api/skills/${skillName}`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  const llm = program.command("llm").description("大语言模型提示词文档");
  addSimpleGet(llm, "agent-configuration", "获取智能体配置提示词文档", "/api/llms/agent-configuration.txt");
  addSimpleGet(llm, "agent-icons", "获取智能体图标提示词文档", "/api/llms/agent-icons.txt");
  addCommonClientOptions(
    llm
      .command("agent-configuration:adapter")
      .description("获取适配器专用的智能体配置提示词文档")
      .argument("<adapterType>", "适配器类型")
      .action(async (adapterType: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get(`${apiPath`/api/llms/agent-configuration/${adapterType}`}.txt`), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function addWhoamiCommand(parent: Command): void {
  addCommonClientOptions(
    parent
      .command("whoami")
      .description("显示当前命令行认证身份")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          printOutput(await ctx.api.get("/api/cli-auth/me"), { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function normalizeJoinStatus(status: string | undefined): string | undefined {
  if (status === "pending") return "pending_approval";
  return status;
}

function addSimpleGet(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).action(async (opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.get(path), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addJsonPatch(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: JsonPayloadOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.patch(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addJsonPut(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(parent.command(name).description(description).requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: JsonPayloadOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.put(path, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function addCompanyList(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).option("-C, --company-id <id>", "公司 ID").action(async (opts: CompanyOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.get(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addCompanyPut(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).option("-C, --company-id <id>", "公司 ID").requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: JsonPayloadOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.put(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addCompanyPost(parent: Command, name: string, description: string, path: string): void {
  addCommonClientOptions(
    parent.command(name).description(description).option("-C, --company-id <id>", "公司 ID").requiredOption("--payload-json <json>", "JSON 数据").action(async (opts: JsonPayloadOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addJoinAction(parent: Command, action: "approve" | "reject"): void {
  addCommonClientOptions(
    parent.command(action).description(action === "approve" ? "批准加入申请" : "拒绝加入申请").argument("<requestId>", "加入申请 ID").option("-C, --company-id <id>", "公司 ID").action(async (requestId: string, opts: CompanyOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}/join-requests/${requestId}`}/${action}`, {}), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addMemberPatch(parent: Command, name: string, path: string, suffix?: string): void {
  addCommonClientOptions(
    parent.command(name).description({ update: "更新成员", "role-and-grants": "更新成员角色和授权", permissions: "更新成员权限" }[name] ?? "更新成员").argument("<memberId>", "成员 ID").option("-C, --company-id <id>", "公司 ID").requiredOption("--payload-json <json>", "JSON 数据").action(async (memberId: string, opts: JsonPayloadOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        const route = `${apiPath`/api/companies/${ctx.companyId}`}/${path}/${encodeURIComponent(memberId)}${suffix ? `/${suffix}` : ""}`;
        printOutput(await ctx.api.patch(route, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addMemberPost(parent: Command, name: string, path: string, suffix: string): void {
  addCommonClientOptions(
    parent.command(name).description(name === "archive" ? "归档成员" : "操作成员").argument("<memberId>", "成员 ID").option("-C, --company-id <id>", "公司 ID").option("--payload-json <json>", "JSON 数据", "{}").action(async (memberId: string, opts: JsonPayloadOptions) => {
      try {
        const ctx = resolveCommandContext(opts, { requireCompany: true });
        printOutput(await ctx.api.post(`${apiPath`/api/companies/${ctx.companyId}`}/${path}/${encodeURIComponent(memberId)}/${suffix}`, parseJson(opts.payloadJson ?? "{}")), { json: ctx.json });
      } catch (err) {
        handleCommandError(err);
      }
    }),
    { includeCompany: false },
  );
}

function addAdminUserPost(parent: Command, name: string, suffix: string): void {
  addCommonClientOptions(parent.command(name).description(name === "promote" ? "提升为实例管理员" : "取消实例管理员权限").argument("<userId>", "用户 ID").action(async (userId: string, opts: BaseClientOptions) => {
    try {
      const ctx = resolveCommandContext(opts);
      printOutput(await ctx.api.post(`${apiPath`/api/admin/users/${userId}`}/${suffix}`, {}), { json: ctx.json });
    } catch (err) {
      handleCommandError(err);
    }
  }));
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
