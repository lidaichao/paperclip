/** 自动替代要求每个边界都有明确的肯定证据。 */
export interface NativeReplacementEvidence {
  failedSession: boolean;
  failureMeaningKnown: boolean;
  predecessorFenced: boolean;
  providerStopped: boolean;
  workspacePreserved: boolean;
  historyComplete: boolean;
  effectInventoryComplete: boolean;
  attempts: number;
  invocations: Array<{
    id: string;
    toolName: string;
    riskLevel: string | null;
    status: string;
    completedAt: Date | null;
    resultHash: string | null;
  }>;
  apiReceipts: Record<string, unknown>;
  uncertainProviderActions: string[];
}
export type NativeReplacementDecision =
  | { allowed: true; remainingAttempts: number }
  | { allowed: false; cause: string; nextAction: string };
export function decideNativeReplacement(
  evidence: NativeReplacementEvidence,
): NativeReplacementDecision {
  const stop = (
    cause: string,
    nextAction: string,
  ): NativeReplacementDecision => ({ allowed: false, cause, nextAction });
  if (!evidence.failedSession)
    return stop(
      "session_replacement_not_required",
      "如果现有会话的检查点仍可用，请恢复该会话。",
    );
  if (!evidence.failureMeaningKnown)
    return stop(
      "provider_failure_meaning_unverified",
      "检查原始提供方故障并核对其操作历史。未分类的传输故障无法证明新会话是安全的。",
    );
  if (evidence.attempts >= 3)
    return stop(
      "execution_recovery_budget_exhausted",
      "检查原始故障并选择恢复操作；三次执行尝试已全部用完。",
    );
  if (!evidence.predecessorFenced || !evidence.providerStopped)
    return stop(
      "provider_ownership_unverified",
      "继续前，请确认上一个提供方已经停止，并撤销其执行权限。",
    );
  if (!evidence.effectInventoryComplete)
    return stop(
      "provider_effect_inventory_unavailable",
      "继续前，请检查提供方的完整操作历史并核对结果；本次运行没有记录已验证的操作清单。",
    );
  if (!evidence.workspacePreserved || !evidence.historyComplete)
    return stop(
      "continuation_evidence_incomplete",
      "继续前，请恢复任务工作区和所需的对话历史。",
    );
  const incompleteReceipt = Object.entries(evidence.apiReceipts).find(
    ([, receipt]) =>
      !receipt ||
      typeof receipt !== "object" ||
      !("state" in receipt) ||
      receipt.state !== "completed",
  );
  if (incompleteReceipt)
    return stop(
      "uncertain_control_plane_action",
      `重新执行控制面操作 ${incompleteReceipt[0]} 前，请先核对其结果。`,
    );
  // 旧回执只能通过哈希识别请求。新的提供方无法判断该哈希对应哪项已完成操作，
  // 因此不能安全地依赖该回执来避免用新调用 ID 重复操作。
  const unidentifiedReceipt = Object.entries(evidence.apiReceipts).find(
    ([, receipt]) => {
      const value = receipt as Record<string, unknown>;
      return typeof value.operationId !== "string" || !("result" in value);
    },
  );
  if (unidentifiedReceipt)
    return stop(
      "completed_action_context_missing",
      `继续前，请识别已完成的控制面操作 ${unidentifiedReceipt[0]}，并在续办上下文中保留其结果。`,
    );
  const invocation = evidence.invocations.find(
    (row) =>
      row.riskLevel !== "read" ||
      row.status !== "succeeded" ||
      !row.completedAt ||
      !row.resultHash,
  );
  if (invocation)
    return stop(
      "uncertain_external_action",
      `继续前，请核对 ${invocation.toolName}（调用 ${invocation.id}）并保留其结果。不要自动重复该操作。`,
    );
  if (evidence.uncertainProviderActions.length)
    return stop(
      "uncertain_provider_action",
      `继续前，请核对提供方操作 ${evidence.uncertainProviderActions[0]}。提供方原生命令没有可靠的结果回执。`,
    );
  return { allowed: true, remainingAttempts: 3 - evidence.attempts };
}
