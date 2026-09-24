import { l10n } from "../i18n";
import { useEffect } from "react";
import { ArrowLeft, RadioTower } from "lucide-react";
import { Link } from "@/lib/router";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

const DASHBOARD_LIVE_RUN_LIMIT = 50;

export function DashboardLive() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: l10n("local.dashboard_67b69646"), href: "/dashboard" },
      { label: l10n("local.live_runs_905f1fef") },
    ]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={RadioTower}
        message={companies.length === 0 ? "Create an organization to view live runs." : "Select an organization to view live runs."}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {l10n("local.dashboard_67b69646")}</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal text-foreground">{l10n("local.live_agent_runs_6663a17b")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {l10n("local.active_runs_first_followed_by_the_most_recent_e4351c0f")}</p>
        </div>
        <div className="text-sm text-muted-foreground">{l10n("local.showing_up_to_3cee7f3f")}{" "}{DASHBOARD_LIVE_RUN_LIMIT}</div>
      </div>

      <ActiveAgentsPanel
        companyId={selectedCompanyId}
        title={l10n("local.active_recent_29047d81")}
        minRunCount={DASHBOARD_LIVE_RUN_LIMIT}
        fetchLimit={DASHBOARD_LIVE_RUN_LIMIT}
        cardLimit={DASHBOARD_LIVE_RUN_LIMIT}
        emptyMessage={l10n("local.no_active_or_recent_agent_runs_ae4f00af")}
        queryScope="dashboard-live"
        showMoreLink={false}
      />
    </div>
  );
}
