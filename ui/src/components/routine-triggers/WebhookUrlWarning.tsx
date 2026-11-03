import { l10n } from "../../i18n";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

const warnings = {
  loopback: {
    title: l10n("local.other_apps_can_t_reach_this_localhost_url_a9a1746f"),
    message: l10n("local.webhook_loopback_warning_alice_50bda791"),
  },
  private: {
    title: l10n("local.this_webhook_url_appears_to_be_private_c5cb1534"),
    message: l10n("local.webhook_private_network_warning_b3128b70"),
  },
  tailscale: {
    title: l10n("local.this_tailscale_url_may_not_be_public_76597a67"),
    message: l10n("local.webhook_tailscale_serve_warning_fd5ba028"),
  },
  https: {
    title: l10n("local.use_https_for_webhooks_from_other_apps_9ca07d2c"),
    message: l10n("local.webhook_http_warning_0e2cd559"),
  },
  invalid: {
    title: l10n("local.check_the_webhook_url_4b75da52"),
    message: l10n("local.webhook_invalid_url_warning_60aef7d4"),
  },
};

export function WebhookUrlWarning({ url }: { url: string }) {
  const reason = webhookUrlWarningReason(url);
  if (!reason) return null;
  const warning = warnings[reason];
  return <InlineBanner tone="warning" title={warning.title}>
    <div className="space-y-2">
      <p>{warning.message}</p>
      <p>{l10n("local.you_can_continue_for_local_or_private_network_588d3cda")}</p>
      <a className="underline underline-offset-4" href="https://docs.paperclip.ing/reference/deploy/https/" target="_blank" rel="noopener noreferrer">{l10n("local.learn_how_to_set_up_https_and_public_access_f9d4d69f")}</a>
    </div>
  </InlineBanner>;
}
