import { l10n } from "../../i18n";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  Check,
  CheckCircle2,
  AlertCircle,
  Globe,
  GitBranch,
  Radio,
  Webhook,
} from "lucide-react";
import {
  SetupWizardNavigation,
  SetupWizardFooter,
} from "@/components/SetupWizard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { cn } from "@/lib/utils";
import { AgentInstructions, CopyField } from "./WebhookFields";
import { WebhookUrlWarning } from "./WebhookUrlWarning";

export type TriggerDraft = {
  kind: "choose" | "schedule" | "webhook";
  step: number;
  availableStep: number;
  sender: "custom" | "github";
  /** Retained when resuming webhooks created before generic signed-app support. */
  signingMode?: "bearer" | "app_webhook" | "fireflies_hmac";
  frequency: string;
  time: string;
  weekday: string;
  timezone: string;
  created: boolean;
};
export const defaultTriggerDraft: TriggerDraft = {
  kind: "choose",
  step: 0,
  availableStep: 0,
  sender: "custom",
  frequency: "weekdays",
  time: "09:00",
  weekday: "Monday",
  timezone: "America/Chicago",
  created: false,
};
export function webhookAgentInstructions(
  sender: TriggerDraft["sender"],
  routineTitle: string,
  webhookUrl: string,
  webhookSecret: string,
  setupPending = true,
  signingMode: TriggerDraft["signingMode"] = "app_webhook",
) {
  const common = [
    `Connect the sending app to the Paperclip routine ${JSON.stringify(routineTitle)}.`,
    `Webhook URL: ${webhookUrl}`,
    "Send an HTTP POST request with a JSON object as the body (not an array or string).",
    "Content-Type: application/json",
  ];
  const auth =
    sender === "github"
      ? [
          "In GitHub, open your repository → Settings → Webhooks → Add webhook.",
          "Use the webhook URL above as Payload URL and select application/json as Content type.",
          `Secret: ${webhookSecret}`,
          "Paste this value into GitHub’s Secret field. GitHub signs requests with X-Hub-Signature-256; do not use Bearer authentication.",
          "Select the events that should start this routine, enable the webhook, and save.",
          "To check the connection, open Recent Deliveries and redeliver an event.",
        ]
      : [
          `Secret key: ${webhookSecret}`,
          ...(signingMode === "bearer" ? [] : [
            `If the app asks for a signing secret, paste the secret key above. Paperclip accepts HMAC-SHA256 over the exact request body in ${signingMode === "fireflies_hmac" ? "X-Hub-Signature" : "X-Hub-Signature or X-Hub-Signature-256"}, formatted sha256=<hex digest>.`,
          ]),
          ...(signingMode === "fireflies_hmac" ? [] : [
            `For apps with custom headers, use Authorization: Bearer ${webhookSecret}`,
          ]),
          "Subscribe only to the events that should start this routine. Public services need a publicly reachable HTTPS URL.",
          "In the sending app, add a webhook using this URL, POST method, JSON body, and headers, then save it.",
          "Send a unique Idempotency-Key header for each event and reuse it on retries, so retrying a setup test after activation cannot start the routine.",
          'Example JSON body: {"event":"deployment.completed","environment":"production"}',
          "To check the connection, send a test event from the app or perform the action that triggers a delivery.",
        ];
  return [
    ...common,
    ...auth,
    "Open Check connection in Paperclip to see whether the event arrived and authentication passed.",
    ...(setupPending
      ? [
          "During setup, deliveries only test the connection. They do not start the routine or create a task.",
          "Finish setup in Paperclip to enable this webhook for future events. Test events are not replayed.",
        ]
      : [
          "This webhook is enabled. Deliveries can start the routine and create tasks.",
        ]),
    "Store the key securely; do not put it in source control or logs.",
  ].join("\n");
}
export function describeSchedule(draft: TriggerDraft) {
  return `${draft.frequency === "daily" ? "Every day" : draft.frequency === "weekly" ? `Every ${draft.weekday}` : "Every weekday"} at ${draft.time}`;
}
export function RoutineTriggerWizard({
  initialDraft,
  onSaveExit,
  onFinish,
  onCreateWebhook,
  onRotateKey,
  routineTitle,
  routineId,
  routineActive = true,
  webhookUrl = "",
  webhookSecret = "",
  checkResult = "waiting",
}: {
  initialDraft: TriggerDraft;
  routineTitle: string;
  routineId: string;
  routineActive?: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  onCreateWebhook?: (draft: TriggerDraft) => Promise<void>;
  onRotateKey?: () => Promise<void>;
  onSaveExit: (draft: TriggerDraft) => void | Promise<void>;
  onFinish: (draft: TriggerDraft) => void | Promise<void>;
  checkResult?: "waiting" | "received" | "rejected" | "no_event";
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const { setBreadcrumbs } = useBreadcrumbs();
  const perform = useCallback(
    async (action: () => void | Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setSaveError("");
      try {
        await action();
      } catch (error) {
        setSaveError(
          error instanceof Error
            ? error.message
            : "Couldn’t save. Please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );
  const saveAndExit = useCallback(() => {
    void perform(() => onSaveExit(draft));
  }, [draft, onSaveExit, perform]);
  useEffect(() => {
    setBreadcrumbs([
      {
        label: routineTitle,
        href: `/routines/${routineId}/triggers`,
        onClick: (event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          saveAndExit();
        },
      },
      { label: l10n("local.add_trigger_58fd3089") },
    ]);
  }, [saveAndExit, setBreadcrumbs, routineTitle, routineId]);
  const schedule = draft.kind === "schedule";
  const github = draft.sender === "github";
  const labels = schedule
    ? ["Choose trigger", "Set schedule", "Review schedule"]
    : ["Choose trigger", "Connect your app", "Check connection"];
  function patch(values: Partial<TriggerDraft>) {
    setDraft((current) => ({ ...current, ...values }));
  }
  function advance() {
    void perform(async () => {
      if (draft.kind === "webhook" && draft.step === 0 && !draft.created)
        await onCreateWebhook?.(draft);
      const step = draft.step + 1;
      patch({
        step,
        availableStep: Math.max(draft.availableStep, step),
        created:
          draft.created || (draft.kind === "webhook" && draft.step === 0),
      });
    });
  }
  const title =
    draft.step === 0
      ? l10n("local.when_should_this_routine_run_7725656f")
      : schedule
        ? draft.step === 1
          ? l10n("local.set_a_schedule_b967d9c5")
          : l10n("local.review_your_schedule_6204c309")
        : draft.step === 1
          ? l10n("local.connect_value_2a49bf94", {v0: (github ? "GitHub" : "your app")})
          : l10n("local.check_your_connection_c2886bc3");
  const subtitle =
    draft.step === 0
      ? l10n("local.choose_how_to_start_value_you_can_add_another_a5daff11", {v0: (routineTitle)})
      : schedule
        ? draft.step === 1
          ? l10n("local.choose_when_paperclip_should_start_this_routi_3cca3d7f")
          : l10n("local.this_schedule_starts_the_routine_automaticall_b549efc6")
        : draft.step === 1
          ? l10n("local.copy_these_details_into_the_sending_app_then_7eaa5d90")
          : l10n("local.test_that_events_arrive_and_authentication_wo_57926d6a");
  const selectClass =
    "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
  const goBack = (
    <Button variant="outline" onClick={() => patch({ step: draft.step - 1 })}>
      {l10n("local.back_76900f1b")}</Button>
  );
  return (
    <div className="min-w-0 w-full max-w-2xl space-y-6">
      <SetupWizardNavigation
        takeover
        disabled={busy}
        ariaLabel={l10n("local.trigger_setup_progress_0e99f6bb")}
        labels={labels}
        step={draft.step}
        availableStep={draft.availableStep}
        onSelect={(step) => patch({ step })}
      />
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {!schedule && draft.step > 0 && <WebhookUrlWarning url={webhookUrl} />}
        {draft.step === 0 && (
          <fieldset className="space-y-3">
            <legend className="sr-only">{l10n("local.trigger_type_31a9d2bd")}</legend>
            {(
              [
                {
                  kind: "schedule",
                  label: l10n("local.on_a_schedule_8c4f3450"),
                  detail: "Every day, on weekdays, or once a week.",
                  Icon: CalendarClock,
                },
                {
                  kind: "webhook",
                  label: l10n("local.when_another_app_sends_a_webhook_d7f97da1"),
                  detail:
                    "When something happens in GitHub, another app, or a script.",
                  Icon: Webhook,
                },
              ] as const
            ).map(({ kind, label, detail, Icon }) => (
              <label
                key={kind}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border p-4 focus-within:ring-2 focus-within:ring-ring",
                  draft.kind === kind
                    ? "border-primary bg-accent/30"
                    : "border-border hover:bg-accent/20",
                )}
              >
                <input
                  type="radio"
                  name="trigger-kind"
                  checked={draft.kind === kind}
                  disabled={draft.created && kind !== draft.kind}
                  onChange={() =>
                    patch({
                      kind,
                      availableStep:
                        kind === draft.kind ? draft.availableStep : 0,
                    })
                  }
                  className="sr-only"
                />
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {detail}
                  </span>
                </span>
                {draft.kind === kind && <Check className="h-4 w-4" />}
              </label>
            ))}
          </fieldset>
        )}
        {schedule && draft.step === 1 && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="repeat">{l10n("local.repeat_b6b7a006")}</Label>
                <select
                  id="repeat"
                  className={selectClass}
                  value={draft.frequency}
                  onChange={(event) => patch({ frequency: event.target.value })}
                >
                  <option value="daily">{l10n("local.every_day_c4e42b97")}</option>
                  <option value="weekdays">{l10n("local.weekdays_monday_friday_0ea2df5f")}</option>
                  <option value="weekly">{l10n("local.every_week_1b7e1851")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="run-time">{l10n("local.time_33b93476")}</Label>
                <Input
                  id="run-time"
                  type="time"
                  value={draft.time}
                  onChange={(event) => patch({ time: event.target.value })}
                />
              </div>
            </div>
            {draft.frequency === "weekly" && (
              <div className="space-y-2">
                <Label htmlFor="run-day">{l10n("local.day_8f2364e1")}</Label>
                <select
                  id="run-day"
                  className={selectClass}
                  value={draft.weekday}
                  onChange={(event) => patch({ weekday: event.target.value })}
                >
                  {[
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                    "Sunday",
                  ].map((day) => (
                    <option key={day}>{day}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="timezone">{l10n("local.time_zone_b9fe1464")}</Label>
              <select
                id="timezone"
                className={selectClass}
                value={draft.timezone}
                onChange={(event) => patch({ timezone: event.target.value })}
              >
                {Array.from(
                  new Set([
                    draft.timezone,
                    "America/Chicago",
                    "America/New_York",
                    "America/Los_Angeles",
                    "Europe/London",
                    "UTC",
                  ]),
                ).map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {l10n("local.the_time_follows_this_zone_including_daylight_ea2bf434")}</p>
            </div>
          </div>
        )}
        {schedule && draft.step === 2 && (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-md bg-muted/40 p-4">
              <CalendarClock className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{describeSchedule(draft)}</p>
                <p className="text-xs text-muted-foreground">
                  {draft.timezone}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {l10n("local.each_scheduled_run_creates_a_task_for_the_rou_ee4ebabb")}</p>
          </div>
        )}
        {draft.step === 0 && draft.kind === "webhook" && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              {l10n("local.what_s_sending_the_webhook_850bfd5b")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    sender: "custom",
                    label: l10n("local.another_app_or_script_33687214"),
                    Icon: Globe,
                  },
                  { sender: "github", label: l10n("local.github_f911e414"), Icon: GitBranch },
                ] as const
              ).map(({ sender, label, Icon }) => (
                <label
                  key={sender}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border p-3 focus-within:ring-2 focus-within:ring-ring",
                    draft.sender === sender
                      ? "border-primary bg-accent/30"
                      : "border-border",
                    draft.created && "cursor-default",
                  )}
                >
                  <input
                    className="sr-only"
                    type="radio"
                    name="sender"
                    checked={draft.sender === sender}
                    disabled={draft.created}
                    onChange={() => patch({ sender })}
                  />
                  <Icon className="h-4 w-4" />
                  <span className="flex-1 text-sm">{label}</span>
                  {draft.sender === sender && <Check className="h-4 w-4" />}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {draft.kind === "webhook" && draft.step === 0 && (
          <p className="text-sm text-muted-foreground">
            {l10n("local.public_services_need_a_publicly_reachable_htt_090e88c6")}</p>
        )}
        {!schedule && draft.step === 1 && (
          <div className="space-y-5">
            {webhookSecret && (
              <AgentInstructions
                value={webhookAgentInstructions(
                  draft.sender,
                  routineTitle,
                  webhookUrl,
                  webhookSecret,
                  true,
                  draft.signingMode,
                )}
              />
            )}
            <CopyField
              label={github ? l10n("local.payload_url_1de5cdcf") : l10n("local.webhook_url_84805a75")}
              value={webhookUrl}
            />
            {!github && draft.signingMode !== "bearer" && (
              <p className="text-sm text-muted-foreground">
                {l10n("local.paste_this_key_into_your_app_s_signing_secret_3dd90f15")}{draft.signingMode !== "fireflies_hmac" && <>
                  {" "}{l10n("local.if_your_app_uses_custom_headers_instead_set_a_4d7327f2")}</>}
              </p>
            )}
            {webhookSecret ? (
              <CopyField
                label={github ? l10n("local.secret_7e32a729") : draft.signingMode === "bearer" ? l10n("local.authorization_header_value_39a91b3d") : l10n("local.secret_key_f47a99eb")}
                value={!github && draft.signingMode === "bearer" ? `Bearer ${webhookSecret}` : webhookSecret}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {l10n("local.the_key_is_hidden_after_leaving_setup_if_you_8e6e20d1")}</p>
                <Button
                  variant="outline"
                  onClick={() => void perform(() => onRotateKey?.())}
                >
                  {l10n("local.generate_new_key_3a14b7bb")}</Button>
              </div>
            )}
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <div className="space-y-5">
            <div className="space-y-1 rounded-md border border-border p-4">
              <p className="text-sm font-medium">{l10n("local.connection_test_only_fd7045f1")}</p>
              <p className="text-sm text-muted-foreground">
                {l10n("local.events_received_during_setup_won_t_start_the_ca8e4cd4")}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {l10n("local.send_an_event_from_af0f9889")}{" "}{github ? l10n("local.github_f911e414") : l10n("local.your_app_4696a335")}
              </p>
              <p className="text-sm text-muted-foreground">
                {github
                  ? l10n("local.open_this_webhook_in_your_repository_settings_e2c845a5")
                  : l10n("local.look_for_send_test_in_your_app_s_webhook_sett_643e56b8")}
              </p>
              <p className="text-xs text-muted-foreground">
                {l10n("local.keep_this_page_open_to_see_the_test_result_f5c74154")}</p>
            </div>
            <div
              role="status"
              className="flex items-start gap-3 rounded-md bg-muted/40 p-4"
            >
              {checkResult === "received" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-(--status-task-done)" />
              ) : checkResult === "rejected" ? (
                <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
              ) : (
                <Radio className="h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {checkResult === "received"
                    ? l10n("local.test_event_received_connection_working_b57a6eee")
                    : checkResult === "rejected"
                      ? l10n("local.event_arrived_but_the_key_was_rejected_8ac7b7ed")
                      : checkResult === "no_event"
                        ? l10n("local.no_event_received_yet_4d6fd6a8")
                        : l10n("local.waiting_for_an_event_from_your_app_6da2e8bc")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {checkResult === "received"
                    ? l10n("local.authentication_passed_no_routine_run_or_task_407050a5")
                    : checkResult === "rejected"
                      ? l10n("local.go_back_to_connect_your_app_update_the_key_in_d5b974d7")
                      : l10n("local.waiting_to_verify_delivery_and_authentication_f29bb26e")}
                </p>
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {l10n("local.troubleshoot_delivery_f854de03")}</summary>
              <div className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">
                  {l10n("local.check_that_the_webhook_is_enabled_in_your_sen_a4e5ad3d")}</p>
                <CopyField label={l10n("local.webhook_url_84805a75")} value={webhookUrl} />
              </div>
            </details>
          </div>
        )}
        {!schedule && draft.step === 2 && (
          <p className="text-xs text-muted-foreground">
            {routineActive
              ? l10n("local.finish_setup_to_enable_this_webhook_future_ev_391fff2b")
              : l10n("local.finish_setup_to_save_this_webhook_the_routine_7580f066")}
          </p>
        )}
        {schedule && draft.step === 2 && !routineActive && (
          <p className="text-sm text-muted-foreground">
            {l10n("local.the_routine_is_paused_enable_its_automatic_tr_28f90721")}</p>
        )}
        {saveError && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
        <SetupWizardFooter onSaveExit={saveAndExit}>
          {draft.step > 0 && goBack}
          {draft.step === 0 ? (
            <Button disabled={draft.kind === "choose"} onClick={advance}>
              {l10n("local.continue_31fbef16")}</Button>
          ) : schedule ? (
            draft.step === 1 ? (
              <Button disabled={!draft.time} onClick={advance}>
                {l10n("local.review_schedule_98c00356")}</Button>
            ) : (
              <Button onClick={() => void perform(() => onFinish(draft))}>
                {l10n("local.add_schedule_79218735")}</Button>
            )
          ) : draft.step === 1 ? (
            <Button onClick={advance}>{l10n("local.check_connection_be5dff52")}</Button>
          ) : (
            <Button onClick={() => void perform(() => onFinish(draft))}>
              {checkResult === "received"
                ? l10n("local.finish_setup_bc01ae77")
                : l10n("local.finish_without_checking_ccfc47b4")}
            </Button>
          )}
        </SetupWizardFooter>
      </fieldset>
    </div>
  );
}
