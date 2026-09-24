import { l10n } from "../../i18n";
import { SetupWizardNavigation, SetupWizardSidebar } from "../SetupWizard";
export { SetupWizardSidebar as ChatSetupSidebar };
export function ChatSetupNavigation(props: {
  labels?: string[]; step: number; availableStep: number; disabled?: boolean; onSelect: (step: number) => void;
}) {
  return <SetupWizardNavigation {...props} labels={props.labels ?? ["Choose agent", "Connect provider", "Try it"]} ariaLabel={l10n("local.connection_setup_progress_17f5c180")} />;
}
