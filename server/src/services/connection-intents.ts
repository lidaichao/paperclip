import { logActivity } from "./activity-log.js";
import { aiConnectionService } from "./ai-connections.js";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  toolConnections,
  toolCatalogEntries,
  companyMemberships,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  APP_STORE_DEFINITIONS,
  CONNECTABLE_APP_DEFINITIONS,
  connectionIntentPayloadSchema,
  getAvailableConnectionMethods,
  isToolConnectionAttentionHealth,
  type ConnectionSearchResultItem,
  getAppStoreDefinition,
  type ConnectionIntentInteraction,
  type ConnectionIntentSetupOptions,
  type ConnectionRequestResult,
  type ConnectionsSearchResult,
  type ToolApplication,
  type ToolConnection,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { toolAccessService } from "./tool-access.js";
import { captureRunIdentity } from "./run-identity.js";
import { resolveManagedGitHubIdentitySelection } from "./git-credentials.js";

type ConnectionRunClaims = Pick<RuntimeToolsTokenClaims, "sub" | "company_id" | "run_id" | "responsible_user_id">;

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceSlugForApplication(application: ToolApplication | undefined) {
  return text(application?.metadata?.sourceTemplateKey) ?? text(application?.metadata?.galleryKey);
}

function sourceSlugForConnection(
  connection: ToolConnection,
  applications: ReadonlyMap<string, ToolApplication>,
) {
  const source = text(connection.config?.sourceTemplateKey)
    ?? text(connection.transportConfig?.sourceTemplateKey)
    ?? sourceSlugForApplication(applications.get(connection.applicationId));
  return source && getAppStoreDefinition(source) ? source : `connection:${connection.id}`;
}


function availableToolConnectionMethods(
  app: (typeof CONNECTABLE_APP_DEFINITIONS)[number],
) {
  return getAvailableConnectionMethods(app).filter(
    (method) => (method.purpose ?? "tool") === "tool" && method.transport !== "runtime_auth",
  );
}

export function connectionIntentService(db: Db) {
  const interactions = issueThreadInteractionService(db);
  const access = toolAccessService(db);

  async function assertCurrentUserWriteAccess(
    companyId: string,
    userId: string,
    bypassCurrentMembershipCheck = false,
  ) {
    if (bypassCurrentMembershipCheck) return;
    const membership = await db
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ))
      .then((rows) => rows[0] ?? null);
    if (
      !membership
      || membership.status !== "active"
      || !membership.membershipRole
      || membership.membershipRole === "viewer"
    ) {
      throw forbidden("指定用户已不再拥有组织写入权限");
    }
  }

  async function lockCurrentUserWriteAccess(
    tx: DbTransaction,
    companyId: string,
    userId: string,
    bypassCurrentMembershipCheck = false,
  ) {
    if (bypassCurrentMembershipCheck) return;
    const membership = await tx
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !membership
      || membership.status !== "active"
      || !membership.membershipRole
      || membership.membershipRole === "viewer"
    ) {
      throw forbidden("指定用户已不再拥有组织写入权限");
    }
  }

  async function loadRunContext(claims: ConnectionRunClaims) {
    let run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        runtimeMode: heartbeatRuns.runtimeMode,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, claims.run_id))
      .then((rows) => rows[0] ?? null);
    if (
      !run
      || run.companyId !== claims.company_id
      || run.agentId !== claims.sub
      || (!run.activeIdentityContextId && run.responsibleUserId !== claims.responsible_user_id)
    ) throw forbidden("运行时工具令牌与其心跳运行不匹配");
    if (run.status !== "running") throw forbidden("运行时工具令牌已失效");
    // This route is mounted before the normal actor middleware. Until its
    // mutations can share the desktop lease transaction, it must fail closed.
    if (run.runtimeMode === "client_pull") throw forbidden("本机领取运行暂不支持运行时连接工具");
    if (run.activeIdentityContextId) {
      const current = await captureRunIdentity(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id });
      run = { ...run, responsibleUserId: current.run.responsibleUserId };
    }
    if (!run.responsibleUserId) throw forbidden("此任务需要指定负责人后才能连接服务");
    const snapshot = record(run.contextSnapshot);
    const issueId = text(snapshot?.issueId) ?? text(snapshot?.taskId);
    if (!issueId) throw unprocessable("连接请求需要绑定到任务的心跳运行");
    const [issue, agent, responsibleMembership] = await Promise.all([
      db.select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).then((rows) => rows[0] ?? null),
      db.select({ id: agents.id, companyId: agents.companyId, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null),
      db.select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, run.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, run.responsibleUserId!),
      )).then((rows) => rows[0] ?? null),
    ]);
    if (!issue || !agent) throw notFound("未找到运行时任务或智能体");
    if (
      !responsibleMembership
      || responsibleMembership.status !== "active"
      || !responsibleMembership.membershipRole
      || responsibleMembership.membershipRole === "viewer"
    ) {
      throw forbidden("负责人已不再拥有组织写入权限");
    }
    if (issue.assigneeAgentId !== agent.id) throw conflict("发起请求的智能体已不再负责此任务");
    if (issue.status === "done" || issue.status === "cancelled") {
      throw conflict("已关闭的任务不能创建连接请求");
    }
    return { run, issue, agent };
  }

  async function connectionInventory(companyId: string) {
    const [applications, connections] = await Promise.all([
      access.listApplications(companyId),
      access.listConnections(companyId),
    ]);
    return {
      applications,
      connections,
      applicationsById: new Map(applications.map((application) => [application.id, application] as const)),
    };
  }

  async function managedAgent(companyId: string, agentId: string, serviceSlug: string) {
    const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    const binding = aiConnectionBindingSchema.safeParse(agent?.runtimeConfig?.aiConnection).data;
    return agent && binding?.provider === serviceSlug ? { agent, binding } : null;
  }

  async function usableConnectionForAgent(input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string;
    serviceSlug: string;
    purpose?: "ai";
    inventory?: Awaited<ReturnType<typeof connectionInventory>>;
  }) {
    const managed = input.purpose === "ai" ? await managedAgent(input.companyId, input.agentId, input.serviceSlug) : null;
    if (managed) {
      try {
        const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.responsibleUserId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding });
        return access.getConnection(selected.connection.id, input.companyId);
      } catch (error) { if ([403, 404, 422].includes((error as { status?: number }).status ?? 0)) return null; throw error; }
    }
    if (input.purpose === "ai") return null;
    const inventory = input.inventory ?? await connectionInventory(input.companyId);
    const matching = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === input.serviceSlug
      && connection.status !== "archived" && connection.connectionPurpose !== "ai"
    );
    if (matching.length === 0) return null;
    const effective = await access.getEffectiveProfilesForAgent(input.companyId, input.agentId);
    const installedIds = new Set(effective.installedConnections.map((connection) => connection.id));
    const permittedIds = new Set(effective.allowedTools.map((tool) => tool.connectionId));
    const usable = (connection: ToolConnection | undefined) => connection
      && installedIds.has(connection.id) && permittedIds.has(connection.id)
      && connection.status === "active" && connection.enabled
      && ["mcp_remote", "local_stdio"].includes(connection.transport)
      && !isToolConnectionAttentionHealth(connection.healthStatus) ? connection : null;
    if (input.serviceSlug === "github") {
      const selection = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
        agentId: input.agentId, responsibleUserId: input.responsibleUserId,
      });
      return usable(matching.find((connection) => connection.id === selection.grant?.connectionId));
    }
    const installed = matching.filter((connection) => installedIds.has(connection.id));
    const grantsByConnection = await Promise.all(installed.map(async (connection) => ({
      connection,
      grants: (await access.listConnectionGrants(connection.id, input.companyId)).grants,
    })));

    // Keep readiness aligned with runtime identity resolution. A dedicated
    // agent identity wins over the responsible person's personal identity,
    // while an inactive or ambiguous higher-priority identity fails closed.
    const dedicated = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "agent" && grant.subjectAgentId === input.agentId)
      .map((grant) => ({ connection, grant })));
    if (dedicated.length > 0) {
      const active = dedicated.filter(({ grant }) => grant.status === "active");
      return active.length === 1 ? usable(active[0]!.connection) : null;
    }

    const personal = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "user" && grant.subjectUserId === input.responsibleUserId)
      .map((grant) => ({ connection, grant })));
    if (personal.length > 0) {
      const active = personal.filter(({ grant }) => grant.status === "active");
      return active.length === 1 ? usable(active[0]!.connection) : null;
    }

    const organization = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "organization")
      .map((grant) => ({ connection, grant })));
    const activeOrganization = organization.filter(({ grant }) => grant.status === "active");
    return activeOrganization.length === 1 ? usable(activeOrganization[0]!.connection) : null;
  }

  async function administrativeDenial(companyId: string, agentId: string, serviceSlug: string, inventory: Awaited<ReturnType<typeof connectionInventory>>) {
    const effective = await access.getEffectiveProfilesForAgent(companyId, agentId);
    const installed = effective.installedConnections.filter((connection) => sourceSlugForConnection(connection, inventory.applicationsById) === serviceSlug);
    if (!installed.length || effective.allowedTools.some((tool) => installed.some((connection) => connection.id === tool.connectionId))) return false;
    for (const connection of installed) {
      if ((await indexedCatalog(connection.id, companyId)).some((tool) => tool.entryKind === "tool")) return true;
    }
    return false;
  }

  function indexedCatalog(connectionId: string, companyId: string) {
    // Discovery must not contact providers or mutate their health/cache state.
    return db.select().from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, connectionId),
      eq(toolCatalogEntries.status, "active"),
    ));
  }

  async function resolveService(service: string, companyId: string, userId: string, agentId: string, purpose?: "ai") {
    if (!service.startsWith("connection:")) {
      const app = getAppStoreDefinition(service);
      if (!app) throw notFound("未找到连接服务");
      const methods = purpose === "ai" ? getAvailableConnectionMethods(app).filter(method => method.transport === "runtime_auth") : availableToolConnectionMethods(app);
      return { ...app, available: app.availability?.available !== false,
        searchCapabilities: methods.map((method) =>
          `${method.whenToUse} ${method.capabilityProfile?.label ?? ""} ${method.capabilityProfile?.description ?? ""}`).join(" "),
        methods: methods.map((method) => ({
          key: method.key, label: method.label ?? method.key, auth: method.auth,
        })), source: "catalog" as const };
    }
    const id = service.slice("connection:".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw notFound("未找到已配置的连接");
    }
    const connection = await access.getConnection(id, companyId);
    if (connection.connectionPurpose === "ai" && purpose !== "ai") throw notFound("AI 身份验证不是工具连接");
    const { grants } = await access.listConnectionGrants(id, companyId);
    if (connection.status === "archived" || !grants.some((grant) => grant.status === "active" && (
      grant.kind === "organization" || (grant.kind === "user" && grant.subjectUserId === userId)
      || (grant.kind === "agent" && grant.subjectAgentId === agentId)
    ))) throw notFound("未找到已配置的连接");
    const application = await access.getApplication(connection.applicationId, companyId);
    return {
      slug: service, name: connection.name, description: application.description, searchCapabilities: "",
      branding: { logoUrl: undefined, darkLogoUrl: undefined },
      available: connection.enabled,
      methods: [{ key: "configured", label: "使用已配置的连接", auth:
        connection.authKind === "oauth" ? "oauth" as const : connection.authKind === "none" ? "none" as const : "api_key" as const }],
      source: "configured" as const,
    };
  }

  async function search(claims: ConnectionRunClaims, query: string): Promise<ConnectionsSearchResult> {
    const { run, agent } = await loadRunContext(claims);
    const normalized = query.trim().toLocaleLowerCase();
    const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const inventory = await connectionInventory(run.companyId);
    const candidates: Array<{ item: ConnectionSearchResultItem; score: number }> = [];
    const services = [...APP_STORE_DEFINITIONS.filter(app => getAvailableConnectionMethods(app).some(method => method.transport !== "runtime_auth")).map((app) => app.slug),
      ...inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById)?.startsWith("connection:")
        && connection.status !== "archived").map((connection) => `connection:${connection.id}`)];
    for (const service of services) {
      let app;
      try { app = await resolveService(service, run.companyId, run.responsibleUserId!, agent.id); }
      catch (error) { if (service.startsWith("connection:") && (error as { status?: number }).status === 404) continue; throw error; }
      const matching = inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById) === service && connection.status !== "archived" && connection.connectionPurpose !== "ai");
      // Indexed descriptions can contain private workspace metadata, including
      // for catalog providers. Check each configured connection's audience first.
      const catalogs = await Promise.all(matching.map(async (connection) => {
        const { grants } = await access.listConnectionGrants(connection.id, run.companyId);
        const authorized = grants.some((grant) => grant.status === "active" && (
          grant.kind === "organization" || (grant.kind === "user" && grant.subjectUserId === run.responsibleUserId)
          || (grant.kind === "agent" && grant.subjectAgentId === agent.id)
        ));
        return authorized ? indexedCatalog(connection.id, run.companyId) : [];
      }));
      const catalog = catalogs.flat().filter((entry) => entry.status === "active");
      const haystack = `${app.slug} ${app.name} ${app.description ?? ""} ${app.searchCapabilities} ${catalog.map((tool) => `${tool.toolName} ${tool.description ?? ""}`).join(" ")}`.toLocaleLowerCase();
      const score = !normalized ? 1 : app.slug === normalized || app.name.toLocaleLowerCase() === normalized
        ? 1000 : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      if (!score) continue;
      const ready = await usableConnectionForAgent({ companyId: run.companyId, agentId: agent.id,
        responsibleUserId: run.responsibleUserId!, serviceSlug: service, inventory });
      const denied = !ready && matching.length > 0 && await administrativeDenial(run.companyId, agent.id, service, inventory);
      candidates.push({ score, item: {
        service, name: app.name, description: app.description ?? null, logoUrl: app.branding.logoUrl ?? null,
        methods: app.methods, source: app.source,
        state: ready ? "ready" : denied ? "unavailable" : !app.available || !app.methods.length ? "unavailable"
          : matching.length ? "needs_user_action" : "available",
        reason: ready ? "连接已安装，此智能体可以使用" : denied ? "管理员尚未允许此智能体执行工具；重新连接也无法授予该权限" : !app.available ? "连接已停用或不可用"
          : matching.some((connection) => isToolConnectionAttentionHealth(connection.healthStatus)) ? "连接需要处理"
          : matching.length ? "请检查此智能体的身份与访问权限" : "请先连接此服务",
        connectionId: ready?.id ?? null,
      }});
    }
    return { version: 1, query, results: candidates.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, 20).map(({ item }) => item) };
  }

  async function request(
    claims: ConnectionRunClaims,
    serviceSlug: string,
    options: { purpose?: "ai" } = {},
  ): Promise<ConnectionRequestResult> {
    const context = await loadRunContext(claims);
    const app = await resolveService(serviceSlug, context.run.companyId, context.run.responsibleUserId!, context.agent.id, options.purpose);
    if (!app.available || app.methods.length === 0) {
      throw unprocessable(`连接服务 ${serviceSlug} 不可用`);
    }
    const ready = await usableConnectionForAgent({
      companyId: context.run.companyId,
      agentId: context.agent.id,
      responsibleUserId: context.run.responsibleUserId!,
      serviceSlug: app.slug,
      purpose: options.purpose,
    });
    if (ready) {
      return {
        version: 1,
        service: app.slug,
        state: "ready",
        connectionId: ready.id,
        interactionId: null,
        instruction: options.purpose === "ai" ? `${app.name} authentication is available for the next execution.` : `${app.name} is connected. Use its installed tools; a native continuation will refresh tools if needed.`,
      };
    }
    if (options.purpose !== "ai" && await administrativeDenial(context.run.companyId, context.agent.id, app.slug, await connectionInventory(context.run.companyId))) {
      throw forbidden("此智能体没有该服务的可用操作。请让管理员检查工具权限；重新连接无法解除拒绝状态。");
    }
    const outcomeId = context.run.contextSnapshot?.interactionId;
    if (typeof outcomeId === "string") {
      const [outcome] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, outcomeId), eq(issueThreadInteractions.companyId, context.run.companyId), eq(issueThreadInteractions.issueId, context.issue.id)));
      if (outcome?.kind === "connection_intent" && outcome.status === "rejected" && connectionIntentPayloadSchema.parse(outcome.payload).serviceSlug === app.slug && connectionIntentPayloadSchema.parse(outcome.payload).purpose === options.purpose) {
        throw conflict("用户已拒绝此连接。请改用其他方案，不要在本次执行中重复请求。");
      }
    }
    const interaction = await interactions.createConnectionIntent(
      context.issue,
      {
        payload: {
          version: 1,
          serviceSlug: app.slug,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          serviceName: app.name,
          serviceLogoUrl: app.branding.logoUrl ?? null,
          serviceDarkLogoUrl: app.branding.darkLogoUrl ?? null,
          requestingAgentId: context.agent.id,
          requestingAgentName: context.agent.name,
          phase: "requested",
        },
        sourceRunId: context.run.id,
        sourceIdentityContextId: context.run.activeIdentityContextId,
        addresseeUserId: context.run.responsibleUserId!,
        idempotencyKey: `connection-intent:${context.run.id}:${context.run.responsibleUserId}:${app.slug}${options.purpose ? ":ai" : ""}`,
      },
    );
    if (interaction.status !== "pending") throw conflict("此连接请求已处理，请遵循已记录的结果。");
    await logActivity(db, {
      companyId: context.run.companyId, actorType: "agent", actorId: context.agent.id,
      agentId: context.agent.id, runId: context.run.id,
      action: "issue.thread_interaction_created", entityType: "issue", entityId: context.issue.id,
      details: { interactionId: interaction.id, interactionKind: "connection_intent", purpose: options.purpose },
    });
    return {
      version: 1,
      service: app.slug,
      state: "needs_user_action",
      connectionId: null,
      interactionId: interaction.id,
      instruction: `连接卡片已发送给负责人。请先完成不依赖连接的工作，然后结束本次执行并等待继续，不要重复发起请求。`,
    };
  }

  async function loadIntent(interactionId: string) {
    const row = await db
      .select({ interaction: issueThreadInteractions, issue: issues })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.interaction.kind !== "connection_intent") throw notFound("未找到连接请求");
    const interaction = await interactions.getForIssue(row.issue, interactionId) as ConnectionIntentInteraction;
    return { ...row, interaction };
  }

  async function setupOptions(interactionId: string, options: { canManageOrganizationGrant?: boolean } = {}): Promise<ConnectionIntentSetupOptions> {
    const loaded = await loadIntent(interactionId);
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    const app = await resolveService(payload.serviceSlug, loaded.issue.companyId, loaded.interaction.addresseeUserId!, payload.requestingAgentId, payload.purpose);
    const managed = payload.purpose === "ai" ? await managedAgent(loaded.issue.companyId, payload.requestingAgentId, app.slug) : null;
    if (payload.purpose === "ai" && !managed) throw conflict("智能体的 AI 配置已变化，请开始新的执行。");
    const inventory = await connectionInventory(loaded.issue.companyId);
    const usableAiConnection = managed ? await usableConnectionForAgent({
      companyId: loaded.issue.companyId, agentId: payload.requestingAgentId,
      responsibleUserId: loaded.interaction.addresseeUserId!, serviceSlug: app.slug, purpose: "ai",
    }) : null;
    const aiAccounts = managed ? await aiConnectionService(db).list(loaded.issue.companyId, loaded.interaction.addresseeUserId!) : [];
    const selectedAiAccount = managed ? aiAccounts.find((account) =>
      account.provider === managed.binding.provider && (managed.binding.mode === "responsible_user" || account.method === managed.binding.method)
      && (managed.binding.mode === "responsible_user" ? account.isDefault
        : account.id === managed.binding.connectionId && account.grantId === managed.binding.grantId)
    ) : undefined;
    const selectedAiGrant = selectedAiAccount
      ? (await access.listConnectionGrants(selectedAiAccount.id, loaded.issue.companyId)).grants.find(grant => grant.id === selectedAiAccount.grantId)
      : undefined;
    const matchingConnections = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === app.slug
      && connection.status === "active"
      && connection.enabled
    );
    const existingConnections = (await Promise.all(matchingConnections.map(async (connection) => {
      if (managed) return connection.id === usableAiConnection?.id ? connection : null;
      const { grants } = await access.listConnectionGrants(connection.id, loaded.issue.companyId);
      const eligible = grants.some((grant) =>
        grant.status === "active"
        && (grant.kind === "organization" || grant.subjectUserId === loaded.interaction.addresseeUserId
          || (grant.kind === "agent" && grant.subjectAgentId === payload.requestingAgentId))
      );
      return eligible && connection.connectionPurpose !== "ai" ? connection : null;
    }))).filter((connection): connection is ToolConnection => connection !== null);
    return {
      version: 1,
      interaction: loaded.interaction,
      service: {
        service: app.slug,
        name: app.name,
        description: app.description ?? null,
        logoUrl: app.branding.logoUrl ?? null,
        methods: app.methods,
        source: app.source,
        state: existingConnections.length > 0 ? "needs_user_action" : "available",
        connectionId: null,
      },
      existingConnections: existingConnections.map(({ id, applicationId, name, status, enabled }) => ({
        id, applicationId, name, status, enabled,
      })),
      requestedAgentId: payload.requestingAgentId,
      aiConnection: managed?.binding,
      aiRepair: selectedAiAccount ? {
        connection: selectedAiAccount,
        canReconnect: selectedAiGrant?.createdByUserId === loaded.interaction.addresseeUserId
          && (selectedAiAccount.ownership === "personal"
            ? selectedAiAccount.ownerUserId === loaded.interaction.addresseeUserId
            : options.canManageOrganizationGrant === true),
      } : undefined,
    };
  }

  async function complete(
    interactionId: string,
    connectionId: string,
    userId: string,
    options: {
      canManageOrganizationGrant?: boolean;
      bypassCurrentMembershipCheck?: boolean;
    } = {},
  ) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.status !== "pending") {
      if (loaded.interaction.status === "accepted" && loaded.interaction.result?.connectionId === connectionId && loaded.interaction.addresseeUserId === userId) return loaded.interaction;
      throw conflict("连接请求已处理");
    }
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("只有指定用户才能连接此服务");
    await assertCurrentUserWriteAccess(
      loaded.issue.companyId,
      userId,
      options.bypassCurrentMembershipCheck,
    );
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    return db.transaction(async (tx) => {
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, loaded.issue.id), eq(issues.companyId, loaded.issue.companyId))).for("update");
      if (!task || task.assigneeAgentId !== payload.requestingAgentId || ["done", "cancelled"].includes(task.status)) throw conflict("连接请求已不再属于活动任务");
      // Membership downgrade/removal takes the same row lock. Whichever side
      // commits first is authoritative: a completed revocation makes this
      // revalidation fail, while completion holds authority through OAuth
      // finalization, every install/delegation, and intent resolution.
      await lockCurrentUserWriteAccess(
        tx,
        loaded.issue.companyId,
        userId,
        options.bypassCurrentMembershipCheck,
      );
      const txDb = tx as unknown as Db;
      const txAccess = toolAccessService(txDb);
      const txInteractions = issueThreadInteractionService(txDb);
      await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, loaded.issue.companyId))).for("update");
      let selectedConnection = await txAccess.getConnection(connectionId, loaded.issue.companyId);
      const selectedApplication = await txAccess.getApplication(
        selectedConnection.applicationId,
        loaded.issue.companyId,
      );
      if (sourceSlugForConnection(
        selectedConnection,
        new Map([[selectedApplication.id, selectedApplication]]),
      ) !== payload.serviceSlug) {
        throw notFound("连接与此请求不匹配");
      }
      if (selectedConnection.status !== "active" || !selectedConnection.enabled || isToolConnectionAttentionHealth(selectedConnection.healthStatus)) {
        throw conflict("请先完成并测试此连接，再用于任务");
      }

      if (payload.purpose === "ai" && selectedConnection.connectionPurpose !== "ai") throw conflict("请为此身份验证请求选择 AI 账号");
      if (selectedConnection.connectionPurpose === "ai") {
        if (payload.purpose !== "ai") throw conflict("AI 身份验证不能满足工具连接请求");
        const managed = await managedAgent(loaded.issue.companyId, payload.requestingAgentId, payload.serviceSlug);
        if (!managed) throw conflict("使用此账号前，请先配置智能体的 AI 连接");
        const service = aiConnectionService(txDb);
        if (managed.binding.mode === "responsible_user") {
          const selected = await service.select({ companyId: loaded.issue.companyId, agentId: payload.requestingAgentId, userId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding, allowUninstalledPersonal: true });
          if (selected.connection.id !== selectedConnection.id) throw conflict("请先在“连接”中将此账号设为个人默认账号");
          const installs = await txAccess.listConnectionInstalls(selectedConnection.id, loaded.issue.companyId);
          await txAccess.putConnectionInstalls(selectedConnection.id, { installs: [...installs, { targetType: "agent", targetId: payload.requestingAgentId }] }, { actorType: "user", actorId: userId });
        }
        const selected = await service.select({ companyId: loaded.issue.companyId, agentId: payload.requestingAgentId, userId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding });
        if (selected.connection.id !== selectedConnection.id) throw conflict("这不是为该智能体选择的账号");
        return txInteractions.resolveConnectionIntent(loaded.issue, interactionId, { version: 1, outcome: "connected", connectionId: selected.connection.id }, { userId });
      }

      let { grants } = await txAccess.listConnectionGrants(
        selectedConnection.id,
        loaded.issue.companyId,
      );
      const pendingPersonalGrant = grants.find((grant) =>
        grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
      );
      if (selectedConnection.authKind === "oauth" && pendingPersonalGrant) {
        // txAccess is bound to the outer transaction. Its internal transactions
        // become savepoints, so activation, credential bindings, and the
        // requesting agent's access roll back with any later failure.
        await txAccess.finalizeOAuthAccess(
          loaded.issue.companyId,
          selectedConnection.id,
          { grantKind: "user" },
          { actorType: "user", actorId: userId },
          payload.requestingAgentId,
        );
        selectedConnection = await txAccess.getConnection(
          selectedConnection.id,
          loaded.issue.companyId,
        );
        ({ grants } = await txAccess.listConnectionGrants(
          selectedConnection.id,
          loaded.issue.companyId,
        ));
      }
      const personalGrant = grants.find((grant) =>
        grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
      );
      const organizationGrant = grants.find((grant) =>
        grant.kind === "organization" && grant.status === "active"
      );
      const dedicatedGrant = grants.find((grant) => grant.kind === "agent" && grant.status === "active" && grant.subjectAgentId === payload.requestingAgentId);
      if (!personalGrant && !organizationGrant && !dedicatedGrant) {
        throw conflict("此连接没有可用的身份授权");
      }
      if (!personalGrant && !dedicatedGrant && !options.canManageOrganizationGrant) {
        throw forbidden("共享组织连接需要连接管理权限");
      }

      if (personalGrant) {
        await txAccess.createConnectionGrantDelegation(
          selectedConnection.id,
          personalGrant.id,
          payload.requestingAgentId,
          userId,
        );
      }

      const installs = await txAccess.listConnectionInstalls(
        selectedConnection.id,
        loaded.issue.companyId,
      );
      const requestedInstall = { targetType: "agent" as const, targetId: payload.requestingAgentId };
      const additiveInstalls = installs.some((install) =>
        install.targetType === requestedInstall.targetType && install.targetId === requestedInstall.targetId
      ) ? installs : [...installs, requestedInstall];
      await txAccess.putConnectionInstalls(selectedConnection.id, { installs: additiveInstalls }, {
        actorType: "user",
        actorId: userId,
      });

      const effective = await txAccess.getEffectiveProfilesForAgent(loaded.issue.companyId, payload.requestingAgentId);
      if (!effective.allowedTools.some((tool) => tool.connectionId === selectedConnection.id)) throw conflict("此连接没有可用工具。继续前请检查其操作权限。");

      const runtimeConnection = await connectionIntentService(txDb).usableConnectionForAgent({
        companyId: loaded.issue.companyId, agentId: payload.requestingAgentId,
        responsibleUserId: userId, serviceSlug: payload.serviceSlug,
      });
      if (runtimeConnection?.id !== selectedConnection.id) throw conflict("此身份不是该智能体可以执行的连接。继续前请解决身份冲突。");

      return txInteractions.resolveConnectionIntent(
        loaded.issue,
        interactionId,
        { version: 1, outcome: "connected", connectionId: selectedConnection.id },
        { userId },
      );
    });
  }

  async function decline(
    interactionId: string,
    userId: string,
    reason?: string,
    options: { bypassCurrentMembershipCheck?: boolean } = {},
  ) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("只有指定用户才能拒绝此请求");
    await assertCurrentUserWriteAccess(
      loaded.issue.companyId,
      userId,
      options.bypassCurrentMembershipCheck,
    );
    return interactions.resolveConnectionIntent(
      loaded.issue,
      interactionId,
      { version: 1, outcome: "declined", reason: reason?.trim() || null },
      { userId },
    );
  }

  return {
    validate: loadRunContext,
    usableConnectionForAgent,
    search,
    request,
    loadIntent,
    setupOptions,
    complete,
    decline,
    updatePhase: async (
      interactionId: string,
      phase: "requested" | "authorizing" | "needs_retry",
      userId: string,
      options: { bypassCurrentMembershipCheck?: boolean } = {},
    ) => {
      const loaded = await loadIntent(interactionId);
      if (loaded.interaction.addresseeUserId !== userId) throw forbidden("只有指定用户才能更新此请求");
      await assertCurrentUserWriteAccess(
        loaded.issue.companyId,
        userId,
        options.bypassCurrentMembershipCheck,
      );
      return interactions.updateConnectionIntentPhase(loaded.issue, interactionId, phase, { userId });
    },
  };
}
