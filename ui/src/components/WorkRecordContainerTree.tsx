import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectIteration, ProjectVersion } from "@paperclipai/shared";
import { ChevronLeft, Pencil, Settings, Trash2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ContainerTarget =
  | { kind: "version"; item: ProjectVersion }
  | { kind: "iteration"; item: ProjectIteration };

interface ContainerDraft {
  name: string;
  targetDate: string;
  startsOn: string;
  endsOn: string;
}

interface CreateDraft extends ContainerDraft {
  versionId: string;
}

const EMPTY_DRAFT: ContainerDraft = { name: "", targetDate: "", startsOn: "", endsOn: "" };
const EMPTY_CREATE_DRAFT: CreateDraft = { ...EMPTY_DRAFT, versionId: "" };

function draftFromTarget(target: ContainerTarget): ContainerDraft {
  return target.kind === "version"
    ? { ...EMPTY_DRAFT, name: target.item.name, targetDate: target.item.targetDate ?? "" }
    : { ...EMPTY_DRAFT, name: target.item.name, startsOn: target.item.startsOn ?? "", endsOn: target.item.endsOn ?? "" };
}

export function WorkRecordContainerTree({ companyId, projectId, writable = true, className, mode = "navigation", managementActive = false, selectedScope = "pool", onSelectScope, onManageContainers, onCloseManagement }: {
  companyId: string;
  projectId: string;
  writable?: boolean;
  className?: string;
  mode?: "navigation" | "management";
  managementActive?: boolean;
  selectedScope?: string;
  onSelectScope?: (scopeId: string) => void;
  onManageContainers?: () => void;
  onCloseManagement?: () => void;
}) {
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const client = useQueryClient();
  const versionsKey = queryKeys.workRecords.versions(companyId, projectId);
  const iterationsKey = queryKeys.workRecords.iterations(companyId, projectId);
  const versions = useQuery({ queryKey: versionsKey, queryFn: () => workRecordsApi.versions(companyId, projectId) });
  const iterations = useQuery({ queryKey: iterationsKey, queryFn: () => workRecordsApi.iterations(companyId, projectId) });
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [managedVersionId, setManagedVersionId] = useState<string | null>(null);
  const [createKind, setCreateKind] = useState<"version" | "iteration" | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE_DRAFT);
  const [editTarget, setEditTarget] = useState<ContainerTarget | null>(null);
  const [editDraft, setEditDraft] = useState<ContainerDraft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<ContainerTarget | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const versionRows = versions.data ?? [];
  const iterationRows = iterations.data ?? [];
  const activeVersionRows = versionRows.filter((version) => !version.archivedAt);
  const activeVersionIds = new Set(activeVersionRows.map((version) => version.id));
  const activeIterationRows = iterationRows.filter((iteration) => !iteration.archivedAt && activeVersionIds.has(iteration.versionId ?? ""));
  const versionNames = useMemo(() => new Map(versionRows.map((version) => [version.id, version.name])), [versionRows]);
  const refresh = async () => Promise.all([
    client.invalidateQueries({ queryKey: versionsKey }),
    client.invalidateQueries({ queryKey: iterationsKey }),
  ]);

  const createVersion = useMutation({
    mutationFn: () => workRecordsApi.createVersion(companyId, projectId, {
      name: createDraft.name.trim(),
      targetDate: createDraft.targetDate || null,
    }),
    onSuccess: async (created) => {
      setCreateKind(null);
      setCreateDraft(EMPTY_CREATE_DRAFT);
      setSelectedVersionId(created.id);
      await refresh();
    },
  });
  const createIteration = useMutation({
    mutationFn: () => workRecordsApi.createIteration(companyId, projectId, {
      versionId: createDraft.versionId,
      name: createDraft.name.trim(),
      startsOn: createDraft.startsOn || null,
      endsOn: createDraft.endsOn || null,
    }),
    onSuccess: async () => {
      setSelectedVersionId(createDraft.versionId);
      setCreateKind(null);
      setCreateDraft(EMPTY_CREATE_DRAFT);
      await refresh();
    },
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
  const openCreate = (kind: "version" | "iteration") => {
    createVersion.reset();
    createIteration.reset();
    const preferredVersionId = activeVersionIds.has(selectedVersionId)
      ? selectedVersionId
      : activeVersionRows[0]?.id ?? "";
    setCreateDraft({ ...EMPTY_CREATE_DRAFT, versionId: kind === "iteration" ? preferredVersionId : "" });
    setCreateKind(kind);
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
  const createError = createVersion.error ?? createIteration.error;
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

  const editAction = (target: ContainerTarget, row: "version" | "iteration") => {
    if (!writable) return null;
    return <div className={row === "version"
      ? "shrink-0 opacity-0 transition-opacity group-hover/version:opacity-100 group-focus-within/version:opacity-100"
      : "shrink-0 opacity-0 transition-opacity group-hover/iteration:opacity-100 group-focus-within/iteration:opacity-100"}>
      <Button size="icon-sm" variant="ghost" aria-label={`编辑${target.kind === "version" ? "版本" : "迭代"} ${target.item.name}`} onClick={() => openEdit(target)}>
        <Pencil className="size-3.5" />
      </Button>
    </div>;
  };

  const managementActions = (target: ContainerTarget) => {
    if (!writable) return null;
    const typeLabel = target.kind === "version" ? "版本" : "迭代";
    return <div className="flex w-20 shrink-0 items-center justify-end gap-1">
      <Button size="icon-sm" variant="ghost" aria-label={`编辑${typeLabel} ${target.item.name}`} onClick={() => openEdit(target)}><Pencil className="size-3.5" /></Button>
      <Button size="icon-sm" variant="ghost" aria-label={`删除${typeLabel} ${target.item.name}`} onClick={() => openDelete(target)}><Trash2 className="size-3.5" /></Button>
    </div>;
  };

  const managedVersion = managedVersionId
    ? versionRows.find((version) => version.id === managedVersionId) ?? null
    : null;

  const navigation = (
    <aside className={cn("px-3 py-2", className)} data-testid="version-iteration-tree" aria-label="版本与迭代">
      <div className="mb-3 flex items-center gap-1 border-b pb-3" data-testid="container-toolbar">
        {writable ? <>
          <Button className="min-w-0 flex-1 px-1" size="sm" variant="outline" onClick={() => openCreate("version")}>+版本</Button>
          <Button className="min-w-0 flex-1 px-1" size="sm" variant="outline" disabled={activeVersionRows.length === 0} onClick={() => openCreate("iteration")}>+迭代</Button>
        </> : <span className="mr-auto text-xs text-muted-foreground">只读</span>}
        <Button className="ml-auto" size="icon-sm" variant={managementActive ? "secondary" : "ghost"} aria-label="版本与迭代管理" aria-pressed={managementActive} onClick={onManageContainers}>
          <Settings className="size-4" />
        </Button>
      </div>
      <div data-testid="container-navigation">
        <button type="button" className={cn("mb-2 flex min-h-9 w-full items-center rounded px-2 text-left text-sm hover:bg-muted", selectedScope === "pool" && "bg-muted text-primary")} aria-current={selectedScope === "pool" ? "page" : undefined} onClick={() => onSelectScope?.("pool")}>需求池</button>
        {activeVersionRows.map((version) => (
          <section key={version.id} className="group/version border-t py-1 first:border-t-0" data-version-id={version.id}>
            <div className="flex min-h-9 items-center justify-between gap-1">
              <button type="button" className={cn("min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm font-medium hover:bg-muted hover:text-primary", selectedScope === version.id && "bg-muted text-primary")} aria-current={selectedScope === version.id ? "page" : undefined} onClick={() => { setSelectedVersionId(version.id); onSelectScope?.(version.id); }}>{version.name}</button>
              {editAction({ kind: "version", item: version }, "version")}
            </div>
            <div className="ml-3 border-l pl-2">
              {activeIterationRows.filter((iteration) => iteration.versionId === version.id).map((iteration) => (
                <div key={iteration.id} className="group/iteration py-1 text-xs" data-iteration-id={iteration.id}>
                  <div className="flex min-h-8 items-center justify-between gap-1">
                    <button type="button" className={cn("min-w-0 flex-1 truncate rounded px-2 py-1 text-left hover:bg-muted hover:text-primary", selectedScope === iteration.id && "bg-muted text-primary")} aria-current={selectedScope === iteration.id ? "page" : undefined} onClick={() => { setSelectedVersionId(version.id); onSelectScope?.(iteration.id); }}>{iteration.name}</button>
                    {editAction({ kind: "iteration", item: iteration }, "iteration")}
                  </div>
                  <p className="px-2 text-muted-foreground">{iteration.startsOn ?? "未设开始"} — {iteration.endsOn ?? "未设结束"}</p>
                  <div className="mx-2 mt-1 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={iteration.progress.percent} aria-label={`${iteration.name} 进度 ${iteration.progress.percent}%`}><div className="h-full bg-primary" style={{ width: `${iteration.progress.percent}%` }} /></div>
                  <p className="mt-1 px-2 text-muted-foreground">{iteration.progress.completed}/{iteration.progress.total} · {iteration.progress.percent}%</p>
                </div>
              ))}
              {activeIterationRows.every((iteration) => iteration.versionId !== version.id) ? <p className="px-2 py-2 text-xs text-muted-foreground">暂无迭代</p> : null}
            </div>
          </section>
        ))}
        {activeVersionRows.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">尚无版本。先创建版本，再添加迭代。</p> : null}
      </div>
    </aside>
  );

  const management = (
    <section className={cn("space-y-4", className)} data-testid="container-admin-view" aria-label="版本与迭代管理">
      <header className="flex min-h-11 flex-wrap items-start justify-between gap-3 border-b pb-3">
        <div>
          <h2 className="text-lg font-semibold">版本与迭代管理</h2>
          <p className="text-sm text-muted-foreground">版本是上级容器；进入版本后管理所属迭代。</p>
        </div>
        <Button variant="outline" onClick={onCloseManagement}>返回需求池</Button>
      </header>
      {writable ? <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openCreate("version")}>+版本</Button>
        <Button size="sm" variant="outline" disabled={activeVersionRows.length === 0} onClick={() => openCreate("iteration")}>+迭代</Button>
      </div> : <p className="text-xs text-muted-foreground">只读</p>}
      <div data-testid="container-manager" className="overflow-hidden rounded-lg border bg-card">
        {managedVersion ? <>
          <div className="flex min-h-11 items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <Button size="icon-sm" variant="ghost" aria-label="返回版本管理" onClick={() => setManagedVersionId(null)}><ChevronLeft className="size-4" /></Button>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{managedVersion.name}</p><p className="text-xs text-muted-foreground">版本内迭代</p></div>
            {managementActions({ kind: "version", item: managedVersion })}
          </div>
          <div className="flex min-h-10 items-center gap-3 border-b px-4 text-xs font-medium text-muted-foreground">
            <span className="min-w-0 flex-1">迭代</span><span className="w-28 shrink-0">状态与进度</span><span className="w-20 shrink-0 text-right">操作</span>
          </div>
          {iterationRows.filter((iteration) => iteration.versionId === managedVersion.id).map((iteration) => <div key={iteration.id} className="flex min-h-11 items-center gap-3 border-b px-4 py-2 last:border-b-0" data-iteration-id={iteration.id}>
            <div className="min-w-0 flex-1"><p className="truncate text-sm">{iteration.name}</p><p className="text-xs text-muted-foreground">{iteration.startsOn ?? "未设开始"} — {iteration.endsOn ?? "未设结束"}</p></div>
            <p className="w-28 shrink-0 text-xs text-muted-foreground">{iteration.archivedAt ? "已归档" : `${iteration.progress.completed}/${iteration.progress.total} · ${iteration.progress.percent}%`}</p>
            {managementActions({ kind: "iteration", item: iteration })}
          </div>)}
          {iterationRows.every((iteration) => iteration.versionId !== managedVersion.id) ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">该版本还没有迭代。</p> : null}
        </> : <>
          <div className="flex min-h-10 items-center gap-3 border-b bg-muted/40 px-4 text-xs font-medium text-muted-foreground">
            <span className="min-w-0 flex-1">版本管理</span><span className="w-28 shrink-0">状态</span><span className="w-20 shrink-0 text-right">操作</span>
          </div>
          {versionRows.map((version) => <div key={version.id} className="flex min-h-11 items-center gap-3 border-b px-4 py-2 last:border-b-0" data-version-id={version.id}>
            <button type="button" className="min-w-0 flex-1 text-left" aria-label={`管理版本 ${version.name}`} onClick={() => { setSelectedVersionId(version.id); setManagedVersionId(version.id); }}><span className="block truncate text-sm font-medium">{version.name}</span><span className="text-xs text-muted-foreground">{iterationRows.filter((iteration) => iteration.versionId === version.id).length} 个迭代</span></button>
            <span className="w-28 shrink-0 text-xs text-muted-foreground">{version.archivedAt ? "已归档" : "正常"}</span>
            {managementActions({ kind: "version", item: version })}
          </div>)}
          {versionRows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">还没有版本。</p> : null}
        </>}
      </div>
    </section>
  );

  return (
    <>
      {mode === "management" ? management : navigation}
      {lifecycle.error && !editTarget && !deleteTarget ? <div role="alert" className="mt-3 text-xs text-destructive"><p>{lifecycle.error.message}</p><Button className="mt-1" size="sm" variant="outline" onClick={() => { void versions.refetch(); void iterations.refetch(); }}>重新载入</Button></div> : null}

      <Dialog open={Boolean(createKind)} onOpenChange={(open) => { if (!open && !createVersion.isPending && !createIteration.isPending) { setCreateKind(null); setCreateDraft(EMPTY_CREATE_DRAFT); } }}>
        <DialogContent className="sm:max-w-lg" data-testid="container-create-form">
          <DialogHeader><DialogTitle>创建{createKind === "version" ? "版本" : "迭代"}</DialogTitle><DialogDescription>{createKind === "version" ? "版本用于组织其下的迭代。" : "迭代必须归属于一个版本。"}</DialogDescription></DialogHeader>
          <div className="space-y-3">
            {createKind === "iteration" ? <label className="space-y-1 text-sm font-medium"><span>所属版本</span><select aria-label="所属版本" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={createDraft.versionId} onChange={(event) => setCreateDraft((current) => ({ ...current, versionId: event.target.value }))}>{activeVersionRows.map((version) => <option key={version.id} value={version.id}>{version.name}</option>)}</select></label> : null}
            <label className="space-y-1 text-sm font-medium"><span>名称</span><Input aria-label="名称" autoFocus value={createDraft.name} onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            {createKind === "version" ? <label className="space-y-1 text-sm font-medium"><span>目标日期</span><Input aria-label="目标日期" type="date" value={createDraft.targetDate} onChange={(event) => setCreateDraft((current) => ({ ...current, targetDate: event.target.value }))} /></label> : <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm font-medium"><span>开始日期</span><Input aria-label="开始日期" type="date" value={createDraft.startsOn} onChange={(event) => setCreateDraft((current) => ({ ...current, startsOn: event.target.value }))} /></label>
              <label className="space-y-1 text-sm font-medium"><span>结束日期</span><Input aria-label="结束日期" type="date" value={createDraft.endsOn} onChange={(event) => setCreateDraft((current) => ({ ...current, endsOn: event.target.value }))} /></label>
            </div>}
          </div>
          {createError ? <p role="alert" className="text-sm text-destructive">{createError.message}</p> : null}
          <DialogFooter><Button disabled={!createDraft.name.trim() || (createKind === "iteration" && !createDraft.versionId) || createVersion.isPending || createIteration.isPending} onClick={() => createKind === "version" ? createVersion.mutate() : createIteration.mutate()}>创建{createKind === "version" ? "版本" : "迭代"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={discardConfirmOpen} onOpenChange={setDiscardConfirmOpen}>
        <DialogContent
          className="sm:max-w-md"
          showCloseButton={false}
          data-testid="container-discard-confirmation"
          onOpenAutoFocus={(event) => { event.preventDefault(); discardCancelRef.current?.focus(); }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.setTimeout(() => {
              if (editTarget) document.querySelector<HTMLElement>('[data-testid="container-edit-form"] input')?.focus();
              else editReturnFocusRef.current?.focus();
            }, 0);
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
    </>
  );
}
