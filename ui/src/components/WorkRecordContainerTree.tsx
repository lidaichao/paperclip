import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectIteration, ProjectVersion } from "@paperclipai/shared";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function WorkRecordContainerTree({ companyId, projectId, writable = true }: {
  companyId: string;
  projectId: string;
  writable?: boolean;
}) {
  const client = useQueryClient();
  const versionsKey = queryKeys.workRecords.versions(companyId, projectId);
  const iterationsKey = queryKeys.workRecords.iterations(companyId, projectId);
  const versions = useQuery({ queryKey: versionsKey, queryFn: () => workRecordsApi.versions(companyId, projectId) });
  const iterations = useQuery({ queryKey: iterationsKey, queryFn: () => workRecordsApi.iterations(companyId, projectId) });
  const [versionName, setVersionName] = useState("");
  const [iterationName, setIterationName] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const refresh = async () => Promise.all([
    client.invalidateQueries({ queryKey: versionsKey }),
    client.invalidateQueries({ queryKey: iterationsKey }),
  ]);
  const createVersion = useMutation({
    mutationFn: () => workRecordsApi.createVersion(companyId, projectId, { name: versionName.trim() }),
    onSuccess: async (created) => { setVersionName(""); setSelectedVersionId(created.id); await refresh(); },
  });
  const createIteration = useMutation({
    mutationFn: () => workRecordsApi.createIteration(companyId, projectId, { versionId: selectedVersionId, name: iterationName.trim() }),
    onSuccess: async () => { setIterationName(""); await refresh(); },
  });
  const mutate = useMutation({
    mutationFn: async (input: { type: "version" | "iteration"; item: ProjectVersion | ProjectIteration; operation: "archive" | "restore" | "delete" }) => {
      if (input.type === "version") {
        return input.operation === "delete"
          ? workRecordsApi.deleteVersion(companyId, projectId, input.item.id, input.item.revision)
          : workRecordsApi.mutateVersion(companyId, projectId, input.item.id, input.operation, input.item.revision);
      }
      return input.operation === "delete"
        ? workRecordsApi.deleteIteration(companyId, projectId, input.item.id, input.item.revision)
        : workRecordsApi.mutateIteration(companyId, projectId, input.item.id, input.operation, input.item.revision);
    },
    onSuccess: refresh,
  });
  const error = createVersion.error ?? createIteration.error ?? mutate.error;
  const versionRows = versions.data ?? [];
  const iterationRows = iterations.data ?? [];

  return (
    <aside className="rounded-lg border bg-card p-3" data-testid="version-iteration-tree" aria-label="版本与迭代">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">版本与迭代</h3>
        {!writable ? <span className="text-xs text-muted-foreground">只读</span> : null}
      </div>
      <div className="space-y-3">
        {versionRows.map((version) => (
          <section key={version.id} className="rounded border p-2" data-version-id={version.id}>
            <div className="flex items-center justify-between gap-2">
              <button type="button" className="truncate text-left text-sm font-medium" onClick={() => setSelectedVersionId(version.id)}>{version.name}{version.archivedAt ? "（已归档）" : ""}</button>
              {writable ? <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => mutate.mutate({ type: "version", item: version, operation: version.archivedAt ? "restore" : "archive" })}>{version.archivedAt ? "恢复" : "归档"}</Button>
                <Button size="sm" variant="ghost" onClick={() => mutate.mutate({ type: "version", item: version, operation: "delete" })}>删除</Button>
              </div> : null}
            </div>
            <div className="mt-2 space-y-2 border-l pl-3">
              {iterationRows.filter((iteration) => iteration.versionId === version.id).map((iteration) => (
                <div key={iteration.id} className="text-xs" data-iteration-id={iteration.id}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{iteration.name}{iteration.archivedAt ? "（已归档）" : ""}</span>
                    {writable ? <div className="flex gap-1">
                      <button type="button" onClick={() => mutate.mutate({ type: "iteration", item: iteration, operation: iteration.archivedAt ? "restore" : "archive" })}>{iteration.archivedAt ? "恢复" : "归档"}</button>
                      <button type="button" onClick={() => mutate.mutate({ type: "iteration", item: iteration, operation: "delete" })}>删除</button>
                    </div> : null}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" aria-label={`${iteration.progress.percent}%`}><div className="h-full bg-primary" style={{ width: `${iteration.progress.percent}%` }} /></div>
                  <p className="mt-1 text-muted-foreground">{iteration.progress.completed}/{iteration.progress.total} · {iteration.progress.percent}%</p>
                </div>
              ))}
            </div>
          </section>
        ))}
        {versionRows.length === 0 ? <p className="text-xs text-muted-foreground">尚无版本。先创建版本，再添加迭代。</p> : null}
      </div>
      {writable ? <div className="mt-3 space-y-2 border-t pt-3">
        <div className="flex gap-2"><Input aria-label="新版本名称" value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="新版本" /><Button size="sm" disabled={!versionName.trim() || createVersion.isPending} onClick={() => createVersion.mutate()}>创建</Button></div>
        <div className="flex gap-2">
          <select aria-label="迭代所属版本" className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}><option value="">选择版本</option>{versionRows.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <Input aria-label="新迭代名称" value={iterationName} onChange={(event) => setIterationName(event.target.value)} placeholder="新迭代" />
          <Button size="sm" disabled={!selectedVersionId || !iterationName.trim() || createIteration.isPending} onClick={() => createIteration.mutate()}>添加</Button>
        </div>
      </div> : null}
      {error ? <div role="alert" className="mt-3 text-xs text-destructive"><p>{error.message}</p><Button className="mt-1" size="sm" variant="outline" onClick={() => { void versions.refetch(); void iterations.refetch(); }}>重新载入，保留输入草稿</Button></div> : null}
    </aside>
  );
}
