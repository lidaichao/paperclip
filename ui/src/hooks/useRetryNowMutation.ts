import { l10n } from "../i18n";
import { useCallback } from "react";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { IssueRetryNowOutcome, IssueRetryNowResponse } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { localizeRuntimeMessage } from "../lib/runtime-message-localization";

export type RetryNowError = {
  message: string;
  outcomeMessage: string | null;
  status: number | null;
};

function readErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (typeof error.message === "string" && error.message.trim().length > 0) return error.message;
    return l10n("local.request_failed_value_a904f3d0", {v0: (error.status)});
  }
  if (error instanceof Error && error.message) return error.message;
  return l10n("local.the_request_failed_try_again_in_a_moment_f6446c53");
}

export const RETRY_NOW_OUTCOME_HEADLINE: Record<IssueRetryNowOutcome, string> = {
  promoted: l10n("local.retry_promoted_0e200001"),
  already_promoted: l10n("local.retry_already_running_0e200002"),
  no_scheduled_retry: l10n("local.no_scheduled_retry_0e200003"),
  gate_suppressed: l10n("local.could_not_retry_now_0e200004"),
};

export function useRetryNowMutation(
  issueId: string | null | undefined,
): UseMutationResult<IssueRetryNowResponse, unknown, void, unknown> & {
  lastError: RetryNowError | null;
} {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const mutation = useMutation({
    mutationFn: () => {
      if (!issueId) throw new Error(l10n("local.missing_issue_id_0e200005"));
      return issuesApi.retryScheduledRetryNow(issueId);
    },
    onSuccess: (response) => {
      const responseMessage = localizeRuntimeMessage(response.message);
      if (issueId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      }
      if (response.outcome === "promoted") {
        pushToast({
          title: RETRY_NOW_OUTCOME_HEADLINE.promoted,
          body: responseMessage,
          tone: "success",
        });
      } else if (response.outcome === "gate_suppressed") {
        pushToast({
          title: RETRY_NOW_OUTCOME_HEADLINE.gate_suppressed,
          body: responseMessage,
          tone: "error",
        });
      }
    },
    onError: (error) => {
      pushToast({
        title: l10n("local.couldn_t_retry_now_7452a71d"),
        body: readErrorMessage(error),
        tone: "error",
      });
    },
  });

  const reset = mutation.reset;
  const wrappedReset = useCallback(() => reset(), [reset]);

  const lastError: RetryNowError | null = (() => {
    if (mutation.error) {
      const apiError = mutation.error instanceof ApiError ? mutation.error : null;
      return {
        message: readErrorMessage(mutation.error),
        outcomeMessage: null,
        status: apiError?.status ?? null,
      };
    }
    if (mutation.data && mutation.data.outcome === "gate_suppressed") {
      return {
        message: localizeRuntimeMessage(mutation.data.message),
        outcomeMessage: localizeRuntimeMessage(mutation.data.message),
        status: null,
      };
    }
    return null;
  })();

  return {
    ...mutation,
    reset: wrappedReset,
    lastError,
  } as UseMutationResult<IssueRetryNowResponse, unknown, void, unknown> & {
    lastError: RetryNowError | null;
  };
}
