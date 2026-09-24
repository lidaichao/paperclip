import { l10n } from "../i18n";
import type {
  WorkspaceOperation,
  WorkspaceReadiness,
  WorkspaceReadinessState,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";

/**
 * Derives the workspace access state the UI shows (PAP-17572).
 *
 * The board cannot read a cloned workspace's protected health directly, so state
 * comes from three server-side facts it *can* see: the live runtime rows, the
 * workspace operation log, and the readiness the control plane reported when it
 * last tried to mint a login handoff.
 *
 * Every state carries one concrete next action. The failure this replaces was a
 * generic "Load failed" (or worse, a green badge) that told an operator nothing
 * about whether to wait, start, repair, or read a log.
 */

export type WorkspaceAccessActionKind =
  | "open"
  | "start"
  | "repair"
  | "view_logs"
  /** Nothing to do but wait for a running operation. */
  | "wait";

export type WorkspaceAccessAction = {
  kind: WorkspaceAccessActionKind;
  label: string;
};

export type WorkspaceAccessNotice = {
  title: string;
  description: string;
  action: WorkspaceAccessAction;
};

export type WorkspaceAccessDisplayState = WorkspaceReadinessState | "stopped";

export type WorkspaceAccessState = {
  state: WorkspaceAccessDisplayState;
  title: string;
  description: string;
  action: WorkspaceAccessAction;
  /** True when a password-independent handoff is the expected way in. */
  handoffAvailable: boolean;
  /** A non-blocking historical failure that is still useful to inspect. */
  secondaryNotice?: WorkspaceAccessNotice;
};

/** What the control plane said the last time a handoff was requested. */
export type WorkspaceLoginHandoffFailureInfo = {
  reason: string;
  detail?: string | null;
  readiness?: WorkspaceReadiness | null;
};

function latestOperation(operations: WorkspaceOperation[], phase: WorkspaceOperation["phase"]) {
  return operations.find((operation) => operation.phase === phase) ?? null;
}

function describeSeedPhase(readiness: WorkspaceReadiness | null | undefined): string | null {
  if (!readiness?.failurePhase && !readiness?.seedPhase) return null;
  return readiness.failurePhase ?? readiness.seedPhase ?? null;
}

function timestampMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function failedRepairNotice(repair: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof repair.metadata?.repairPhase === "string" ? repair.metadata.repairPhase : null;
  return {
    title: l10n("local.repair_failed_9445b142"),
    description: phase
      ? l10n("local.the_repair_stopped_during_value_the_pre_repai_93d51170", {v0: (phase)})
      : l10n("local.the_repair_stopped_before_the_workspace_becam_0f115777"),
    action: { kind: "view_logs", label: l10n("local.view_repair_log_bb0e22f5") },
  };
}

function failedProvisionNotice(provision: WorkspaceOperation): WorkspaceAccessNotice {
  const phase = typeof provision.metadata?.seedFailurePhase === "string"
    ? provision.metadata.seedFailurePhase
    : null;
  return {
    title: l10n("local.database_provisioning_failed_7774e3ef"),
    description: phase
      ? l10n("local.the_earlier_clone_attempt_failed_during_value_bf03dd0c", {v0: (phase)})
      : l10n("local.an_earlier_clone_attempt_failed_but_the_works_704021f4"),
    action: { kind: "view_logs", label: l10n("local.view_provisioning_log_0b151b35") },
  };
}

const HANDOFF_REASON_COPY: Record<string, string> = {
  handoff_not_configured:
    "This instance has no workspace login handoff configured, so opening the board falls back to snapshot-local credentials.",
  no_board_identity:
    "Your session has no cloned user to sign in as, so opening the board falls back to snapshot-local credentials.",
  runtime_not_running: "No healthy runtime service is publishing a URL for this workspace yet.",
  runtime_url_unusable: "The runtime row is publishing a URL Paperclip cannot open.",
  workspace_not_ready: "The cloned database is not ready to accept a login yet.",
};

const READINESS_FAILURE_COPY: Record<string, string> = {
  database_unreachable: "The isolated database is not answering.",
  clone_data_missing: "The clone restored no organization or issue rows.",
  clone_data_unreadable: "The cloned product tables could not be read.",
  cloned_membership_missing: "No cloned user has an active organization membership.",
  cloned_identity_unreadable: "The cloned identity tables could not be read.",
  auth_handoff_not_configured: "The workspace was started without a login handoff key.",
  seed_manifest_unreadable: "The seed manifest is unreadable, so the restore cannot be trusted.",
};

/**
 * Human cause for a readiness rejection, preferring the specific recorded phase
 * over a generic sentence so the copy names what to fix.
 */
export function describeWorkspaceReadinessCause(
  failure: WorkspaceLoginHandoffFailureInfo | null | undefined,
): string | null {
  if (!failure) return null;
  const phase = describeSeedPhase(failure.readiness);
  if (phase && READINESS_FAILURE_COPY[phase]) return READINESS_FAILURE_COPY[phase];
  if (phase) return `Last recorded phase: ${phase}.`;
  if (failure.detail && READINESS_FAILURE_COPY[failure.detail]) return READINESS_FAILURE_COPY[failure.detail];
  return HANDOFF_REASON_COPY[failure.reason] ?? null;
}

export function resolveWorkspaceAccessState(input: {
  runtimeServices: WorkspaceRuntimeService[] | null | undefined;
  operations: WorkspaceOperation[] | null | undefined;
  handoffFailure?: WorkspaceLoginHandoffFailureInfo | null;
}): WorkspaceAccessState {
  const operations = input.operations ?? [];
  const runtimeServices = input.runtimeServices ?? [];
  const repair = latestOperation(operations, "workspace_repair");
  const provision =
    latestOperation(operations, "workspace_seed")
    ?? latestOperation(operations, "workspace_runtime_provision")
    ?? latestOperation(operations, "workspace_provision");
  const failure = input.handoffFailure ?? null;
  const cause = describeWorkspaceReadinessCause(failure);
  const handoffAvailable = failure?.reason !== "handoff_not_configured" && failure?.reason !== "no_board_identity";
  const servingService = runtimeServices.find(
    (service) => service.status === "running" && service.healthStatus === "healthy" && service.url,
  );
  const startingService = runtimeServices.find(
    (service) => service.status === "provisioning" || service.status === "starting",
  );
  const repairFinishedAt = timestampMs(repair?.finishedAt);
  const servingServiceStartedAt = timestampMs(servingService?.startedAt);
  const provisionFinishedAt = timestampMs(provision?.finishedAt);
  const readinessConfirmsServing = Boolean(servingService && failure?.readiness?.state === "ready");
  const runtimeStartedAfterRepair = repairFinishedAt !== null
    && servingServiceStartedAt !== null
    && repairFinishedAt < servingServiceStartedAt;
  const repairFailureWasSuperseded = repair?.status === "failed" && Boolean(
    servingService
    && (readinessConfirmsServing || runtimeStartedAfterRepair),
  );
  const successfulRepairFinishedAt = repair?.status === "succeeded"
    ? timestampMs(repair.finishedAt)
    : null;
  // A failed seed is historical once the workspace is demonstrably serving,
  // or once a later repair has replaced and revalidated that database.
  const provisionFailureWasSuperseded = provision?.status === "failed" && Boolean(
    servingService
    || (
      provisionFinishedAt !== null
      && successfulRepairFinishedAt !== null
      && provisionFinishedAt < successfulRepairFinishedAt
    ),
  );
  const secondaryNotice = repair?.status === "failed" && repairFailureWasSuperseded
    ? failedRepairNotice(repair)
    : provision?.status === "failed" && provisionFailureWasSuperseded
      ? failedProvisionNotice(provision)
      : undefined;

  // A live repair outranks everything: it is already changing the answer.
  if (repair?.status === "running") {
    const phase = typeof repair.metadata?.repairPhase === "string" ? repair.metadata.repairPhase : null;
    return {
      state: "repairing",
      title: l10n("local.repairing_workspace_database_a275741a"),
      description: phase
        ? l10n("local.only_the_isolated_database_is_replaced_the_gi_4d393693", {v0: (phase)})
        : l10n("local.only_the_isolated_database_is_replaced_the_gi_f9d0a2a4"),
      action: { kind: "wait", label: l10n("local.repair_in_progress_4b259553") },
      handoffAvailable,
    };
  }
  if (repair?.status === "failed" && !repairFailureWasSuperseded) {
    const notice = failedRepairNotice(repair);
    return {
      state: "failed",
      ...notice,
      handoffAvailable,
    };
  }

  if (provision?.status === "running") {
    return {
      state: "provisioning",
      title: l10n("local.provisioning_database_1eb90451"),
      description: l10n("local.restoring_the_isolated_database_clone_for_thi_c34f6e33"),
      action: { kind: "wait", label: l10n("local.provisioning_c2b1b8e2") },
      handoffAvailable,
    };
  }
  if (provision?.status === "failed" && !provisionFailureWasSuperseded) {
    const seedPhase = typeof provision.metadata?.seedFailurePhase === "string"
      ? provision.metadata.seedFailurePhase
      : null;
    return {
      state: "failed",
      title: l10n("local.database_provisioning_failed_7774e3ef"),
      description: seedPhase
        ? l10n("local.the_clone_failed_during_value_repairing_repla_7a55f73f", {v0: (seedPhase)})
        : l10n("local.the_clone_did_not_finish_so_this_workspace_ha_82d05fc2"),
      action: { kind: "repair", label: l10n("local.repair_workspace_152f148b") },
      handoffAvailable,
    };
  }

  // Readiness the control plane actually observed beats anything inferred from
  // runtime rows, because it is the only signal that looked inside the clone.
  const staleNotReadyFailure = failure?.reason === "workspace_not_ready" && readinessConfirmsServing;
  if (failure && !staleNotReadyFailure) {
    if (failure.reason === "runtime_not_running" && !servingService && !startingService) {
      return {
        state: "stopped",
        title: l10n("local.workspace_is_not_running_992fec9f"),
        description: l10n("local.start_the_workspace_runtime_to_publish_its_bo_90464108"),
        action: { kind: "start", label: l10n("local.start_workspace_0e6b0b29") },
        handoffAvailable,
      };
    }
    if (failure.reason === "workspace_not_ready" || failure.reason === "runtime_url_unusable") {
      const readinessState = failure.readiness?.state;
      const validating = readinessState === "validating" || readinessState === "provisioning";
      return {
        state: validating ? "validating" : "degraded",
        title: validating ? l10n("local.validating_clone_d86d5002") : l10n("local.workspace_is_degraded_f238ba49"),
        description: [
          cause ?? "The workspace is serving, but its clone did not pass the readiness contract.",
          validating ? "Paperclip is still confirming the clone." : "One bounded repair replaces the isolated database.",
        ].join(" "),
        action: validating
          ? { kind: "wait", label: l10n("local.validating_5a1a167e") }
          : { kind: "repair", label: l10n("local.repair_workspace_152f148b") },
        handoffAvailable,
      };
    }
    if (!handoffAvailable) {
      return {
        state: servingService ? "ready" : "degraded",
        title: servingService ? l10n("local.ready_snapshot_local_sign_in_3eea985d") : l10n("local.workspace_is_degraded_f238ba49"),
        description: cause ?? l10n("local.opening_the_board_will_ask_for_the_credential_f2195ef5"),
        action: servingService
          ? { kind: "open", label: l10n("local.open_workspace_b3e34b18") }
          : { kind: "start", label: l10n("local.start_workspace_0e6b0b29") },
        handoffAvailable: false,
        secondaryNotice,
      };
    }
  }

  if (startingService) {
    return {
      state: "provisioning",
      title: l10n("local.workspace_is_starting_45656776"),
      description: l10n("local.paperclip_is_starting_the_workspace_runtime_a_eef837ac"),
      action: { kind: "wait", label: l10n("local.starting_workspace_7212fa79") },
      handoffAvailable,
    };
  }

  if (servingService) {
    return {
      state: "ready",
      title: l10n("local.ready_5fa7aac5"),
      description: l10n("local.opening_the_workspace_signs_you_in_to_the_clo_b7322496"),
      action: { kind: "open", label: l10n("local.open_workspace_b3e34b18") },
      handoffAvailable,
      secondaryNotice,
    };
  }

  const unhealthyService = runtimeServices.find(
    (service) => service.status === "running" && service.healthStatus !== "healthy",
  );
  if (unhealthyService) {
    return {
      state: "degraded",
      title: l10n("local.workspace_is_degraded_f238ba49"),
      description: cause
        ?? l10n("local.the_runtime_is_up_but_did_not_report_a_usable_059c9862"),
      action: { kind: "repair", label: l10n("local.repair_workspace_152f148b") },
      handoffAvailable,
    };
  }

  return {
    state: "stopped",
    title: l10n("local.workspace_is_not_running_992fec9f"),
    description: l10n("local.start_the_workspace_runtime_to_publish_its_bo_90464108"),
    action: { kind: "start", label: l10n("local.start_workspace_0e6b0b29") },
    handoffAvailable,
  };
}
