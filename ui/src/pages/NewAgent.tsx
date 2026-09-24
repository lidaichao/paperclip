import { l10n } from "../i18n";
import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { NewAgentSetup } from "../components/new-agent/NewAgentSetup";

export function NewAgent() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: l10n("local.agents_279b44d2"), href: "/agents" },
      { label: l10n("local.new_agent_98a23e6d") },
    ]);
  }, [setBreadcrumbs]);
  return <NewAgentSetup />;
}
