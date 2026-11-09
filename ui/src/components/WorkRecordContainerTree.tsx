import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectIteration, ProjectVersion } from "@paperclipai/shared";
import { MoreHorizontal, Pencil } from "lucide-react";
import { ApiError } from "@/api/client";
import { workRecordsApi } from "@/api/work-records";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

type ContainerTarget =
  | { kind: "version"; item: ProjectVersion }
  | { kind: "iteration"; item: ProjectIteration };

interface ContainerDraft {
  name: string;
  targetDate: string;
  startsOn: string;
  endsOn: string;
}

const EMPTY_DRAFT: ContainerDraft = { name: "", targetDate: "", startsOn: "", endsOn: "" };

function draftFromTarget(target: ContainerTarget): ContainerDraft {
  return target.kind === "version"
    ? { ...EMPTY_DRAFT, name: target.item.name, targetDate: target.item.targetDate ?? "" }
    : { ...EMPTY_DRAFT, name: target.item.name, startsOn: target.item.startsOn ?? "", endsOn: target.item.endsOn ?? "" };
}

export function WorkRecordContainerTree({ companyId, projectId, writable = true }: {
  companyId: string;
  projectId: string;
  writable?: boolean;
}) {
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const versionsKey = queryKeys.workRecords.versions(companyId, projectId);
  const iterationsKey = queryKeys.workRecords.iterations(companyId, projectId);
  const versions = useQuery({ queryKey: versionsKey, queryFn: () => workRecordsApi.versions(companyId, projectId) });
  const iterations = useQuery({ queryKey: iterationsKey, queryFn: () => workRecordsApi.iterations(companyId, projectId) });
  const [versionName, setVersionName] = useState("");
  const [iterationName, setIterationName] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [editTarget, setEditTarget] = useState<ContainerTarget | null>(null);
  const [editDraft, setEditDraft] = useState<ContainerDraft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<ContainerTarget | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const versionRows = versions.data ?? [];
  const iterationRows = iterations.data ?? [];
  const versionNames = useMemo(() => new Map(versionRows.map((version) => [version.id, version.name])), [versionRows]);
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
  const lifecycle = useMutation({
    mutationFn: async (input: { target: ContainerTarget; operation: "archive" | "restore" | "delete" }) => {
      const { target, operation } = input;
      if (target.kind === "version") {
        return operation === "delete"
          ? workRecordsApi.deleteVersion(companyId, projectId, target.item.id, target.item.revision)
          : workRecordsApi.mutateVersion(companyId, projectId, target.item.id, operation, target.item.revision);
      }
      return operation === "delete"
        ? workRecordsApi.deleteIteration(companyId, projectId, target.item.id, target.item.revision)
        : workRecordsApi.mutateIteration(companyId, projectId, target.item.id, operation, target.item.revision);
    },
    onSuccess: async (_result, variables) => {
      if (variables.operation === "delete") { setDeleteTarget(null); setDeleteName(""); }
      if (variables.operation !== "delete") setEditTarget(null);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: async (revisionOverride?: number) => {
      if (!editTarget) throw new Error("没有正在编辑的版本或迭代");
      const expectedRevision = revisionOverride ?? editTarget.item.revision;
      if (editTarget.kind === "version") {
        return workRecordsApi.updateVersion(companyId, projectId, editTarget.item.id, {
          expectedRevision,
          name: editDraft.name.trim(),
          targetDate: editDraft.targetDate || null,
        });
      }
      return workRecordsApi.updateIteration(companyId, projectId, editTarget.item.id, {
        expectedRevision,
        name: editDraft.name.trim(),
        startsOn: editDraft.startsOn || null,
        endsOn: editDraft.endsOn || null,
      });
    },
    onSuccess: async () => { setEditTarget(null); await refresh(); },
  });

  const openEdit = (target: ContainerTarget) => {
    editReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    update.reset();
    lifecycle.reset();
    setEditTarget(target);
    setEditDraft(draftFromTarget(target));
  };
  const openDelete = (target: ContainerTarget) => {
    lifecycle.reset();
    setDeleteTarget(target);
    setDeleteName("");
  };
  const reloadRemote = async () => {
    if (!editTarget) return;
    const result = editTarget.kind === "version" ? await versions.refetch() : await iterations.refetch();
    const remote = result.data?.find((item) => item.id === editTarget.item.id);
    if (!remote) return;
    const next = { kind: editTarget.kind, item: remote } as ContainerTarget;
    setEditTarget(next);
    setEditDraft(draftFromTarget(next));
    update.reset();
  };
  const retryMine = async () => {
    if (!editTarget) return;
    const result = editTarget.kind === "version" ? await versions.refetch() : await iterations.refetch();
    const remote = result.data?.find((item) => item.id === editTarget.item.id);
    if (!remote) return;
    setEditTarget({ kind: editTarget.kind, item: remote } as ContainerTarget);
    await update.mutateAsync(remote.revision);
  };
  const conflict = update.error instanceof ApiError && update.error.status === 409;
  const error = createVersion.error ?? createIteration.error ?? lifecycle.error;
  const editDraftDirty = editTarget
    ? JSON.stringify(editDraft) !== JSON.stringify(draftFromTarget(editTarget))
    : false;
  const requestEditClose = () => {
    if (update.isPending || lifecycle.isPending) return;
    if (editDraftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    setEditTarget(null);
  };
  const discardEdit = () => {
    setDiscardConfirmOpen(false);
    setEditTarget(null);
    setEditDraft(EMPTY_DRAFT);
    update.reset();
    lifecycle.reset();
  };

  const actions = (target: ContainerTarget, row: "version" | "iteration") => {
    if (!writable) return null;
    return <div className={row === "version"
      ? "flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/version:opacity-100 group-focus-within/version:opacity-100"
      : "flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/iteration:opacity-100 group-focus-within/iteration:opacity-100"}>
      <Button size="icon-sm" variant="ghost" aria-label={`编辑${target.kind === "version" ? "版本" : "迭代"} ${target.item.name}`} onClick={() => openEdit(target)}>
        <Pencil className="size-3.5" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`${target.item.name} 操作菜单`}><MoreHorizontal className="size-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openEdit(target)}><Pencil />编辑</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => openDelete(target)}>删除空容器</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>;
  };

  return (
    <aside className="rounded-lg border bg-card p-3" data-testid="version-iteration-tree" aria-label="版本与迭代">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">版本与迭代</h3>
        {!writable ? <span className="text-xs text-muted-foreground">只读</span> : null}
      </div>
      <div className="space-y-3">
        {versionRows.map((version) => (
          <section key={version.id} className="group/version rounded border p-2" data-version-id={version.id}>
            <div className="flex min-h-8 items-center justify-between gap-2">
              <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => setSelectedVersionId(version.id)}>{version.name}{version.archivedAt ? "（已归档）" : ""}</button>
              {actions({ kind: "version", item: version }, "version")}
            </div>
            <div className="mt-2 space-y-2 border-l pl-3">
              {iterationRows.filter((iteration) => iteration.versionId === version.id).map((iteration) => (
                <div key={iteration.id} className="group/iteration text-xs" data-iteration-id={iteration.id}>
                  <div className="flex min-h-8 items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">{iteration.name}{iteration.archivedAt ? "（已归档）" : ""}</span>
                    {actions({ kind: "iteration", item: iteration }, "iteration")}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={iteration.progress.percent} aria-label={`${iteration.name} 进度 ${iteration.progress.percent}%`}><div className="h-full bg-primary" style={{ width: `${iteration.progress.percent}%` }} /></div>
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

      <Dialog open={Boolean(editTarget)} onOpenChange={(open) => { if (!open) requestEditClose(); }}>
        <DialogContent className="sm:max-w-lg" data-testid="container-edit-form" onCloseAutoFocus={(event) => {
          if (!editReturnFocusRef.current?.isConnected) return;
          event.preventDefault();
          editReturnFocusRef.current.focus();
        }}>
          <DialogHeader>
            <DialogTitle>编辑{editTarget?.kind === "version" ? "版本" : "迭代"}</DialogTitle>
            <DialogDescription>{editTarget?.kind === "iteration" ? `上级版本：${versionNames.get(editTarget.item.versionId ?? "") ?? "未归属"}` : "修改名称和目标日期。"}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="space-y-1 text-sm font-medium"><span>名称</span><Input autoFocus value={editDraft.name} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            {editTarget?.kind === "version" ? <label className="space-y-1 text-sm font-medium"><span>目标日期</span><Input type="date" value={editDraft.targetDate} onChange={(event) => setEditDraft((current) => ({ ...current, targetDate: event.target.value }))} /></label> : <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm font-medium"><span>开始日期</span><Input type="date" value={editDraft.startsOn} onChange={(event) => setEditDraft((current) => ({ ...current, startsOn: event.target.value }))} /></label>
              <label className="space-y-1 text-sm font-medium"><span>结束日期</span><Input type="date" value={editDraft.endsOn} onChange={(event) => setEditDraft((current) => ({ ...current, endsOn: event.target.value }))} /></label>
            </div>}
          </div>
          {update.error ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{conflict ? "远端版本已变化。你的输入仍保留，请选择恢复方式。" : update.error.message}</p>{conflict ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void reloadRemote()}>重新载入远端</Button><Button size="sm" onClick={() => void retryMine()}>复制我的修改后重试</Button></div> : null}</div> : null}
          {lifecycle.error ? <p role="alert" className="text-sm text-destructive">{lifecycle.error.message}</p> : null}
          {editDraftDirty ? <p role="status" className="text-sm text-muted-foreground">有未保存修改，请先保存后再{editTarget?.item.archivedAt ? "恢复" : "归档"}。</p> : null}
          <DialogFooter className="items-center justify-between sm:justify-between">
            <Button data-testid="container-lifecycle-action" variant={editTarget?.item.archivedAt ? "outline" : "destructive"} disabled={editDraftDirty || lifecycle.isPending || update.isPending} onClick={() => editTarget && lifecycle.mutate({ target: editTarget, operation: editTarget.item.archivedAt ? "restore" : "archive" })}>{editTarget?.item.archivedAt ? "恢复" : "归档"}</Button>
            <Button disabled={!editDraft.name.trim() || update.isPending || lifecycle.isPending} onClick={() => update.mutate(undefined)}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardConfirmOpen} onOpenChange={(open) => {
        setDiscardConfirmOpen(open);
        if (!open) window.setTimeout(() => editReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : editReturnFocusRef.current, 0);
      }}>
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          data-testid="container-discard-confirmation"
          onOpenAutoFocus={(event) => { event.preventDefault(); discardCancelRef.current?.focus(); }}
          onCloseAutoFocus={(event) => {
            if (!editTarget) return;
            event.preventDefault();
            window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="container-edit-form"] input')?.focus(), 0);
          }}
        >
          <DialogHeader>
            <DialogTitle>放弃未保存修改？</DialogTitle>
            <DialogDescription>当前版本或迭代的修改尚未保存。继续编辑可保留全部输入。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button ref={discardCancelRef} variant="outline" onClick={() => setDiscardConfirmOpen(false)}>继续编辑</Button>
            <Button variant="destructive" onClick={discardEdit}>放弃修改</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !lifecycle.isPending) { setDeleteTarget(null); setDeleteName(""); } }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="container-delete-confirmation" onOpenAutoFocus={(event) => { event.preventDefault(); deleteCancelRef.current?.focus(); }}>
          <DialogHeader><DialogTitle>删除空{deleteTarget?.kind === "version" ? "版本" : "迭代"}</DialogTitle><DialogDescription>此操作不可恢复。服务端还会核对下级容器和关联记录。请输入对象名称确认。</DialogDescription></DialogHeader>
          <label className="space-y-1 text-sm font-medium"><span>对象名称：{deleteTarget?.item.name}</span><Input value={deleteName} onChange={(event) => setDeleteName(event.target.value)} /></label>
          {lifecycle.error ? <p role="alert" className="text-sm text-destructive">{lifecycle.error.message}</p> : null}
          <DialogFooter><Button ref={deleteCancelRef} variant="outline" onClick={() => { setDeleteTarget(null); setDeleteName(""); }}>取消</Button><Button variant="destructive" disabled={!deleteTarget || deleteName !== deleteTarget.item.name || lifecycle.isPending} onClick={() => deleteTarget && lifecycle.mutate({ target: deleteTarget, operation: "delete" })}>确认删除</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
