import { l10n } from "../i18n";
import { useEffect } from "react";
import { Link, useLocation } from "@/lib/router";
import { AlertTriangle, Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

type NotFoundScope = "board" | "invalid_company_prefix" | "global";

interface NotFoundPageProps {
  scope?: NotFoundScope;
  requestedPrefix?: string;
}

export function NotFoundPage({ scope = "global", requestedPrefix }: NotFoundPageProps) {
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companies, selectedCompany } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: l10n("local.not_found_0019dfc4") }]);
  }, [setBreadcrumbs]);

  const fallbackCompany = selectedCompany ?? companies[0] ?? null;
  const dashboardHref = fallbackCompany ? `/${fallbackCompany.issuePrefix}/dashboard` : "/";
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const normalizedPrefix = requestedPrefix?.toUpperCase();

  const title = scope === "invalid_company_prefix" ? l10n("local.organization_not_found_00c50f7a") : l10n("local.page_not_found_a469ab4c");
  const description =
    scope === "invalid_company_prefix"
      ? l10n("local.no_organization_matches_prefix_value_895e90ae", {v0: (normalizedPrefix ?? "unknown")})
      : l10n("local.this_route_does_not_exist_80eced63");

  return (
    <div className="mx-auto max-w-2xl py-10">
      <Card className="block p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="mt-4 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {l10n("local.requested_path_709875dd")}{" "}<code className="font-mono">{currentPath}</code>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild>
            <Link to={dashboardHref}>
              <Compass className="mr-1.5 h-4 w-4" />
              {l10n("local.open_dashboard_803f2313")}</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">{l10n("local.go_home_a0aac914")}</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
