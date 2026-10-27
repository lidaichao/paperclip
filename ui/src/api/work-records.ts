import type { CreateWorkRecord, DispatchWorkRecord, UpdateWorkRecord, WorkRecord, WorkRecordDispatchRequestResult, WorkRecordDispatchResult } from "@paperclipai/shared";
import { api } from "./client";

export const workRecordsApi = {
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
};
