export interface WorkRecordCandidateFailure {
  id: string;
  code: string;
}

function candidateFailureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const details = "details" in error ? error.details : null;
    if (details && typeof details === "object" && "code" in details && typeof details.code === "string") {
      return details.code;
    }
    if ("code" in error && typeof error.code === "string") return error.code;
  }
  return error instanceof Error && error.name ? error.name : "unknown_error";
}

/**
 * Reconciliation is a recovery path, so one corrupt or temporarily
 * unavailable aggregate must not starve every later keyset page.  Keep error
 * details deliberately small: the workflow tick logs IDs and stable codes,
 * never record titles, payloads, credentials, or provider output.
 */
export async function reconcileCandidatesIndependently<T extends { id: string }>(
  candidates: readonly T[],
  reconcile: (candidate: T) => Promise<unknown>,
) {
  const failures: WorkRecordCandidateFailure[] = [];
  let succeeded = 0;
  for (const candidate of candidates) {
    try {
      await reconcile(candidate);
      succeeded += 1;
    } catch (error) {
      failures.push({ id: candidate.id, code: candidateFailureCode(error) });
    }
  }
  return { succeeded, failures };
}
