import { l10n } from "../../i18n";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Loader2, Users } from "lucide-react";
import type {
  CompanySkillDetail,
  CompanySkillForkPrecheckResult,
} from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { companySkillsApi } from "@/api/companySkills";
import { queryKeys } from "@/lib/queryKeys";
import { skillStudioRoute } from "@/lib/company-skill-routes";
import { useOptionalToastActions } from "@/context/ToastContext";
import {
  agentUsageSentence,
  pickReusableFork,
  reassignTargetIds,
} from "@/lib/skill-fork";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "@/lib/utils";

/**
 * "Edit a copy" confirm dialog for read-only external skills (PAP-13112,
 * plan §3.1 / §3.2). Forks the skill through the existing fork endpoint and —
 * critically (P3, Dotta: "important! definitely need to show this to the
 * user") — surfaces how many agents run the original and offers a default-ON
 * switch to move them to the copy. When an un-diverged copy by the current
 * actor already exists, it offers to open that instead of minting another
 * (fork-sprawl guard, §5).
 */
export function ForkSkillDialog({
  companyId,
  skill,
  open,
  onOpenChange,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [reassign, setReassign] = useState(true);

  // Seed from the already-loaded skill detail so the dialog renders instantly,
  // then let the dedicated precheck endpoint refresh usage/existing-fork data.
  const seededPrecheck: CompanySkillForkPrecheckResult = useMemo(
    () => ({
      skillId: skill.id,
      original: {
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
      },
      agentUsageCount: skill.attachedAgentCount,
      usedByAgents: skill.usedByAgents,
      existingForks: skill.existingForks,
    }),
    [skill],
  );

  const precheckQuery = useQuery({
    queryKey: queryKeys.companySkills.forkPrecheck(companyId, skill.id),
    queryFn: () => companySkillsApi.forkPrecheck(companyId, skill.id),
    enabled: open && Boolean(companyId && skill.id),
    initialData: seededPrecheck,
  });

  const precheck = precheckQuery.data ?? seededPrecheck;
  const usedByAgents = precheck.usedByAgents;
  const agentCount = precheck.agentUsageCount;
  const reusableFork = useMemo(
    () => pickReusableFork(precheck.existingForks),
    [precheck.existingForks],
  );

  // Reset the toggle each time the dialog opens (default ON per §3.2).
  useEffect(() => {
    if (open) setReassign(true);
  }, [open]);

  const forkMutation = useMutation({
    mutationFn: () =>
      companySkillsApi.fork(companyId, skill.id, {
        reassignAgentIds: reassign ? reassignTargetIds(usedByAgents) : [],
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skill.id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      for (const entry of result.reassignments) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.skills(entry.agentId),
        });
      }
      const switched = result.reassignments.length;
      toast?.pushToast({
        tone: "success",
        title: "Editing a copy",
        body:
          switched > 0
            ? `Created a copy of ${skill.name} and switched ${switched} ${switched === 1 ? "agent" : "agents"} to it.`
            : `Created a copy of ${skill.name}. It's now editable.`,
      });
      onOpenChange(false);
      navigate(skillStudioRoute(result.skill.id));
    },
    onError: (error) => {
      toast?.pushToast({
        tone: "error",
        title: "Couldn't create a copy",
        body: error instanceof Error ? error.message : "The fork request failed.",
      });
    },
  });

  const busy = forkMutation.isPending;
  const forkLabel =
    reassign && agentCount > 0
      ? l10n("local.create_copy_switch_value_value_09b3ef9c", {v0: (agentCount), v1: (agentCount === 1 ? "agent" : "agents")})
      : l10n("local.create_copy_982a7984");

  const openExisting = () => {
    if (!reusableFork) return;
    onOpenChange(false);
    navigate(skillStudioRoute(reusableFork.id));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="h-4 w-4" />
            {l10n("local.edit_a_copy_of_145b4bdc")}{" "}{skill.name}
          </DialogTitle>
          <DialogDescription>
            {skill.name} {l10n("local.is_read_only_because_it_comes_from_an_externa_e9da9f4a")}</DialogDescription>
        </DialogHeader>

        {reusableFork ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="font-medium text-foreground">{l10n("local.you_already_have_a_copy_b1968595")}</p>
            <p className="mt-0.5 text-muted-foreground">
              {l10n("local.an_unedited_copy_of_this_skill_already_exists_d79a6caa")}</p>
            <Button
              type="button"
              size="sm"
              className="mt-2"
              onClick={openExisting}
              disabled={busy}
            >
              {l10n("local.open_your_existing_copy_b6026ce9")}</Button>
          </div>
        ) : null}

        {/* P3 — unmissable agent-switch block (plan §3.2), not fine print. */}
        <div
          className={cn(
            "rounded-md border p-3",
            agentCount > 0 ? "border-amber-500/40 bg-amber-500/5" : "border-border bg-muted/30",
          )}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4 shrink-0" />
            <span>{agentUsageSentence(agentCount)}</span>
          </div>

          {agentCount > 0 ? (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {usedByAgents.map((agent) => (
                  <span
                    key={agent.id}
                    className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground"
                  >
                    {agent.name}
                  </span>
                ))}
              </div>
              <label className="mt-3 flex items-start justify-between gap-3">
                <span className="text-sm">
                  <span className="font-medium text-foreground">
                    {l10n("local.switch_these_agents_to_the_copy_d734b5ee")}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {reassign
                      ? l10n("local.these_agents_will_run_your_copy_instead_of_th_30dcfe51")
                      : l10n("local.these_agents_keep_running_the_original_your_c_147029ef")}
                  </span>
                </span>
                <ToggleSwitch
                  checked={reassign}
                  onCheckedChange={setReassign}
                  disabled={busy}
                  aria-label={l10n("local.switch_these_agents_to_the_copy_d734b5ee")}
                />
              </label>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {l10n("local.nothing_is_assigned_to_it_so_your_copy_won_t_79a76038")}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {l10n("local.cancel_19766ed6")}</Button>
          <Button
            type="button"
            variant={reusableFork ? "outline" : "default"}
            onClick={() => forkMutation.mutate()}
            disabled={busy}
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {reusableFork ? l10n("local.create_another_copy_87a01d3c") : forkLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
