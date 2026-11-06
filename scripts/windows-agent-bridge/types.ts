export type BridgeAdapterType = "codex_local" | "cursor";

export interface BridgeAgentConfig {
  remoteAgentId: string;
  remoteAgentName: string;
  localAgentName: string;
  gbrainEnvRef: string;
  adapterType: BridgeAdapterType;
  localAdapterConfig: Record<string, unknown>;
  maxConcurrentRuns: 1;
}

export interface BridgeConfig {
  schemaVersion: 3;
  deviceId: string;
  workerHome: string;
  apiBase: string;
  gbrainMcpUrl?: string;
  companyId: string;
  credentialsFile: string;
  stateFile: string;
  pollIntervalMs: number;
  agents: BridgeAgentConfig[];
}

export interface LocalAgentRuntimeConfig {
  id: string;
  companyId: string;
  name: string;
  adapterType: BridgeAdapterType;
  adapterConfig: Record<string, unknown>;
}

export interface BridgeCredentialsDocument {
  schemaVersion: 1;
  agents: Record<string, string>;
}

export type BridgeIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type BridgeIssuePriority = "critical" | "high" | "medium" | "low";

export interface BridgeInboxItem {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string;
  title: string;
  status: BridgeIssueStatus;
  priority: BridgeIssuePriority;
  assigneeAgentId: string;
  updatedAt: string;
  activeRunId: string | null;
}

export type BridgeDispatchStatus = "acquired" | "running" | "finished" | "retryable";

export interface BridgeDispatchRecord {
  leaseKey: string;
  agentId: string;
  issueId: string;
  issueUpdatedAt: string;
  identifier: string;
  status: BridgeDispatchStatus;
  attempt: number;
  acquiredAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextAttemptAt: string | null;
  pid: number | null;
  outcome: "succeeded" | "failed" | "orphaned" | null;
  errorCode: string | null;
}

export interface BridgeStateDocument {
  schemaVersion: 1;
  records: Record<string, BridgeDispatchRecord>;
}

