import { l10n } from "../i18n";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpCircle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";

/* ---- Help text for (?) tooltips ---- */
export const help: Record<string, string> = {
  name: l10n("local.display_name_for_this_agent_6bbe791c"),
  title: l10n("local.job_title_shown_in_the_org_chart_22769e97"),
  role: l10n("local.organizational_role_determines_position_and_c_0300a003"),
  reportsTo: l10n("local.the_agent_this_one_reports_to_in_the_org_hier_0e5a93fe"),
  capabilities: l10n("local.describes_what_this_agent_can_do_shown_in_the_eae8c70d"),
  adapterType: l10n("local.how_this_agent_runs_local_cli_claude_codex_op_eb2cf5b9"),
  cwd: l10n("local.deprecated_legacy_working_directory_fallback_fceb82f8"),
  promptTemplate: l10n("local.sent_on_every_heartbeat_keep_this_small_and_d_5f0fb60c"),
  model: l10n("local.override_the_default_model_used_by_the_adapte_da7e1501"),
  thinkingEffort: l10n("local.control_model_reasoning_depth_supported_value_ead6045b"),
  chrome: l10n("local.enable_claude_s_chrome_integration_by_passing_fca18a33"),
  dangerouslySkipPermissions: l10n("local.run_unattended_by_auto_approving_adapter_perm_bf4d9539"),
  dangerouslyBypassSandbox: l10n("local.run_codex_without_sandbox_restrictions_requir_3c9aee19"),
  search: l10n("local.enable_codex_web_search_capability_during_run_6bfbb11c"),
  fastMode: l10n("local.enable_codex_fast_mode_this_burns_credits_tok_ba706d7b"),
  workspaceStrategy: l10n("local.how_paperclip_should_realize_an_execution_wor_7e77073d"),
  workspaceBaseRef: l10n("local.base_git_ref_used_when_creating_a_worktree_br_b93b16da"),
  workspaceBranchTemplate: l10n("local.template_for_naming_derived_branches_supports_1f6eee6b"),
  worktreeParentDir: l10n("local.directory_where_derived_worktrees_should_be_c_14855553"),
  runtimeServicesJson: l10n("local.optional_workspace_runtime_service_definition_b9f8336c"),
  maxTurnsPerRun: l10n("local.maximum_number_of_agentic_turns_tool_calls_pe_20755408"),
  command: l10n("local.the_command_to_execute_e_g_node_python_755a5e6f"),
  localCommand: l10n("local.override_the_path_to_the_cli_command_you_want_8962c0be"),
  args: l10n("local.command_line_arguments_comma_separated_e45feffd"),
  extraArgs: l10n("local.extra_cli_arguments_for_local_adapters_comma_2ead66f7"),
  envVars: l10n("local.environment_variables_injected_into_the_adapt_22a4fe99"),
  secretAccess:
    l10n("local.secrets_this_agent_can_reach_env_var_bindings_85da3810"),
  bootstrapPrompt: l10n("local.only_sent_when_paperclip_starts_a_fresh_sessi_30828fb4"),
  payloadTemplateJson: l10n("local.optional_json_merged_into_remote_adapter_requ_bbb83eae"),
  webhookUrl: l10n("local.the_url_that_receives_post_requests_when_the_f89f4cbe"),
  heartbeatInterval: l10n("local.run_this_agent_automatically_on_a_timer_usefu_e5b62112"),
  intervalSec: l10n("local.seconds_between_automatic_heartbeat_invocatio_8b90a2ea"),
  timeoutSec: l10n("local.maximum_seconds_a_run_can_take_before_being_t_878afd06"),
  graceSec: l10n("local.seconds_to_wait_after_sending_interrupt_befor_96d542ca"),
  wakeOnDemand: l10n("local.allow_this_agent_to_be_woken_by_assignments_a_5d7951c2"),
  cooldownSec: l10n("local.minimum_seconds_between_consecutive_heartbeat_200ac57f"),
  maxConcurrentRuns: l10n("local.maximum_number_of_heartbeat_runs_that_can_exe_51059422"),
  maxTurnContinuationEnabled: l10n("local.automatically_queue_bounded_continuation_runs_02cafc21"),
  maxTurnContinuationMaxAttempts: l10n("local.maximum_automatic_continuations_after_one_max_190d072e"),
  maxTurnContinuationDelaySec: l10n("local.seconds_to_wait_before_starting_each_max_turn_460c3692"),
  budgetMonthlyCents: l10n("local.monthly_spending_limit_in_cents_0_means_no_li_a62d24f2"),
};

import { getAdapterLabels } from "../adapters/adapter-display-registry";

export const adapterLabels = getAdapterLabels();

export const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/* ---- Primitive components ---- */

export function HintIcon({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex text-muted-foreground/50 hover:text-muted-foreground transition-colors">
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode; configSection?: import("../adapters/types").AdapterConfigSection }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      {children}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  toggleTestId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  toggleTestId?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {hint && <HintIcon text={hint} />}
      </div>
      {/* Gallery feedback r3: was a hand-rolled h-5 w-9 pill with a bg-green-600
          track — the app's second switch implementation. Converged on the one
          canonical ToggleSwitch (status-green on-state), DESIGN.md principle 1. */}
      <ToggleSwitch
        data-testid={toggleTestId}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

export function ToggleWithNumber({
  label,
  hint,
  checked,
  onCheckedChange,
  number,
  onNumberChange,
  numberLabel,
  numberHint,
  numberPrefix,
  showNumber,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  number: number;
  onNumberChange: (v: number) => void;
  numberLabel: string;
  numberHint?: string;
  numberPrefix?: string;
  showNumber: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          {hint && <HintIcon text={hint} />}
        </div>
        <ToggleSwitch
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
      {showNumber && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {numberPrefix && <span>{numberPrefix}</span>}
          <input
            type="number"
            className="w-16 rounded-md border border-border px-2 py-0.5 bg-transparent outline-none text-xs font-mono text-center"
            value={number}
            onChange={(e) => onNumberChange(Number(e.target.value))}
          />
          <span>{numberLabel}</span>
          {numberHint && <HintIcon text={numberHint} />}
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({
  title,
  icon,
  open,
  onToggle,
  bordered,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(bordered && "border-t border-border")}>
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-2 w-full px-4 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/30 transition-colors"
        onClick={onToggle}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {icon}
        {title}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

export function AutoExpandTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minRows,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minRows?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [value, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      style={{ minHeight }}
    />
  );
}

/**
 * Text input that manages internal draft state.
 * Calls `onCommit` on blur (and optionally on every change if `immediate` is set).
 */
export function DraftInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      {...props}
    />
  );
}

/**
 * Auto-expanding textarea with draft state and blur-commit.
 */
export function DraftTextarea({
  value,
  onCommit,
  immediate,
  placeholder,
  minRows,
}: {
  value: string;
  onCommit: (v: string) => void;
  immediate?: boolean;
  placeholder?: string;
  minRows?: number;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => { adjustHeight(); }, [draft, adjustHeight]);

  return (
    <textarea
      ref={textareaRef}
      className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 resize-none overflow-hidden"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(e.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ minHeight }}
    />
  );
}

/**
 * Number input with draft state and blur-commit.
 */
export function DraftNumberInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: {
  value: number;
  onCommit: (v: number) => void;
  immediate?: boolean;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className" | "type">) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <input
      type="number"
      className={className}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (immediate) onCommit(Number(e.target.value) || 0);
      }}
      onBlur={() => {
        const num = Number(draft) || 0;
        if (num !== value) onCommit(num);
      }}
      {...props}
    />
  );
}

/**
 * "Choose" button that opens a dialog explaining the user must manually
 * type the path due to browser security limitations.
 */
export function ChoosePathButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
        onClick={() => setOpen(true)}
      >
        {l10n("local.choose_c7f93783")}</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.specify_path_manually_b1b6afc2")}</DialogTitle>
            <DialogDescription>
              {l10n("local.browser_security_blocks_apps_from_reading_ful_aa16b49c")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <section className="space-y-1.5">
              <p className="font-medium">{l10n("local.macos_finder_ef6013bd")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{l10n("local.find_the_folder_in_finder_3aa7d055")}</li>
                <li>{l10n("local.hold_8e685d54")}{" "}<kbd>{l10n("local.option_45aaacba")}</kbd> {l10n("local.and_right_click_the_folder_28a4a8f3")}</li>
                <li>{l10n("local.click_copy_lt_folder_name_gt_as_pathname_3e0c3bc9")}</li>
                <li>{l10n("local.paste_the_result_into_the_path_input_658a102f")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                /Users/yourname/Documents/project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{l10n("local.windows_file_explorer_4749e06b")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{l10n("local.find_the_folder_in_file_explorer_2301a201")}</li>
                <li>{l10n("local.hold_8e685d54")}{" "}<kbd>Shift</kbd> {l10n("local.and_right_click_the_folder_28a4a8f3")}</li>
                <li>{l10n("local.click_copy_as_path_9f260348")}</li>
                <li>{l10n("local.paste_the_result_into_the_path_input_658a102f")}</li>
              </ol>
              <p className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
                C:\Users\yourname\Documents\project
              </p>
            </section>
            <section className="space-y-1.5">
              <p className="font-medium">{l10n("local.terminal_fallback_macos_linux_e1983af8")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>{l10n("local.run_00d60e31")}{" "}<code>cd /path/to/folder</code>.</li>
                <li>{l10n("local.run_00d60e31")}{" "}<code>pwd</code>.</li>
                <li>{l10n("local.copy_the_output_and_paste_it_into_the_path_in_71bb95f3")}</li>
              </ol>
            </section>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {l10n("local.ok_565339bc")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Label + input rendered on the same line (inline layout for compact fields).
 */
export function InlineField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 shrink-0">
        <label className="text-xs text-muted-foreground">{label}</label>
        {hint && <HintIcon text={hint} />}
      </div>
      <div className="w-24 ml-auto">{children}</div>
    </div>
  );
}
