const BOARD_SESSION_ERROR_CODES = new Set([
  "unauthorized",
  "Bearer token is required",
]);

export function isBoardSessionRecoveryError(status: number, body: unknown): boolean {
  if (status !== 401 || !body || typeof body !== "object") return false;
  const error = (body as Record<string, unknown>).error;
  return typeof error === "string" && BOARD_SESSION_ERROR_CODES.has(error);
}

export interface BoardSessionRecoveryCoordinator {
  recoverIfNeeded: (status: number, body: unknown) => Promise<never> | null;
}

export function createBoardSessionRecoveryCoordinator(
  reloadTopLevelPage: () => void,
): BoardSessionRecoveryCoordinator {
  let recoveryPromise: Promise<never> | null = null;

  return {
    recoverIfNeeded(status, body) {
      if (!isBoardSessionRecoveryError(status, body)) return null;
      if (recoveryPromise) return recoveryPromise;

      // Board mutations can be issued after the cached session has expired.
      // Keep the failed request pending while the full-page reload lets the
      // access gate route the user to sign-in. Comment drafts are persisted by
      // the composer before the mutation, so the user's text survives.
      recoveryPromise = new Promise<never>(() => {});
      try {
        reloadTopLevelPage();
      } catch (error) {
        recoveryPromise = null;
        throw error;
      }
      return recoveryPromise;
    },
  };
}

export const boardSessionRecovery = createBoardSessionRecoveryCoordinator(() => {
  const topLevelWindow = window.top ?? window;
  topLevelWindow.location.reload();
});
