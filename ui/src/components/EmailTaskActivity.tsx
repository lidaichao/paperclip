import { l10n } from "../i18n";
import { EmailMessageCard } from "./EmailMessageCard";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { EmailPublicationSummary } from "@paperclipai/shared";

// Email actions belong to the agent's task conversation. Only surface mail
// without a task comment yet and delivery outcomes that need attention here.
export function EmailTaskActivity({
  companyId,
  issueId,
}: {
  companyId: string;
  issueId: string;
}) {
  const cache = useQueryClient();
  const threadKey = ["email-thread", companyId, issueId];
  const queryEnabled = Boolean(companyId && issueId) && !issueId.startsWith("chat:");
  const thread = useQuery({
    queryKey: threadKey,
    queryFn: () => emailApi.thread(companyId, issueId),
    enabled: queryEnabled,
    refetchInterval: 3000,
  });
  if (!queryEnabled) return null;
  const data = thread.data;
  const messages = data?.messages.filter((m) => !m.commentId) ?? [];
  const publications = data?.publications.filter(
    (p) => !p.providerMessageId || p.outcome === "uncertain",
  ) ?? [];
  if (!thread.error && !messages.length && !publications.length) return null;
  return (
    <div className="space-y-3">
      {thread.error && (
        <p role="alert" className="text-sm text-destructive">
          {thread.error.message}
        </p>
      )}
      {messages.map((m) => (
        <EmailMessageCard
          key={m.id}
          issueId={issueId}
          message={m}
          publication={data?.publications.find(
            (p) => p.providerMessageId === m.providerMessageId,
          )}
        />
      ))}
      {publications.map((p) => (
        <EmailDelivery
          key={p.id}
          companyId={companyId}
          publication={p}
          onResolved={() => {
            void cache.invalidateQueries({ queryKey: threadKey });
          }}
        />
      ))}
    </div>
  );
}

function EmailDelivery({
  companyId,
  publication: p,
  onResolved,
}: {
  companyId: string;
  publication: EmailPublicationSummary;
  onResolved: () => void;
}) {
  const [messageId, setMessageId] = useState("");
  const resolve = useMutation({
    mutationFn: (outcome: "sent" | "failed") =>
      emailApi.resolve(companyId, p.id, outcome, messageId || undefined),
    onSuccess: onResolved,
  });
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {p.request && !p.providerMessageId && (
        <article
          aria-label={l10n("local.email_send_intent_5cd55844")}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <p className="font-semibold">{p.request.subject ?? l10n("local.email_reply_ef902e38")}</p>
          {p.request.to && <p>{l10n("local.to_2b5fc5c9")}{" "}{p.request.to.join(", ")}</p>}
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {p.request.text}
          </div>
        </article>
      )}
      <p>
        {l10n("local.email_969ccbd3")}{" "}{p.outcome}
        {p.error ? ` — ${p.error}` : ""}
      </p>
      {p.outcome === "uncertain" && (
        <details>
          <summary className="cursor-pointer">
            {l10n("local.resolve_delivery_after_checking_agentmail_45731872")}</summary>
          <div className="space-y-2 py-2">
            <p>
              {l10n("local.confirm_the_outcome_in_agentmail_before_resol_0e870401")}</p>
            <Input
              aria-label={l10n("local.provider_message_id_c250cfdf")}
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              placeholder={l10n("local.provider_message_id_c250cfdf")}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!messageId || resolve.isPending}
                onClick={() => resolve.mutate("sent")}
              >
                {l10n("local.confirm_sent_a1913b58")}</Button>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate("failed")}
              >
                {l10n("local.confirm_not_sent_e948b4c3")}</Button>
            </div>
            {resolve.error && (
              <p role="alert" className="text-destructive">
                {resolve.error.message}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
