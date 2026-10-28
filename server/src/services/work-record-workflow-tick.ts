import type { WorkRecordCandidateFailure } from "./work-record-candidate-scan.js";

export interface WorkRecordCandidatePage {
  processed: number;
  succeeded: number;
  failures: WorkRecordCandidateFailure[];
  nextAfterId: string | null;
}

interface WorkRecordWorkflowTickOptions {
  records: (afterId: string | null) => Promise<WorkRecordCandidatePage>;
  qualityCycles: (afterId: string | null) => Promise<WorkRecordCandidatePage>;
  packages: (afterId: string | null) => Promise<WorkRecordCandidatePage>;
  legacyOutbox: () => Promise<number>;
  workflowV2Outbox: () => Promise<number>;
}

/**
 * Own the keyset cursors and the exact scheduler order in one testable unit.
 * Candidate-level failures are evidence in the returned page; they do not
 * abort later candidate classes or either outbox.  A non-candidate failure
 * (for example a database outage while loading a page) still rejects the tick
 * so the outer scheduler can report the infrastructure failure.
 */
export function createWorkRecordWorkflowTick(options: WorkRecordWorkflowTickOptions) {
  let recordCursor: string | null = null;
  let qualityCursor: string | null = null;
  let packageCursor: string | null = null;

  return async function runWorkRecordWorkflowTick() {
    const records = await options.records(recordCursor);
    recordCursor = records.nextAfterId;
    const qualityCycles = await options.qualityCycles(qualityCursor);
    qualityCursor = qualityCycles.nextAfterId;
    const packages = await options.packages(packageCursor);
    packageCursor = packages.nextAfterId;
    const legacyProcessed = await options.legacyOutbox();
    const workflowV2Processed = await options.workflowV2Outbox();

    return {
      candidates: { records, qualityCycles, packages },
      outbox: { legacyProcessed, workflowV2Processed },
      wrapped: {
        records: recordCursor === null,
        qualityCycles: qualityCursor === null,
        packages: packageCursor === null,
      },
    };
  };
}
