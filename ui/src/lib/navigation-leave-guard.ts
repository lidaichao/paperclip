type LeaveGuard = () => Promise<boolean>;

type ActiveGuard = {
  guard: LeaveGuard;
  historyIndex: number | null;
  url: string;
};

let activeGuard: ActiveGuard | null = null;
let installed = false;
let restoring = false;
let allowing = false;
let attemptedDelta = 0;

function historyIndex(state: unknown): number | null {
  if (!state || typeof state !== "object" || !("idx" in state)) return null;
  const value = (state as { idx?: unknown }).idx;
  return typeof value === "number" ? value : null;
}

function handlePopState(event: PopStateEvent) {
  if (allowing) {
    allowing = false;
    return;
  }
  const registered = activeGuard;
  if (!registered) return;

  event.stopImmediatePropagation();
  if (restoring) {
    restoring = false;
    void registered.guard().then((allowed) => {
      if (!allowed) return;
      allowing = true;
      window.history.go(attemptedDelta);
    });
    return;
  }

  const nextIndex = historyIndex(event.state);
  if (registered.historyIndex !== null && nextIndex !== null) {
    attemptedDelta = nextIndex - registered.historyIndex;
    if (attemptedDelta !== 0) {
      restoring = true;
      window.history.go(-attemptedDelta);
      return;
    }
  }

  window.history.pushState(window.history.state, "", registered.url);
  void registered.guard().then((allowed) => {
    if (allowed) window.location.assign(window.location.href);
  });
}

export function installNavigationLeaveGuard() {
  if (installed) return;
  installed = true;
  window.addEventListener("popstate", handlePopState, true);
}

export function registerNavigationLeaveGuard(guard: LeaveGuard) {
  const registration: ActiveGuard = {
    guard,
    historyIndex: historyIndex(window.history.state),
    url: window.location.href,
  };
  activeGuard = registration;
  return () => {
    if (activeGuard === registration) activeGuard = null;
  };
}
