import { l10n } from "../i18n";
import { useState } from "react";
import type { Agent } from "@paperclipai/shared";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";

export interface AgentChatPickerProps {
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (agent: Agent) => void;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}

export function AgentChatPicker({ open, onOpenChange, ...props }: AgentChatPickerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="px-4 pt-4 pb-3">
          <DialogTitle>{l10n("local.chat_with_an_agent_73adffe3")}</DialogTitle>
        </div>
        {/* The dialog unmounts its content on close, so each search starts empty. */}
        <AgentChatPickerResults {...props} onSelect={(agent) => {
          onOpenChange(false);
          props.onSelect(agent);
        }} />
      </DialogContent>
    </Dialog>
  );
}

function AgentChatPickerResults({ agents, onSelect, loading, error, onRetry }: Omit<AgentChatPickerProps, "open" | "onOpenChange">) {
  const [search, setSearch] = useState("");
  return (
    <Command>
      <CommandInput
        aria-label={l10n("local.search_agents_by_name_or_role_e5d13d38")}
        placeholder={l10n("local.search_by_name_or_role_ada75765")}
        value={search}
        onValueChange={setSearch}
      />
      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
          <p>{l10n("local.couldn_t_load_agents_try_again_3ca8c851")}</p>
          {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>{l10n("local.retry_942087cc")}</Button>}
        </div>
      ) : loading ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">{l10n("local.loading_agents_ae0c1414")}</p>
      ) : (
        <CommandList>
          <CommandEmpty>
            <div className="flex flex-col items-center gap-2 px-4">
              <span>{agents.length ? l10n("local.no_agents_match_value_180fe87b", {v0: (search)}) : l10n("local.no_agents_yet_8a33b2e7")}</span>
              {agents.length ? <>
                <span className="text-xs text-muted-foreground">{l10n("local.try_another_name_or_role_ec1f4d9d")}</span>
                <Button variant="ghost" size="sm" onClick={() => setSearch("")}>{l10n("local.clear_search_3b7ea517")}</Button>
              </> : <span className="text-xs text-muted-foreground">{l10n("local.create_an_agent_from_the_agents_page_to_start_8f52c095")}</span>}
            </div>
          </CommandEmpty>
          <CommandGroup>
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={agent.id}
                keywords={[agent.name, agent.title ?? "", agent.role]}
                onSelect={() => onSelect(agent)}
                className="gap-3 px-3 py-3"
              >
                <AgentIcon icon={agent.icon} className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{agent.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{agent.title ?? agent.role}</span>
                </span>
                {agent.status === "paused" && <span className="text-xs text-(--status-agent-paused)">{l10n("local.paused_e159b061")}</span>}
                {agent.status === "terminated" && <span className="text-xs text-muted-foreground">{l10n("local.terminated_56a88f4f")}</span>}
                {agent.status === "pending_approval" && <span className="text-xs text-muted-foreground">{l10n("local.awaiting_approval_ae25c9b1")}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      )}
    </Command>
  );
}
