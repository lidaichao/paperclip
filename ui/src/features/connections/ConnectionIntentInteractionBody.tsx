import { l10n } from "../../i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Plug,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { connectionIntentsApi } from "@/api/connection-intents";
import { AiConnectionCredentialStep } from "@/components/ai-connections/AiConnectionCredentialStep";
import { AI_PROVIDERS } from "@/components/ai-connections/model";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ConnectionSetupFlow,
  type ConnectionSetupCompletion,
  type ConnectionSetupFlowProps,
} from "./ConnectionSetupFlow";

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
  renderSetup?: (props: ConnectionSetupFlowProps) => ReactNode;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
  renderSetup,
}: ConnectionIntentInteractionBodyProps) {
  const [open, setOpen] = useState(false);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const setupGeneration = useRef(0);
  const generation = setupGeneration.current;
  const closeSetup = () => {
    setupGeneration.current += 1;
    setOpen(false);
  };
  const queryClient = useQueryClient();
  const isAddressee = Boolean(
    currentUserId && interaction.addresseeUserId === currentUserId,
  );
  const isPending = interaction.status === "pending";
  const isAi = interaction.payload.purpose === "ai";
  const focusTargetId = `connection-intent-focus-target-${interaction.id}`;

  const invalidateTask = async (
    updatedInteraction?: ConnectionIntentInteraction,
  ) => {
    if (updatedInteraction) {
      queryClient.setQueriesData<ConnectionIntentInteraction[]>(
        { queryKey: ["issues", "interactions"] },
        (current) =>
          current?.map((candidate) =>
            candidate.id === updatedInteraction.id
              ? updatedInteraction
              : candidate,
          ),
      );
    }
    await Promise.all([
      // Task routes may key these caches by either UUID or human identifier.
      // Prefix invalidation reaches the mounted task without requiring that
      // routing identity to leak into the reusable interaction card.
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] }),
    ]);
  };
  const returnFocusToCard = () => {
    // Completing an intent can move it from the composer takeover to the
    // durable timeline. That replaces this component instance, so its ref can
    // be cleared before focus restoration runs. Retry for a few paint frames
    // and resolve the stable interaction-specific target from the new host.
    const focusCurrentTarget = (remainingAttempts: number) => {
      window.requestAnimationFrame(() => {
        const target =
          document.getElementById(focusTargetId) ?? focusTargetRef.current;
        target?.focus();
        if (remainingAttempts > 1) {
          focusCurrentTarget(remainingAttempts - 1);
        }
      });
    };
    focusCurrentTarget(3);
  };

  const setupQuery = useQuery({
    queryKey: ["connection-intent", interaction.id, "setup-options"],
    queryFn: () => connectionIntentsApi.setupOptions(interaction.id),
    enabled: isAddressee && isPending,
    refetchInterval: isPending && (open || interaction.payload.phase === "authorizing") ? 2_000 : false,
  });

  useEffect(() => {
    const current = setupQuery.data?.interaction;
    if (current && current.status !== "pending" && isPending) {
      void invalidateTask(current);
      setOpen(false);
      returnFocusToCard();
    }
  }, [setupQuery.data?.interaction, isPending]);

  const completeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      connectionIntentsApi.complete(interaction.id, connectionId),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const declineMutation = useMutation({
    mutationFn: () => connectionIntentsApi.decline(interaction.id),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const phaseMutation = useMutation({
    mutationFn: (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      connectionIntentsApi.setPhase(interaction.id, phase),
    onSuccess: invalidateTask,
  });
  const mutatePhase = phaseMutation.mutate;
  const handlePhaseChange = useCallback(
    (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      mutatePhase(phase),
    [mutatePhase],
  );

  const finishNewConnection = async (completion: ConnectionSetupCompletion) => {
    // A completed credential save survives cancellation, but an abandoned form
    // must not accept the task request (even if a new form has since opened).
    if (isAi && generation !== setupGeneration.current) {
      await setupQuery.refetch();
      return;
    }
    if (completion.resolvedByCallback) {
      // A browser message cannot establish authorization. Read the durable result.
      const verified = await setupQuery.refetch();
      if (verified.data?.interaction.status !== "accepted") return;
      await invalidateTask(verified.data.interaction);
      setOpen(false);
      returnFocusToCard();
      return;
    }
    completeMutation.mutate(completion.connectionId);
  };

  const setupProps: ConnectionSetupFlowProps | null = setupQuery.data ? {
    host: "dialog",
    serviceSlug: interaction.payload.serviceSlug.startsWith("connection:") ? undefined : interaction.payload.serviceSlug,
    configuredConnection: interaction.payload.serviceSlug.startsWith("connection:") ? setupQuery.data.existingConnections[0] : undefined,
    requestedAgentId: setupQuery.data.requestedAgentId,
    aiConnection: setupQuery.data.aiConnection,
    interactionId: interaction.id,
    existingConnections: setupQuery.data.existingConnections,
    onUseExisting: async (connectionId) => { await completeMutation.mutateAsync(connectionId); },
    onComplete: (completion) => { void finishNewConnection(completion); },
    onOAuthDeclined: () => declineMutation.mutate(),
    onPhaseChange: handlePhaseChange,
    onCancel: () => { closeSetup(); returnFocusToCard(); },
  } : null;

  const resultOutcome = interaction.result?.outcome;
  const status =
    interaction.status === "accepted"
      ? {
          icon: CheckCircle2,
          title: l10n("local.value_connected_db4ed330", {v0: (interaction.payload.serviceName)}),
          body: isAi ? "This agent can now use the connection." : `${interaction.payload.requestingAgentName} can use this connection on the continuation run.`,
        }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: l10n("local.connection_declined_b17945c0"),
            body: isAi ? "The task still needs a working AI connection before it can run." : `${interaction.payload.requestingAgentName} was notified and can continue without it.`,
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? l10n("local.request_superseded_1f675939")
                  : l10n("local.connection_request_expired_cc0c7bc0"),
              body:
                resultOutcome === "superseded"
                  ? "This request was replaced. Use the latest connection card instead."
                  : "This request is no longer active.",
            }
          : null;
  const StatusIcon = status?.icon;

  if (status && StatusIcon) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-terminal"
        >
          <StatusIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">{status.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAddressee) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-waiting"
        >
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">
              {l10n("local.waiting_for_68a86b7b")}{" "}{addresseeLabel}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {l10n("local.only_the_addressed_person_can_choose_an_ident_5729ea8c")}</p>
          </div>
        </div>
      </div>
    );
  }

  const needsRetry = interaction.payload.phase === "needs_retry";
  const authorizing = interaction.payload.phase === "authorizing";

  const repair = setupQuery.data?.aiRepair;
  const selectedReady = repair && setupQuery.data?.existingConnections.some((connection) => connection.id === repair.connection.id);
  const setupContent = setupQuery.isLoading ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {l10n("local.loading_connection_options_f7bb47b5")}</div>
              ) : setupQuery.isError ? (
                <div className="py-8 text-center">
                  <p className="font-medium text-foreground">
                    {l10n("local.couldn_t_load_connection_setup_a1ed99c5")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {setupQuery.error instanceof Error
                      ? setupQuery.error.message
                      : l10n("local.try_again_a0c2cc13")}
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => setupQuery.refetch()}
                  >
                    {l10n("local.try_again_d8b8392e")}</Button>
                </div>
              ) : setupProps ? (
                renderSetup ? renderSetup(setupProps) : <ConnectionSetupFlow {...setupProps} />
              ) : null;
  const inlineContent = setupQuery.isLoading || setupQuery.isError ? setupContent
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{repair.connection.name} {l10n("local.is_ready_17f55818")}</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? l10n("local.continuing_207f6cb5") : l10n("local.continue_task_17255aac")}
        </Button>
      </div>
    : repair ? repair.canReconnect ? <AiConnectionCredentialStep
        companyId={interaction.companyId}
        provider={repair.connection.provider}
        initialMethod={repair.connection.method}
        fixedMethod
        connectionId={repair.connection.id}
        name={repair.connection.name}
        ownership={repair.connection.ownership}
        agentIds={[interaction.payload.requestingAgentId]}
        allAgents={false}
        onComplete={(result) => { void finishNewConnection(result); }}
        onCancel={() => { closeSetup(); returnFocusToCard(); }}
      /> : <p role="status" className="text-sm text-muted-foreground">
        {repair.connection.ownership === "personal" ? l10n("local.value_must_reconnect_value_9928410c", {v0: (repair.connection.ownerName ?? "The account owner"), v1: (repair.connection.name)}) : l10n("local.the_account_owner_must_reconnect_value_f2ebe0e1", {v0: (repair.connection.name)})}
        {" "}{l10n("local.you_can_continue_here_once_it_is_restored_0eacf5ca")}</p>
    : setupQuery.data?.aiConnection && setupQuery.data.aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">{l10n("local.the_selected_account_is_no_longer_available_t_fbec3492")}</p>
      : setupQuery.data?.aiConnection ? <AiConnectionCredentialStep
          companyId={interaction.companyId}
          provider={setupQuery.data.aiConnection.provider}
          name={`My ${AI_PROVIDERS[setupQuery.data.aiConnection.provider].name} account`}
          ownership="personal"
          agentIds={[interaction.payload.requestingAgentId]}
          allAgents={false}
          onComplete={(result) => { void finishNewConnection(result); }}
          onCancel={() => { closeSetup(); returnFocusToCard(); }}
        /> : setupContent;

  return (
    <div
      id={focusTargetId}
      ref={focusTargetRef}
      tabIndex={-1}
      data-testid="connection-intent-focus-target"
    >
      <div data-testid="connection-intent-actions">
        <div className="flex items-start gap-3">
          <AppLogo
            name={interaction.payload.serviceName}
            logoUrl={interaction.payload.serviceLogoUrl}
            darkLogoUrl={interaction.payload.serviceDarkLogoUrl}
            size={40}
          />
          <div>
            <p className="font-medium text-foreground">
              {isAi ? l10n("local.ai_connection_needs_attention_ded5bf09") : l10n("local.value_needs_value_c33ca828", {v0: (interaction.payload.requestingAgentName), v1: (interaction.payload.serviceName)})}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {interaction.payload.purpose === "ai"
                ? l10n("local.this_task_can_t_run_until_the_agent_has_a_val_fe44fc10")
                : l10n("local.connect_your_identity_or_reuse_an_eligible_co_ce8bf347")}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />
            {l10n("local.authorization_didn_t_finish_your_previous_cho_acbb9df7")}</p>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {!isAi && <Button
            type="button"
            variant="ghost"
            disabled={declineMutation.isPending || completeMutation.isPending || authorizing}
            onClick={() => declineMutation.mutate()}
          >
            {l10n("local.not_now_a0e63d7c")}</Button>}
          {isAi ? <Button type="button" disabled={completeMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
            <Plug className="h-4 w-4" />{open ? l10n("local.close_setup_ef0e47fa") : l10n("local.fix_connection_5855b3ac")}
          </Button> : <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button">
                {authorizing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {authorizing
                  ? l10n("local.continue_setup_c5702c19")
                  : needsRetry
                    ? l10n("local.try_again_d8b8392e")
                    : setupQuery.data?.existingConnections.length ? l10n("local.connect_use_existing_77cbdecd") : l10n("local.connect_1a2303ed")}
              </Button>
            </DialogTrigger>
            <DialogContent
              className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-3xl"
              showCloseButton={false}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                focusTargetRef.current?.focus();
              }}
            >
              <DialogHeader className="sr-only">
                <DialogTitle>
                  {l10n("local.connect_1a2303ed")}{" "}{interaction.payload.serviceName}
                </DialogTitle>
                <DialogDescription>
                  {l10n("local.complete_connection_setup_without_leaving_thi_759ccded")}</DialogDescription>
              </DialogHeader>
              {setupContent}
            </DialogContent>
          </Dialog>}
        </div>
        {isAi && open ? <div className="mt-4 border-t border-border pt-4" data-testid="ai-connection-inline-repair">{inlineContent}</div> : null}

        {completeMutation.isError ||
        declineMutation.isError ||
        phaseMutation.isError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {(completeMutation.error ??
              declineMutation.error ??
              phaseMutation.error) instanceof Error
              ? (
                  completeMutation.error ??
                  declineMutation.error ??
                  phaseMutation.error
                )?.message
              : l10n("local.couldn_t_update_this_connection_request_1a99d1bb")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
