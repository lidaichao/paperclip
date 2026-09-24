import { l10n } from "../../../i18n";
import { useId, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";

export interface SlackAvatarProps {
  agentName: string;
  appName: string;
  avatarUrl: string;
}

/** Shared by Slack onboarding and its Settings page. Slack upload is manual. */
export function SlackAvatarContent({
  agentName,
  appName,
  avatarUrl,
  compact = false,
}: SlackAvatarProps & { compact?: boolean }) {
  const id = useId();
  const filename = `${appName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent"}-avatar.png`;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      const response = await fetch(avatarUrl);
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/png")
      )
        throw new Error("Avatar unavailable");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-8">
      <section
        aria-labelledby={`${id}-download`}
        className="flex flex-col items-start gap-6 sm:flex-row sm:items-center"
      >
        <img
          src={avatarUrl}
          width={512}
          height={512}
          alt={l10n("local.value_s_cliptoon_avatar_266fa3d9", {v0: (agentName)})}
          className="size-40 shrink-0 rounded-lg bg-muted object-contain"
        />
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 id={`${id}-download`} className="text-sm font-semibold">
              {compact
                ? l10n("local.download_your_agent_s_avatar_ce5bdd09")
                : l10n("local.1_download_your_agent_s_avatar_fc5927ad")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {l10n("local.png_512_512_ready_for_slack_1439257c")}</p>
          </div>
          <Button variant="outline" asChild>
            <a
              href={avatarUrl}
              download={filename}
              aria-disabled={downloading}
              onClick={(event) => {
                event.preventDefault();
                void download();
              }}
            >
              {downloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              {l10n("local.download_avatar_e7dc2a1b")}</a>
          </Button>
          {downloadError && (
            <p role="alert" className="text-sm text-destructive">
              {l10n("local.couldn_t_download_the_avatar_try_downloading_f77ab7e7")}</p>
          )}
        </div>
      </section>

      <details open={compact ? undefined : true} className="space-y-4">
        <summary
          className={
            compact
              ? "cursor-pointer text-sm underline underline-offset-4"
              : "hidden"
          }
        >
          {l10n("local.how_to_upload_in_slack_68a7030b")}</summary>
        <section aria-labelledby={`${id}-upload`} className="space-y-4">
          <div className="space-y-1">
            <h2 id={`${id}-upload`} className="text-sm font-semibold">
              {compact ? l10n("local.upload_it_in_slack_9ef6fd05") : l10n("local.2_upload_it_in_slack_733c836b")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {l10n("local.you_ll_upload_the_downloaded_image_directly_i_19c451a3")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >
                {l10n("local.open_slack_app_settings_30cfde1e")}{" "}
                <ExternalLink className="inline size-3" />
              </a>{" "}
              {l10n("local.and_choose_566c1f30")}{" "}<strong>{appName}</strong>.
            </li>
            <li>
              {l10n("local.choose_c7f93783")}{" "}<strong>{l10n("local.basic_information_d094b334")}</strong>{l10n("local._then_scroll_to_9a940225")}{" "}
              <strong>{l10n("local.display_information_6ad97855")}</strong>.
            </li>
            <li>
              {l10n("local.under_80e4ad05")}{" "}<strong>{l10n("local.app_icon_amp_preview_2ecc0fa4")}</strong>{l10n("local._click_the_app_icon_and_upload_ac8049f4")}{" "}
              <span className="break-all font-mono text-xs">{filename}</span>.
            </li>
            <li>
              {l10n("local.confirm_the_crop_then_click_483a16f1")}{" "}<strong>{l10n("local.save_changes_35322b5b")}</strong> {l10n("local.in_slack_017245d5")}</li>
          </ol>
        </section>
      </details>
    </div>
  );
}

export function SlackAvatarStep({
  uploaded,
  onUploaded,
  onSkip,
  onSaveExit,
  ...props
}: SlackAvatarProps & {
  uploaded: boolean;
  onUploaded: () => void;
  onSkip: () => void;
  onSaveExit: () => void;
}) {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">
            {l10n("local.give_c6402106")}{" "}{props.agentName} {l10n("local.a_face_in_slack_5c31a82b")}</h1>
          <span className="text-xs text-muted-foreground">{l10n("local.optional_59be7133")}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {l10n("local.use_c36d819e")}{" "}{props.agentName}{l10n("local._s_avatar_so_your_team_recognizes_the_agent_001b345b")}</p>
      </div>
      <SlackAvatarContent {...props} />
      {uploaded && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg bg-(--status-task-done)/10 p-3 text-sm"
        >
          <Check className="size-4 text-(--status-task-done)" />
          {l10n("local.you_marked_the_avatar_as_uploaded_in_slack_bc4cad4b")}</p>
      )}
      <SetupWizardFooter onSaveExit={onSaveExit}>
        <Button variant="ghost" onClick={onSkip}>
          {l10n("local.skip_for_now_b58eb52c")}</Button>
        <Button onClick={onUploaded}>
          {uploaded ? l10n("local.continue_31fbef16") : l10n("local.i_ve_uploaded_the_avatar_6e475f8b")}
          <ArrowRight className="size-4" />
        </Button>
      </SetupWizardFooter>
    </div>
  );
}

export function SlackAvatarSettings(props: SlackAvatarProps) {
  return (
    <section className="space-y-4" aria-label={l10n("local.slack_avatar_761226ca")}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{l10n("local.agent_avatar_fb65e8cf")}</h2>
        <p className="text-sm text-muted-foreground">
          {l10n("local.use_c36d819e")}{" "}{props.agentName}{l10n("local._s_avatar_so_your_team_recognizes_the_agent_001b345b")}</p>
      </div>
      <SlackAvatarContent {...props} compact />
    </section>
  );
}
