import { describe, expect, it, vi } from "vitest";
import {
  createBoardSessionRecoveryCoordinator,
  isBoardSessionRecoveryError,
} from "./board-session-recovery";

describe("isBoardSessionRecoveryError", () => {
  it.each(["unauthorized", "Bearer token is required"])(
    "recognizes the %s board-session error",
    (error) => {
      expect(isBoardSessionRecoveryError(401, { error })).toBe(true);
    },
  );

  it.each([
    [403, { error: "unauthorized" }],
    [401, { error: "forbidden" }],
    [401, { error: { code: "unauthorized" } }],
    [401, null],
  ])("rejects status/body combination %j %j", (status, body) => {
    expect(isBoardSessionRecoveryError(status, body)).toBe(false);
  });
});

describe("board-session recovery coordinator", () => {
  it("reloads once and shares one never-settling promise", async () => {
    const reload = vi.fn();
    const recovery = createBoardSessionRecoveryCoordinator(reload);

    const first = recovery.recoverIfNeeded(401, { error: "unauthorized" });
    const second = recovery.recoverIfNeeded(401, { error: "Bearer token is required" });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(reload).toHaveBeenCalledTimes(1);

    let settled = false;
    void first?.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("does nothing for a permission denial", () => {
    const reload = vi.fn();
    const recovery = createBoardSessionRecoveryCoordinator(reload);

    expect(recovery.recoverIfNeeded(403, { error: "forbidden" })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
