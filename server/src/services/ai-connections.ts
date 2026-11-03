import { syncConnectionCredentialBindings } from "./connection-credential-bindings.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  type Db,
  authUsers,
  adapterAuthSessions,
  aiConnectionDefaults,
  aiProviderDefaults,
  agents,
  companyMemberships,
  companySecrets,
  userSecretDefinitions,
  connectionGrants,
  connectionGrantMembers,
  toolApplications,
  toolConnections,
  toolConnectionInstalls,
} from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  aiConnectionMetadataSchema,
  aiSubscriptionNeedsIsolatedLogin,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiConnectionAttribution,
  type AiConnectionMetadata,
  type AiManagedConnectionSummary,
  type CreateAiConnection,
  type AiConnectionLoginIntent,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";

/** Same human audience displayed by the existing Connections identity controls. */
function canUseCredential(
  grant: { kind: string; subjectUserId: string | null },
  userId: string | null,
  audience: { subjectType: string; subjectId: string }[],
) {
  if (!userId) return false;
  if (grant.kind === "user") return grant.subjectUserId === userId;
  return grant.kind === "organization" && (
    audience.length === 0 || audience.some((member) => member.subjectType === "user" && member.subjectId === userId)
  );
}

export function aiConnectionService(db: Db) {
  const secrets = secretService(db);
  async function membership(companyId: string, userId: string | null) {
    if (!userId) return false;
    return Boolean(
      (
        await db
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, userId),
              eq(companyMemberships.status, "active"),
            ),
          )
          .limit(1)
      )[0],
    );
  }
  async function rows(companyId: string) {
    return db
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections)
      .innerJoin(
        connectionGrants,
        and(
          eq(connectionGrants.companyId, toolConnections.companyId),
          eq(connectionGrants.connectionId, toolConnections.id),
        ),
      )
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
        ),
      );
  }
  async function list(
    companyId: string,
    userId: string,
    _agentId?: string,
  ): Promise<AiManagedConnectionSummary[]> {
    const [accounts, defaults, members, owners] =
      await Promise.all([
        rows(companyId),
        db
          .select()
          .from(aiProviderDefaults)
          .where(
            and(
              eq(aiProviderDefaults.companyId, companyId),
              eq(aiProviderDefaults.userId, userId),
            ),
          ),
        db
          .select()
          .from(connectionGrantMembers)
          .where(eq(connectionGrantMembers.companyId, companyId)),
        db
          .select({ id: authUsers.id, name: authUsers.name })
          .from(authUsers)
          .innerJoin(
            companyMemberships,
            and(
              eq(companyMemberships.principalId, authUsers.id),
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
            ),
          ),
      ]);
    return accounts.flatMap(({ connection, grant }) => {
      const metadata = aiConnectionMetadataSchema.safeParse(
        connection.config.ai,
      );
      if (!metadata.success) return [];
      const needsReconnect = aiSubscriptionNeedsIsolatedLogin(connection.config);
      if (!canUseCredential(grant, userId, members.filter((m) => m.grantId === grant.id)))
        return [];
      return [
        {
          id: connection.id,
          grantId: grant.id,
          companyId,
          ...metadata.data,
          name: connection.name,
          accountLabel: grant.providerTenant?.name,
          ...(needsReconnect ? { unavailableReason: "Reconnect with a separate sign-in to protect your existing terminal login." } : {}),
          ownership:
            grant.kind === "user" ? ("personal" as const) : ("shared" as const),
          ownerUserId: grant.subjectUserId ?? undefined,
          ownerName:
            owners.find((owner) => owner.id === grant.subjectUserId)?.name ??
            (grant.subjectUserId === userId ? "You" : "Account owner"),
          isDefault: defaults.some((d) => d.grantId === grant.id),
          status:
            grant.status === "revoked"
              ? ("revoked" as const)
              : grant.status === "expired"
                ? ("expired" as const)
                : grant.status !== "active" ||
                    !connection.enabled ||
                    connection.status !== "active" ||
                    connection.healthStatus !== "ok" || needsReconnect
                  ? ("needs_attention" as const)
                  : ("connected" as const),
        },
      ];
    });
  }
  async function setDefault(
    companyId: string,
    userId: string,
    grantId: string,
  ) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ connection: toolConnections, grant: connectionGrants })
        .from(connectionGrants)
        .innerJoin(
          toolConnections,
          eq(toolConnections.id, connectionGrants.connectionId),
        )
        .where(
          and(
            eq(connectionGrants.companyId, companyId),
            eq(connectionGrants.id, grantId),
            eq(connectionGrants.subjectUserId, userId),
            eq(connectionGrants.kind, "user"),
          ),
        )
        .for("update");
      if (!row)
        throw forbidden("只有所有者可以选择自己的个人默认连接");
      if (
        row.connection.connectionPurpose !== "ai" ||
        row.grant.status !== "active" ||
        !row.connection.enabled ||
        row.connection.healthStatus !== "ok"
      )
        throw unprocessable(
          "请先重新连接此账户，再将其设为默认连接",
        );
      const metadata = aiConnectionMetadataSchema.parse(
        row.connection.config.ai,
      );
      // Keep old servers' method preferences intact during an additive rollout.
      await tx.insert(aiConnectionDefaults)
        .values({ companyId, userId, ...metadata, grantId })
        .onConflictDoUpdate({
          target: [aiConnectionDefaults.companyId, aiConnectionDefaults.userId, aiConnectionDefaults.provider, aiConnectionDefaults.method],
          set: { grantId, updatedAt: new Date() },
        });
      await tx.insert(aiProviderDefaults)
        .values({ companyId, userId, provider: metadata.provider, grantId })
        .onConflictDoUpdate({
          target: [aiProviderDefaults.companyId, aiProviderDefaults.userId, aiProviderDefaults.provider],
          set: { grantId, updatedAt: new Date() },
        });
    });
  }
  async function select(input: {
    companyId: string;
    userId: string | null;
    agentId: string;
    adapterType: string;
    model?: unknown;
    runnerProvider?: unknown;
    acpxAgent?: unknown;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    binding: AiConnectionBinding;
  }) {
    const { companyId, userId, agentId, binding } = input;
    if (
      !isAiConnectionCompatible(
        binding,
        input.adapterType,
        input.model,
        input.runnerProvider,
        input.acpxAgent,
      )
    )
      throw unprocessable(
        "请选择与当前运行框架和模型兼容的 AI 连接",
        { code: "ai_connection_incompatible" },
      );
    if (binding.mode === "responsible_user" && !userId)
      throw unprocessable(
        "此次运行需要指定责任用户才能选择 AI 连接",
        { code: "ai_connection_responsible_user_missing" },
      );
    if (userId && !(await membership(companyId, userId)))
      throw forbidden("责任用户不是公司的有效成员");
    const defaultRow =
      binding.mode === "responsible_user"
        ? (
            await db
              .select()
              .from(aiProviderDefaults)
              .where(
                and(
                  eq(aiProviderDefaults.companyId, companyId),
                  eq(aiProviderDefaults.userId, userId!),
                  eq(aiProviderDefaults.provider, binding.provider),
                ),
              )
              .limit(1)
          )[0]
        : null;
    const grantId =
      binding.mode === "responsible_user"
        ? defaultRow?.grantId
        : binding.grantId;
    if (!grantId)
      throw unprocessable(
        "请连接账户并选择个人默认连接",
        { code: "ai_connection_default_missing" },
      );
    const row = (await rows(companyId)).find(
      (r) =>
        r.grant.id === grantId &&
        (binding.mode === "responsible_user" ||
          r.connection.id === binding.connectionId),
    );
    if (!row)
      throw unprocessable("所选 AI 连接不可用", {
        code: "ai_connection_missing",
      });
    const { connection, grant } = row;
    const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
    if (
      !metadata.success ||
      metadata.data.provider !== binding.provider ||
      (binding.mode !== "responsible_user" && metadata.data.method !== binding.method) ||
      !isAiConnectionCompatible(metadata.data, input.adapterType, input.model, input.runnerProvider, input.acpxAgent)
    )
      throw unprocessable("所选 AI 连接不兼容", {
        code: "ai_connection_incompatible",
      });
    if (aiSubscriptionNeedsIsolatedLogin(connection.config))
      throw unprocessable("请使用独立登录重新连接此订阅，以保护现有终端登录。", {
        code: "ai_connection_unavailable", connectionId: connection.id,
      });
    if (
      grant.status !== "active" ||
      !connection.enabled ||
      connection.status !== "active" ||
      (connection.healthStatus !== "ok" &&
        !(
          input.allowLegacyValidation &&
          connection.config.aiLegacyAdoption === true
        ))
    )
      throw unprocessable("请重新连接或验证所选 AI 账户", {
        code: "ai_connection_unavailable",
        connectionId: connection.id,
      });
    if (
      grant.kind === "user" &&
      !(await membership(companyId, grant.subjectUserId))
    )
      throw forbidden(
        "账户所有者已不是公司的有效成员",
      );
    if (
      binding.mode === "responsible_user" &&
      (grant.kind !== "user" || grant.subjectUserId !== userId)
    )
      throw forbidden("默认连接必须属于责任用户");
    if (binding.mode === "shared" && grant.kind !== "organization")
      throw forbidden("请选择公司共享账户");
    if (binding.mode === "delegated" && grant.kind !== "user")
      throw forbidden("请选择个人账户");
    const audience = await db
      .select()
      .from(connectionGrantMembers)
      .where(and(
        eq(connectionGrantMembers.companyId, companyId),
        eq(connectionGrantMembers.grantId, grant.id),
      ));
    // The existing human-access permission is authoritative for every binding,
    // including old explicit personal selections. Agent delegation cannot bypass it.
    if (!canUseCredential(grant, userId, audience))
      throw forbidden("此凭据未共享给责任用户");
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(
        and(
          eq(toolConnectionInstalls.companyId, companyId),
          eq(toolConnectionInstalls.connectionId, connection.id),
          or(
            and(
              eq(toolConnectionInstalls.targetType, "company"),
              eq(toolConnectionInstalls.targetId, companyId),
            ),
            and(
              eq(toolConnectionInstalls.targetType, "agent"),
              eq(toolConnectionInstalls.targetId, agentId),
            ),
          ),
        ),
      );
    if (
      !installs.length &&
      !(
        (input.allowUninstalledPersonal &&
          binding.mode === "responsible_user" && grant.subjectUserId === userId) ||
        (input.allowUninstalledShared && binding.mode === "shared" && grant.kind === "organization")
      )
    )
      throw forbidden("此智能体无权使用该连接");
    return {
      ...row,
      attribution: {
        connectionId: connection.id,
        grantId: grant.id,
        provider: binding.provider,
        method: metadata.data.method,
        mode: binding.mode,
        responsibleUserId: userId,
      } satisfies AiConnectionAttribution,
    };
  }
  async function credential(row: Awaited<ReturnType<typeof select>>) {
    const ref = row.grant.credentialSecretRefs.find(
      (r) => r.configPath === "ai.credential",
    );
    if (!ref)
      throw unprocessable("请重新连接此 AI 账户", {
        code: "ai_connection_credential_missing",
      });
    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(
        and(
          eq(companySecrets.id, ref.secretId),
          eq(companySecrets.companyId, row.connection.companyId),
        ),
      );
    if (!secret)
      throw unprocessable("请重新连接此 AI 账户", {
        code: "ai_connection_credential_missing",
      });
    const context = {
      consumerType: "tool_connection" as const,
      consumerId: row.connection.id,
      configPath: ref.configPath,
      responsibleUserId: row.grant.subjectUserId,
      actorType: "system" as const,
    };
    if (secret.scope === "user") {
      if (
        secret.ownerUserId !== row.grant.subjectUserId ||
        !secret.userSecretDefinitionId
      )
        throw forbidden("凭据所有权不匹配");
      const result = await secrets.resolveUserSecretValue(
        row.connection.companyId,
        {
          definitionId: secret.userSecretDefinitionId,
          responsibleUserId: secret.ownerUserId,
          required: true,
          version: "latest",
        },
        context,
      );
      if (!result) throw unprocessable("请重新连接此 AI 账户");
      return result.value;
    }
    return secrets.resolveSecretValue(
      row.connection.companyId,
      secret.id,
      "latest",
      context,
    );
  }
  async function save(
    companyId: string,
    userId: string,
    input: CreateAiConnection | AiConnectionLoginIntent,
    verifiedCredential: string,
    sessionId?: string,
    attemptStartedAt = new Date(),
  ) {
    if (!(await membership(companyId, userId)))
      throw forbidden("此连接必须由公司的有效成员持有");
    const reconnect = input.connectionId
      ? (await rows(companyId)).find(
          (r) => r.connection.id === input.connectionId,
        )
      : undefined;
    if (input.connectionId && !reconnect)
      throw notFound("未找到 AI 连接");
    if (
      reconnect &&
      (reconnect.grant.createdByUserId !== userId ||
        (reconnect.grant.kind === "user" &&
          reconnect.grant.subjectUserId !== userId))
    )
      throw forbidden("只有账户所有者可以重新连接");
    if (
      reconnect &&
      (reconnect.connection.config.ai as AiConnectionMetadata).provider !==
        input.provider
    )
      throw unprocessable("重新连接时不能更改提供商");
    if (
      reconnect &&
      ((reconnect.connection.config.ai as AiConnectionMetadata).method !==
        input.method ||
        (reconnect.grant.kind === "user") !== (input.ownership === "personal"))
    )
      throw unprocessable(
        "重新连接时不能更改登录方式或所有权",
      );
    const id = reconnect?.connection.id ?? randomUUID();
    const grantId = reconnect?.grant.id ?? randomUUID();
    return db.transaction(async (tx) => {
      const secrets = secretService(tx);
      if (sessionId) {
        const [session] = await tx
          .select()
          .from(adapterAuthSessions)
          .where(
            and(
              input.provider === "anthropic"
                ? eq(adapterAuthSessions.publicSessionId, sessionId)
                : eq(adapterAuthSessions.id, sessionId),
              eq(adapterAuthSessions.companyId, companyId),
              eq(adapterAuthSessions.startedByUserId, userId),
            ),
          )
          .for("update");
        if (!session) throw forbidden("登录会话所有权不匹配");
        attemptStartedAt = session.createdAt;

        if (session.connectionId && session.connectionGrantId)
          return {
            connectionId: session.connectionId,
            grantId: session.connectionGrantId,
          };
        if (
          !["promoting", "submitting", "awaiting_code"].includes(
            session.status,
          ) ||
          (session.expiresAt && session.expiresAt.getTime() <= Date.now())
        )
          throw unprocessable("此次登录尝试已失效");
        if (
          !session.aiConnection ||
          session.aiConnection.provider !== input.provider ||
          session.aiConnection.method !== input.method ||
          session.aiConnection.connectionId !== input.connectionId ||
          session.aiConnection.ownership !== input.ownership ||
          session.aiConnection.allAgents !== input.allAgents ||
          JSON.stringify(session.aiConnection.agentIds) !==
            JSON.stringify(input.agentIds)
        )
          throw forbidden("登录目标不匹配");
      }
      if (reconnect) {
        const [current] = await tx
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.id, grantId))
          .for("update");
        if (
          !current ||
          current.updatedAt.getTime() !== reconnect.grant.updatedAt.getTime() ||
          current.updatedAt.getTime() > attemptStartedAt.getTime()
        )
          throw unprocessable("连接已发生变化，请重新开始连接。");
      }
      let secretId = reconnect?.grant.credentialSecretRefs.find(
        (r) => r.configPath === "ai.credential",
      )?.secretId;
      // Adoption indexes existing credentials without transferring ownership.
      // Only rotate the private slot created for this grant. A reconnect of an
      // indexed credential must leave every legacy consumer's value untouched,
      // even after adoption has cleared the connection's validation marker.
      if (secretId) {
        const [source] = await tx.select({ name: companySecrets.name, key: userSecretDefinitions.key })
          .from(companySecrets)
          .leftJoin(userSecretDefinitions, eq(userSecretDefinitions.id, companySecrets.userSecretDefinitionId))
          .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)));
        const privateSlot = input.ownership === "personal"
          ? source?.key === `ai_${grantId.replaceAll("-", "_")}`
          : source?.name === `ai-${grantId}`;
        if (!privateSlot) secretId = undefined;
      }
      if (secretId)
        await secrets.rotate(
          secretId,
          { value: verifiedCredential },
          { userId },
        );
      else if (input.ownership === "personal") {
        const definition = await secrets.createUserSecretDefinition(
          companyId,
          {
            key: `ai_${grantId.replaceAll("-", "_")}`,
            name: input.name,
            provider: "local_encrypted",
          },
          { userId },
        );
        const secret = await secrets.createCurrentUserSecretValue(
          companyId,
          userId,
          { definitionId: definition.id, value: verifiedCredential },
          { userId },
        );
        secretId = secret.id;
      } else
        secretId = (
          await secrets.create(
            companyId,
            {
              name: `ai-${grantId}`,
              provider: "local_encrypted",
              value: verifiedCredential,
            },
            { userId },
          )
        ).id;
      if (input.agentIds.length) {
        const targets = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, companyId),
              inArray(agents.id, input.agentIds),
            ),
          );
        if (targets.length !== new Set(input.agentIds).size)
          throw forbidden("智能体不属于此公司");
      }
      const key = `app-gallery:${input.provider}`;
      await tx
        .insert(toolApplications)
        .values({
          companyId,
          applicationKey: key,
          name: AI_CONNECTION_CAPABILITIES[input.provider].name,
          type: "mcp_http",
          metadata: { sourceTemplateKey: input.provider },
          ownerUserId: userId,
        })
        .onConflictDoNothing();
      const [app] = await tx
        .select()
        .from(toolApplications)
        .where(
          and(
            eq(toolApplications.companyId, companyId),
            or(
              eq(toolApplications.applicationKey, key),
              eq(
                toolApplications.name,
                AI_CONNECTION_CAPABILITIES[input.provider].name,
              ),
            ),
          ),
        );
      if (!app) throw unprocessable("未找到提供商应用");
      if (reconnect)
        await tx
          .update(toolConnections)
          .set({
            enabled: true,
            status: "active",
            healthStatus: "ok",
            healthMessage: null,
            config: { ...reconnect.connection.config, aiIsolatedSubscription: input.method === "subscription" && input.provider !== "anthropic" },
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, id));
      else
        await tx
          .insert(toolConnections)
          .values({
            id,
            companyId,
            applicationId: app.id,
            name: input.name,
            uid: `ai-${id}`,
            connectionPurpose: "ai",
            transport: "runtime_auth",
            authKind: input.method === "api_key" ? "api_key" : "oauth",
            credentialPolicy:
              input.ownership === "personal" ? "per_user" : "shared",
            status: "active",
            enabled: true,
            healthStatus: "ok",
            config: {
              sourceTemplateKey: input.provider,
              ai: { provider: input.provider, method: input.method },
              aiIsolatedSubscription: input.method === "subscription" && input.provider !== "anthropic",
            },
            createdByUserId: userId,
          });
      let accountLabel: string | undefined;
      if (input.method === "subscription" && input.provider !== "anthropic") {
        try {
          const credential = JSON.parse(verifiedCredential);
          const claims = credential.tokens?.id_token
            ? JSON.parse(
                Buffer.from(
                  credential.tokens.id_token.split(".")[1],
                  "base64url",
                ).toString(),
              )
            : credential;
          const email = claims.email ?? claims.user?.email;
          if (
            typeof email === "string" &&
            /^[^\s@/\\]{1,100}@[^\s@/\\]{1,100}\.[^\s@/\\]{2,40}$/.test(email)
          )
            accountLabel = email;
        } catch {
          /* Safe account identity is optional. */
        }
      }
      const refs = [
        {
          secretId: secretId!,
          configPath: "ai.credential",
          required: true,
          versionSelector: "latest" as const,
        },
      ];
      if (reconnect)
        await tx
          .update(connectionGrants)
          .set({
            status: "active",
            providerTenant: accountLabel ? { name: accountLabel } : {},
            credentialSecretRefs: refs,
            revokedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(connectionGrants.id, grantId));
      else
        await tx
          .insert(connectionGrants)
          .values({
            id: grantId,
            companyId,
            connectionId: id,
            kind: input.ownership === "personal" ? "user" : "organization",
            subjectUserId: input.ownership === "personal" ? userId : null,
            isDefault: input.ownership === "shared",
            providerTenant: accountLabel ? { name: accountLabel } : {},
            credentialSecretRefs: refs,
            createdByUserId: userId,
          });
      const [savedConnection] = await tx
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, id));
      await syncConnectionCredentialBindings(tx, savedConnection, refs);
      if (input.ownership === "personal") {
        await tx
          .insert(aiConnectionDefaults)
          .values({
            companyId,
            userId,
            provider: input.provider,
            method: input.method,
            grantId,
          })
          .onConflictDoNothing();
        await tx.insert(aiProviderDefaults).values({ companyId, userId, provider: input.provider, grantId }).onConflictDoNothing();
      }
      if (!reconnect) {
        const installs = input.allAgents
          ? [{ targetType: "company" as const, targetId: companyId }]
          : input.agentIds.map((targetId) => ({
              targetType: "agent" as const,
              targetId,
            }));
        if (installs.length)
          await tx
            .insert(toolConnectionInstalls)
            .values(
              installs.map((i) => ({
                ...i,
                companyId,
                connectionId: id,
                createdByUserId: userId,
              })),
            );
      }
      if (sessionId)
        await tx
          .update(adapterAuthSessions)
          .set({
            connectionId: id,
            connectionGrantId: grantId,
            connectionMethod: input.method,
            ...(input.provider === "anthropic"
              ? { status: "stored" as const }
              : {}),
          })
          .where(
            input.provider === "anthropic"
              ? eq(adapterAuthSessions.publicSessionId, sessionId)
              : eq(adapterAuthSessions.id, sessionId),
          );
      await logActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: reconnect
          ? "ai_connection.reconnected"
          : "ai_connection.connected",
        entityType: "tool_connection",
        entityId: id,
        details: { provider: input.provider, method: input.method, grantId },
      });
      return { connectionId: id, grantId };
    });
  }
  return { list, select, credential, save, setDefault, membership };
}
