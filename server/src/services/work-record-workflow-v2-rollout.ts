import { WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT } from "@paperclipai/shared";

export const WORK_RECORD_WORKFLOW_V2_COHORTS_ENV =
  "PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS";

export type WorkRecordWorkflowV2Scope = {
  companyId: string;
  projectId: string;
};

export type WorkRecordWorkflowV2RolloutDecision = {
  globalEnabled: boolean;
  scopeEnabled: boolean;
  configured: boolean;
  source: "environment" | "service_override";
  reason:
    | "enabled"
    | "global_disabled"
    | "cohort_missing"
    | "cohort_invalid"
    | "scope_not_approved";
};

export type WorkRecordWorkflowV2Rollout = {
  globalEnabled: boolean;
  allScopes: boolean;
  scopes: readonly WorkRecordWorkflowV2Scope[];
  source: "environment" | "service_override";
  configurationError: "cohort_missing" | "cohort_invalid" | null;
  decision(companyId: string, projectId: string): WorkRecordWorkflowV2RolloutDecision;
};

type RolloutEnv = {
  PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED?: string;
  PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enabledFlag(value: string | undefined) {
  if (value === undefined) return WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED_BY_DEFAULT;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseScopes(raw: string | undefined): {
  scopes: WorkRecordWorkflowV2Scope[];
  error: "cohort_missing" | "cohort_invalid" | null;
} {
  if (!raw?.trim()) return { scopes: [], error: "cohort_missing" };
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length === 0) {
      return { scopes: [], error: "cohort_invalid" };
    }
    const scopes: WorkRecordWorkflowV2Scope[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") return { scopes: [], error: "cohort_invalid" };
      const companyId = (entry as Record<string, unknown>).companyId;
      const projectIds = (entry as Record<string, unknown>).projectIds;
      if (typeof companyId !== "string" || !UUID.test(companyId) || !Array.isArray(projectIds) || projectIds.length === 0) {
        return { scopes: [], error: "cohort_invalid" };
      }
      for (const projectId of projectIds) {
        if (typeof projectId !== "string" || !UUID.test(projectId)) {
          return { scopes: [], error: "cohort_invalid" };
        }
        scopes.push({ companyId, projectId });
      }
    }
    const unique = new Map(scopes.map((scope) => [`${scope.companyId}:${scope.projectId}`, scope]));
    return { scopes: [...unique.values()], error: null };
  } catch {
    return { scopes: [], error: "cohort_invalid" };
  }
}

export function resolveWorkRecordWorkflowV2Rollout(
  options: { writesEnabled?: boolean; env?: RolloutEnv } = {},
): WorkRecordWorkflowV2Rollout {
  if (options.writesEnabled !== undefined) {
    const globalEnabled = options.writesEnabled;
    return {
      globalEnabled,
      allScopes: globalEnabled,
      scopes: [],
      source: "service_override",
      configurationError: null,
      decision: () => ({
        globalEnabled,
        scopeEnabled: globalEnabled,
        configured: globalEnabled,
        source: "service_override",
        reason: globalEnabled ? "enabled" : "global_disabled",
      }),
    };
  }

  const env = options.env ?? process.env;
  const globalEnabled = enabledFlag(env.PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED);
  const parsed = parseScopes(env[WORK_RECORD_WORKFLOW_V2_COHORTS_ENV]);
  const approved = new Set(parsed.scopes.map((scope) => `${scope.companyId}:${scope.projectId}`));
  return {
    globalEnabled,
    allScopes: false,
    scopes: parsed.scopes,
    source: "environment",
    configurationError: parsed.error,
    decision(companyId, projectId) {
      const configured = parsed.error === null;
      const scopeEnabled = globalEnabled && configured && approved.has(`${companyId}:${projectId}`);
      return {
        globalEnabled,
        scopeEnabled,
        configured,
        source: "environment",
        reason: !globalEnabled
          ? "global_disabled"
          : parsed.error ?? (scopeEnabled ? "enabled" : "scope_not_approved"),
      };
    },
  };
}
