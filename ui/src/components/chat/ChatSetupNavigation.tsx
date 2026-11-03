import { l10n } from "../../i18n";
import { SetupWizardNavigation, SetupWizardSidebar } from "../SetupWizard";
export { SetupWizardSidebar as ChatSetupSidebar };
export function ChatSetupNavigation(props: {
  labels?: string[]; step: number; availableStep: number; disabled?: boolean; onSelect: (step: number) => void;
}) {
  return <SetupWizardNavigation {...props} labels={props.labels ?? [
    l10n("local.choose_agent_0c950001"),
    l10n("local.connect_provider_10300167"),
    l10n("local.try_it_0c950004"),
  ]} ariaLabel={l10n("local.connection_setup_progress_17f5c180")} />;
}
