const DEFAULT_RECENT_LOG_LIMIT = 40;
const RECENT_LOG_SUMMARY_LINES = 8;

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(fallbackMessage);
  if (typeof error === "string") return new Error(`${fallbackMessage}: ${error}`);

  try {
    return new Error(`${fallbackMessage}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }
}

type PostgresDiagnostic = Error & {
  code: string;
  schema?: string;
  table?: string;
  constraint?: string;
  file?: string;
  line?: string;
  routine?: string;
  position?: string;
};

// Drizzle wraps postgres.js errors in DrizzleQueryError.cause. Preserve only
// structural diagnostics: raw query parameters and DETAIL can contain private
// row values, so neither belongs in a test failure message or its cause chain.
function safePostgresDiagnostic(error: unknown): PostgresDiagnostic | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as Record<string, unknown>;
    if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      const diagnostic = new Error(`PostgreSQL SQLSTATE ${candidate.code}`) as PostgresDiagnostic;
      diagnostic.code = candidate.code;
      for (const key of ["schema", "table", "constraint"] as const) {
        const value = candidate[key];
        if (typeof value === "string" && value.length <= 63 && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
          diagnostic[key] = value;
        }
      }
      for (const key of ["file", "line", "routine", "position"] as const) {
        const value = candidate[key];
        if (typeof value === "string" && value.length <= 80 && /^[A-Za-z0-9_.-]+$/.test(value)) {
          diagnostic[key] = value;
        }
      }
      diagnostic.message = [
        `PostgreSQL SQLSTATE ${candidate.code}`,
        ...(["file", "line", "routine", "position"] as const)
          .filter((key) => diagnostic[key])
          .map((key) => `${key}=${diagnostic[key]}`),
      ].join(" ");
      return diagnostic;
    }
    current = candidate.cause;
  }
  return undefined;
}

function summarizeRecentLogs(recentLogs: string[]): string | null {
  if (recentLogs.length === 0) return null;
  return recentLogs
    .slice(-RECENT_LOG_SUMMARY_LINES)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
}

function detectEmbeddedPostgresHint(recentLogs: string[]): string | null {
  const haystack = recentLogs.join("\n").toLowerCase();
  if (!haystack.includes("could not create shared memory segment")) {
    return null;
  }

  return (
    "Embedded PostgreSQL bootstrap could not allocate shared memory. " +
    "On macOS, this usually means the host's kern.sysv.shm* limits are too low for another local PostgreSQL cluster. " +
    "Stop other local PostgreSQL servers or raise the shared-memory sysctls, then retry."
  );
}

export function createEmbeddedPostgresLogBuffer(limit = DEFAULT_RECENT_LOG_LIMIT): {
  append(message: unknown): void;
  getRecentLogs(): string[];
} {
  const recentLogs: string[] = [];

  return {
    append(message: unknown) {
      const text =
        typeof message === "string"
          ? message
          : message instanceof Error
            ? message.message
            : String(message ?? "");

      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        recentLogs.push(line);
        if (recentLogs.length > limit) {
          recentLogs.splice(0, recentLogs.length - limit);
        }
      }
    },
    getRecentLogs() {
      return [...recentLogs];
    },
  };
}

export function formatEmbeddedPostgresError(
  error: unknown,
  input: {
    fallbackMessage: string;
    recentLogs?: string[];
  },
): Error {
  const baseError = toError(error, input.fallbackMessage);
  const diagnostic = safePostgresDiagnostic(error);
  const recentLogs = input.recentLogs ?? [];
  const isQueryWrapper = baseError.name === "DrizzleQueryError" || baseError.message.startsWith("Failed query:");
  const parts = [isQueryWrapper ? input.fallbackMessage : baseError.message];
  const hint = detectEmbeddedPostgresHint(recentLogs);
  const recentSummary = summarizeRecentLogs(recentLogs);

  if (hint) {
    parts.push(hint);
  }
  if (recentSummary) {
    parts.push(`Recent embedded Postgres logs: ${recentSummary}`);
  }

  return new Error(parts.join(" "), diagnostic ? { cause: diagnostic } : undefined);
}
