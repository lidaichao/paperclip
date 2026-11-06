import { describe, expect, it } from "vitest";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";

describe("formatEmbeddedPostgresError", () => {
  it("adds a shared-memory hint when initdb logs expose the real cause", () => {
    const error = formatEmbeddedPostgresError("Postgres init script exited with code 1.", {
      fallbackMessage: "Failed to initialize embedded PostgreSQL cluster",
      recentLogs: [
        "running bootstrap script ...",
        "FATAL:  could not create shared memory segment: Cannot allocate memory",
        "DETAIL:  Failed system call was shmget(key=123, size=56, 03600).",
      ],
    });

    expect(error.message).toContain("could not allocate shared memory");
    expect(error.message).toContain("kern.sysv.shm");
    expect(error.message).toContain("could not create shared memory segment");
  });

  it("keeps only recent non-empty log lines in the collector", () => {
    const buffer = createEmbeddedPostgresLogBuffer(2);
    buffer.append("line one\n\n");
    buffer.append("line two");
    buffer.append("line three");

    expect(buffer.getRecentLogs()).toEqual(["line two", "line three"]);
  });

  it("retains SQLSTATE without exposing query parameters or row details", () => {
    const privateValue = "private-database-value";
    const postgresError = Object.assign(new Error("database row contains " + privateValue), {
      code: "23503",
      detail: `Key (token)=(${privateValue}) is not present`,
      table: "document_annotation_threads",
      constraint: "document_annotation_threads_current_revision_id_document_revisi",
    });
    const queryError = Object.assign(new Error(`Failed query: SELECT '${privateValue}'`), {
      name: "DrizzleQueryError",
      cause: postgresError,
    });

    const formatted = formatEmbeddedPostgresError(queryError, {
      fallbackMessage: "embedded Postgres migration failed",
    });
    const diagnostic = formatted.cause as Error & { code?: string; table?: string; constraint?: string };

    expect(formatted.message).toBe("embedded Postgres migration failed");
    expect(diagnostic.code).toBe("23503");
    expect(diagnostic.table).toBe("document_annotation_threads");
    expect(diagnostic.constraint).toBe("document_annotation_threads_current_revision_id_document_revisi");
    expect(`${formatted.message} ${diagnostic.message}`).not.toContain(privateValue);
    expect((diagnostic as Error & { detail?: string }).detail).toBeUndefined();
  });
});
