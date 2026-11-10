import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserUuid } from "./browser-uuid";

describe("createBrowserUuid", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the browser native UUID when available", () => {
    const native = "11111111-2222-4333-8444-555555555555" as `${string}-${string}-${string}-${string}-${string}`;
    const randomUUID = vi.fn(() => native);
    const getRandomValues = vi.fn() as unknown as Crypto["getRandomValues"];

    expect(createBrowserUuid({ randomUUID, getRandomValues })).toBe(native);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("builds a valid v4 UUID from getRandomValues", () => {
    const getRandomValues: Crypto["getRandomValues"] = (array) => {
      if (array) {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0xab);
      }
      return array;
    };

    expect(createBrowserUuid({ getRandomValues })).toBe(
      "abababab-abab-4bab-abab-abababababab",
    );
  });

  it("keeps plain HTTP pages working when window.crypto is unavailable", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createBrowserUuid(null)).toBe(
      "80808080-8080-4080-8080-808080808080",
    );
  });
});
