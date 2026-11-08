import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  localAgentDeviceBindings,
  projects,
} from "../../packages/db/src/index.js";
import { PAP17_G2_IDS } from "./pap17-g2-fixture-ids.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const databaseUrl = required("DATABASE_URL");
const repairToken = required("PAP17_REPAIR_TOKEN");
const qaToken = required("PAP17_QA_TOKEN");
const outputPath = path.resolve(required("PAP17_FIXTURE_IDS_PATH"));
const db = createDb(databaseUrl);
const ids = PAP17_G2_IDS;

try {
  await db.insert(companies).values({
    id: ids.companyId,
    name: "PAP-17 G2 isolated live fixture",
    issuePrefix: "G2F",
  });
  await db.insert(projects).values({
    id: ids.projectId,
    companyId: ids.companyId,
    name: "PAP-17 isolated bridge proof",
  });
  const [membership] = await db.insert(companyMemberships).values({
    companyId: ids.companyId,
    principalType: "user",
    principalId: ids.responsibleUserId,
    membershipRole: "owner",
    status: "active",
  }).returning();
  await db.insert(agents).values([
    {
      id: ids.repairAgentId,
      companyId: ids.companyId,
      name: "Rabbit",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    },
    {
      id: ids.qaAgentId,
      companyId: ids.companyId,
      name: "Luna",
      adapterType: "codex_local",
      runtimeConfig: { executionMode: "client_pull" },
    },
  ]);
  const createdKeys = await db.insert(agentApiKeys).values([
    {
      id: ids.repairKeyId,
      companyId: ids.companyId,
      agentId: ids.repairAgentId,
      name: "PAP-17 Rabbit repair bridge",
      keyHash: tokenHash(repairToken),
      responsibleUserId: ids.responsibleUserId,
    },
    {
      id: ids.qaKeyId,
      companyId: ids.companyId,
      agentId: ids.qaAgentId,
      name: "PAP-17 Luna QA bridge",
      keyHash: tokenHash(qaToken),
      responsibleUserId: ids.responsibleUserId,
    },
  ]).returning();
  await db.insert(localAgentDeviceBindings).values([
    {
      companyId: ids.companyId,
      agentId: ids.repairAgentId,
      keyId: ids.repairKeyId,
      deviceId: ids.repairDeviceId,
      createdByUserId: ids.responsibleUserId,
    },
    {
      companyId: ids.companyId,
      agentId: ids.qaAgentId,
      keyId: ids.qaKeyId,
      deviceId: ids.qaDeviceId,
      createdByUserId: ids.responsibleUserId,
    },
  ]);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 2,
    ids,
    identity: {
      responsibleUserId: ids.responsibleUserId,
      membership: {
        principalId: membership.principalId,
        status: membership.status,
      },
      repairKey: {
        id: createdKeys.find((key) => key.id === ids.repairKeyId)?.id ?? null,
        responsibleUserId: createdKeys.find((key) => key.id === ids.repairKeyId)?.responsibleUserId ?? null,
      },
      qaKey: {
        id: createdKeys.find((key) => key.id === ids.qaKeyId)?.id ?? null,
        responsibleUserId: createdKeys.find((key) => key.id === ids.qaKeyId)?.responsibleUserId ?? null,
      },
    },
  }, null, 2)}\n`, "utf8");
} finally {
  await db.$client.end();
}
