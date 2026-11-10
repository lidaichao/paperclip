type BrowserCrypto = Pick<Crypto, "getRandomValues"> &
  Partial<Pick<Crypto, "randomUUID">>;

function fallbackBytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Generates an RFC 4122 v4 UUID in both secure and plain-HTTP browser contexts.
 *
 * `crypto.randomUUID()` is unavailable when Paperclip is opened through a LAN
 * HTTP address such as `http://192.168.x.x`. Client request ids still need to
 * be valid UUIDs there, so use cryptographic bytes when available and a UUID-
 * shaped uniqueness fallback otherwise.
 */
export function createBrowserUuid(
  browserCrypto: BrowserCrypto | null | undefined = globalThis.crypto,
): string {
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }

  const bytes = browserCrypto?.getRandomValues
    ? browserCrypto.getRandomValues(new Uint8Array(16))
    : fallbackBytes();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
