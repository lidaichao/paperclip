import type {
  CreateWorkRecord,
  EscalateWorkPackageAssignmentGaps,
  DispatchWorkRecord,
  LinkWorkPackageDefect,
  PrepareWorkPackageDispatch,
  PreviewWorkPackageDispatch,
  RecordPoQualityVerdict,
  RecordQaQualityVerdict,
  UpdateWorkRecord,
  WorkPackageDispatchBatchView,
  WorkPackageDispatchPreview,
  WorkPackageAssignmentEscalationReceipt,
  WorkRecordConsoleCapabilities,
  WorkRecord,
  WorkRecordViewConfig,
  WorkRecordViewKind,
  WorkRecordViewPreference,
  WorkRecordDispatchRequestResult,
  WorkRecordDispatchResult,
  WorkRecordQualityCommandResult,
  WorkRecordQualityView,
} from "@paperclipai/shared";
import { api } from "./client";

export const workRecordsApi = {
  views: (companyId: string, projectId: string, viewKind: WorkRecordViewKind) =>
    api.get<WorkRecordViewPreference[]>(`/companies/${companyId}/projects/${projectId}/work-record-views/${viewKind}`),
  createView: (companyId: string, projectId: string, viewKind: WorkRecordViewKind, input: { name: string; config: WorkRecordViewConfig }) =>
    api.post<WorkRecordViewPreference>(`/companies/${companyId}/projects/${projectId}/work-record-views/${viewKind}`, input),
  updateView: (companyId: string, projectId: string, viewKind: WorkRecordViewKind, viewId: string, input: { expectedRevision: number; name?: string; config?: WorkRecordViewConfig }) =>
    api.patch<WorkRecordViewPreference>(`/companies/${companyId}/projects/${projectId}/work-record-views/${viewKind}/${viewId}`, input),
  deleteView: (companyId: string, projectId: string, viewKind: WorkRecordViewKind, viewId: string, expectedRevision: number) =>
    api.delete<{ id: string; deleted: true }>(`/companies/${companyId}/projects/${projectId}/work-record-views/${viewKind}/${viewId}`, { expectedRevision }),
  list: (companyId: string, projectId: string) =>
    api.get<WorkRecord[]>(`/companies/${companyId}/projects/${projectId}/work-records`),
  create: (companyId: string, input: CreateWorkRecord) =>
    api.post<WorkRecord>(`/companies/${companyId}/work-records`, input),
  update: (companyId: string, projectId: string, recordId: string, input: UpdateWorkRecord) =>
    api.patch<WorkRecord>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}`, input),
  dispatch: (companyId: string, projectId: string, recordId: string, input: DispatchWorkRecord) =>
    api.post<WorkRecordDispatchResult>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/dispatch`, input),
  dispatchRequest: (companyId: string, projectId: string, recordId: string, clientRequestId: string) =>
    api.get<WorkRecordDispatchRequestResult>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/dispatch-requests/${encodeURIComponent(clientRequestId)}`),
  reconcile: (companyId: string, projectId: string, recordId: string) =>
    api.post<WorkRecord>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/reconcile`, {}),
  previewPackage: (companyId: string, projectId: string, input: PreviewWorkPackageDispatch) =>
    api.post<WorkPackageDispatchPreview>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/preview`, input),
  preparePackage: (companyId: string, projectId: string, input: PrepareWorkPackageDispatch) =>
    api.post<WorkPackageDispatchBatchView>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/prepare`, input),
  capabilities: (companyId: string, projectId: string) =>
    api.get<WorkRecordConsoleCapabilities>(`/companies/${companyId}/projects/${projectId}/work-record-capabilities`),
  escalateAssignmentGaps: (companyId: string, projectId: string, input: EscalateWorkPackageAssignmentGaps) =>
    api.post<WorkPackageAssignmentEscalationReceipt>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/assignment-gap-escalations`, input),
  latestAssignmentGapEscalation: (companyId: string, projectId: string, rootRecordId: string) =>
    api.get<WorkPackageAssignmentEscalationReceipt | null>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/assignment-gap-escalations/latest?rootRecordId=${encodeURIComponent(rootRecordId)}`),
  packageBatch: (companyId: string, projectId: string, batchId: string) =>
    api.get<WorkPackageDispatchBatchView>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/${batchId}`),
  reconcilePackage: (companyId: string, projectId: string, batchId: string) =>
    api.post<WorkPackageDispatchBatchView>(`/companies/${companyId}/projects/${projectId}/work-package-dispatch/${batchId}/reconcile`, {}),
  quality: (companyId: string, projectId: string, recordId: string) =>
    api.get<WorkRecordQualityView>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/quality`),
  recordPoVerdict: (companyId: string, projectId: string, recordId: string, input: RecordPoQualityVerdict) =>
    api.post<WorkRecordQualityCommandResult>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/quality/po-verdicts`, input),
  recordQaVerdict: (companyId: string, projectId: string, recordId: string, input: RecordQaQualityVerdict) =>
    api.post<WorkRecordQualityCommandResult>(`/companies/${companyId}/projects/${projectId}/work-records/${recordId}/quality/qa-verdicts`, input),
  linkDefect: (companyId: string, projectId: string, input: LinkWorkPackageDefect) =>
    api.post<WorkRecordQualityCommandResult>(`/companies/${companyId}/projects/${projectId}/work-record-quality/defect-links`, input),
};
