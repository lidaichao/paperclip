import { l10n } from "../../i18n";
import { InlineBanner } from "@/components/InlineBanner";
import { webhookUrlWarningReason } from "@/lib/webhook-url-warning";

const warnings = {
  loopback: {
    title: l10n("local.other_apps_can_t_reach_this_localhost_url_a9a1746f"),
    message: "This address points back to the machine sending the request. Services such as GitHub can’t use it to reach Paperclip on your computer.",
  },
  private: {
    title: l10n("local.this_webhook_url_appears_to_be_private_c5cb1534"),
    message: "Only senders with access to this network can reach this address. Apps on the public internet, such as GitHub, usually can’t deliver webhooks here.",
  },
  tailscale: {
    title: l10n("local.this_tailscale_url_may_not_be_public_76597a67"),
    message: "Tailscale Serve is private to your tailnet, even with HTTPS. Apps outside your tailnet need Tailscale Funnel or another public HTTPS address. If Funnel is already enabled for this URL, you can continue.",
  },
  https: {
    title: l10n("local.use_https_for_webhooks_from_other_apps_9ca07d2c"),
    message: "This URL uses HTTP. Many apps require HTTPS, and HTTP does not encrypt webhook credentials or payloads.",
  },
  invalid: {
    title: l10n("local.check_the_webhook_url_4b75da52"),
    message: "This is not a valid HTTP or HTTPS URL. Your sending app needs a complete address it can reach.",
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
