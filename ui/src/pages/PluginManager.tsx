import { l10n } from "../i18n";
/**
 * @fileoverview Plugin Manager page — admin UI for discovering,
 * installing, enabling/disabling, and uninstalling plugins.
 *
 * @see PLUGIN_SPEC.md §9 — Plugin Marketplace / Manager
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { AlertTriangle, FlaskConical, Plus, Power, Puzzle, Settings, Trash } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecord): string {
  return firstNonEmptyLine(plugin.lastError) ?? "Plugin entered an error state without a stored error message.";
}

function isExperimentalPluginIdentity(input: {
  packageName?: string | null;
  packagePath?: string | null;
  manifestJson?: PluginRecord["manifestJson"] | null;
  bundledExperimental?: boolean;
}) {
  if (input.bundledExperimental) return true;

  const packageName = input.packageName ?? "";
  const packagePath = input.packagePath ?? "";
  if (packageName.includes("sandbox") || packagePath.includes("sandbox")) return true;
  return input.manifestJson?.environmentDrivers?.some((driver) => driver.kind === "sandbox_provider") === true;
}

function ExperimentalBadge() {
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 dark:text-amber-200"
    >
      {l10n("local.experimental_3dc9f569")}</Badge>
  );
}

/**
 * PluginManager page component.
 *
 * Provides a management UI for the Paperclip plugin system:
 * - Lists all installed plugins with their status, version, and category badges.
 * - Allows installing new plugins by npm package name.
 * - Provides per-plugin actions: enable, disable, navigate to settings.
 * - Uninstall with a two-step confirmation dialog to prevent accidental removal.
 *
 * Data flow:
 * - Reads from `GET /api/plugins` via `pluginsApi.list()`.
 * - Mutations (install / uninstall / enable / disable) invalidate
 *   `queryKeys.plugins.all` so the list refreshes automatically.
 *
 * @see PluginSettings — linked from the Settings icon on each plugin row.
 * @see doc/plugins/PLUGIN_SPEC.md §3 — Plugin Lifecycle for status semantics.
 */
export function PluginManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecord | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? l10n("local.organization_d764d425"), href: "/dashboard" },
      { label: l10n("local.settings_74a883a0"), href: "/company/settings" },
      { label: l10n("local.plugins_9514b7ff") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const bundledQuery = useQuery({
    queryKey: queryKeys.plugins.examples,
    queryFn: () => pluginsApi.listBundled(),
  });

  const invalidatePluginQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.examples });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
  };

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
      pluginsApi.install(params),
    onSuccess: () => {
      invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallPackage("");
      pushToast({ title: l10n("local.plugin_installed_successfully_bdc72b12"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: l10n("local.failed_to_install_plugin_3a078590"), body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: l10n("local.plugin_uninstalled_successfully_d77e15c1"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: l10n("local.failed_to_uninstall_plugin_633e573d"), body: err.message, tone: "error" });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: l10n("local.plugin_enabled_4ca803ee"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: l10n("local.failed_to_enable_plugin_71e15485"), body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: l10n("local.plugin_disabled_a7600976"), tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: l10n("local.failed_to_disable_plugin_ceb9e4f9"), body: err.message, tone: "error" });
    },
  });

  const installedPlugins = plugins ?? [];
  const bundledPlugins = bundledQuery.data ?? [];
  const installedByPackageName = new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin]));
  const bundledByPackageName = new Map(bundledPlugins.map((plugin) => [plugin.packageName, plugin]));
  // Scope the in-section banner to bundled (local-path) installs so an npm-dialog
  // install failure does not surface its error in the bundled-plugins section.
  const installErrorMessage = installMutation.variables?.isLocalPath
    ? installMutation.error?.message ?? null
    : null;
  const errorSummaryByPluginId = useMemo(
    () =>
      new Map(
        installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])
      ),
    [installedPlugins]
  );

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">{l10n("local.loading_plugins_336bfcb0")}</div>;
  if (error) return <div className="p-4 text-sm text-destructive">{l10n("local.failed_to_load_plugins_4725f8bc")}</div>;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{l10n("local.plugin_manager_112d5581")}</h1>
        </div>
        
        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              {l10n("local.install_plugin_70720c52")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{l10n("local.install_plugin_70720c52")}</DialogTitle>
              <DialogDescription>
                {l10n("local.enter_the_npm_package_name_of_the_plugin_you_c9203210")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="packageName">npm Package Name</Label>
                <Input
                  id="packageName"
                  placeholder="@paperclipai/plugin-example"
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>{l10n("local.cancel_19766ed6")}</Button>
              <Button
                onClick={() => installMutation.mutate({ packageName: installPackage })}
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? l10n("local.installing_07ae7fd6") : l10n("local.install_569ca49f")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{l10n("local.plugins_are_alpha_db043750")}</p>
            <p className="text-muted-foreground">
              {l10n("local.the_plugin_runtime_and_api_surface_are_still_8c832113")}</p>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{l10n("local.available_plugins_cbc75f52")}</h2>
          <Badge variant="outline">{l10n("local.bundled_79d3a1f1")}</Badge>
        </div>

        {installErrorMessage && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive whitespace-pre-wrap break-words">
            {installErrorMessage}
          </div>
        )}

        {bundledQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">{l10n("local.loading_bundled_plugins_c450a4bd")}</div>
        ) : bundledQuery.error ? (
          <div className="text-sm text-destructive">{l10n("local.failed_to_load_bundled_plugins_be9b5091")}</div>
        ) : bundledPlugins.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {l10n("local.no_bundled_plugins_were_found_in_this_checkou_c6230ee9")}</div>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {bundledPlugins.map((bundledPlugin) => {
              const installedPlugin = installedByPackageName.get(bundledPlugin.packageName);
              const installPending =
                installMutation.isPending &&
                installMutation.variables?.isLocalPath &&
                installMutation.variables.packageName === bundledPlugin.localPath;

              return (
                <li key={bundledPlugin.packageName}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{bundledPlugin.displayName}</span>
                        <Badge variant="outline">
                          {bundledPlugin.tag === "first-party" ? l10n("local.first_party_ee374836") : l10n("local.example_d029f87e")}
                        </Badge>
                        {isExperimentalPluginIdentity({
                          packageName: bundledPlugin.packageName,
                          packagePath: bundledPlugin.localPath,
                          bundledExperimental: bundledPlugin.experimental,
                        }) && <ExperimentalBadge />}
                        {installedPlugin ? (
                          <Badge
                            variant={installedPlugin.status === "ready" ? "default" : "secondary"}
                            className={installedPlugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""}
                          >
                            {installedPlugin.status}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{l10n("local.not_installed_d177cdc0")}</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{bundledPlugin.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{bundledPlugin.packageName}</p>
                      {installPending && !bundledPlugin.hasBuiltEntrypoints && (
                        <p className="mt-2 text-xs text-muted-foreground">{l10n("local.building_plugin_3476dbbf")}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {installedPlugin ? (
                        <>
                          {installedPlugin.status !== "ready" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={enableMutation.isPending}
                              onClick={() => enableMutation.mutate(installedPlugin.id)}
                            >
                              {l10n("local.enable_5342e09f")}</Button>
                          )}
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/company/settings/instance/plugins/${installedPlugin.id}`}>
                              {installedPlugin.status === "ready" ? l10n("local.open_settings_3f940108") : l10n("local.review_aff0766a")}
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          disabled={installPending || installMutation.isPending}
                          onClick={() =>
                            installMutation.mutate({
                              packageName: bundledPlugin.localPath,
                              isLocalPath: true,
                            })
                          }
                        >
                          {installPending ? l10n("local.installing_07ae7fd6") : l10n("local.install_569ca49f")}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{l10n("local.installed_plugins_15c82606")}</h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">{l10n("local.no_plugins_installed_1411b824")}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {l10n("local.install_a_plugin_to_extend_functionality_b6cb35a2")}</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {installedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <div className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/company/settings/instance/plugins/${plugin.id}`}
                        className="font-medium hover:underline truncate block"
                        title={plugin.manifestJson.displayName ?? plugin.packageName}
                      >
                        {plugin.manifestJson.displayName ?? plugin.packageName}
                      </Link>
                      {bundledByPackageName.has(plugin.packageName) && (
                        <Badge variant="outline">
                          {bundledByPackageName.get(plugin.packageName)?.tag === "first-party"
                            ? l10n("local.first_party_ee374836")
                            : l10n("local.example_d029f87e")}
                        </Badge>
                      )}
                      {isExperimentalPluginIdentity({
                        packageName: plugin.packageName,
                        packagePath: plugin.packagePath,
                        manifestJson: plugin.manifestJson,
                        bundledExperimental: bundledByPackageName.get(plugin.packageName)?.experimental,
                      }) && <ExperimentalBadge />}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate" title={plugin.packageName}>
                        {plugin.packageName} · v{plugin.manifestJson.version ?? plugin.version}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5" title={plugin.manifestJson.description}>
                      {plugin.manifestJson.description || l10n("local.no_description_provided_2527a18a")}
                    </p>
                    {plugin.status === "error" && (
                      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                              <AlertTriangle className="h-4 w-4 shrink-0" />
                              <span>{l10n("local.plugin_error_ba1be930")}</span>
                            </div>
                            <p
                              className="mt-1 text-sm text-red-700/90 dark:text-red-200/90 break-words"
                              title={plugin.lastError ?? undefined}
                            >
                              {errorSummaryByPluginId.get(plugin.id)}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 bg-background/60 text-red-700 hover:bg-red-500/10 hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                            onClick={() => setErrorDetailsPlugin(plugin)}
                          >
                            {l10n("local.view_full_error_2a64ebe0")}</Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 self-center">
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            plugin.status === "ready"
                              ? "default"
                              : plugin.status === "error"
                                ? "destructive"
                              : "secondary"
                          }
                          className={cn(
                            "shrink-0",
                            plugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""
                          )}
                        >
                          {plugin.status}
                        </Badge>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8"
                          title={plugin.status === "ready" ? l10n("local.disable_b7e3e4aa") : l10n("local.enable_5342e09f")}
                          onClick={() => {
                            if (plugin.status === "ready") {
                              disableMutation.mutate(plugin.id);
                            } else {
                              enableMutation.mutate(plugin.id);
                            }
                          }}
                          disabled={enableMutation.isPending || disableMutation.isPending}
                        >
                          <Power className={cn("h-4 w-4", plugin.status === "ready" ? "text-green-600" : "")} />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title={l10n("local.uninstall_fe199528")}
                          onClick={() => {
                            setUninstallPluginId(plugin.id);
                            setUninstallPluginName(plugin.manifestJson.displayName ?? plugin.packageName);
                          }}
                          disabled={uninstallMutation.isPending}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button variant="outline" size="sm" className="mt-2 h-8" asChild>
                        <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
                          <Settings className="h-4 w-4" />
                          {l10n("local.configure_6defafa2")}</Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          </Card>
        )}
      </section>

      <Dialog
        open={uninstallPluginId !== null}
        onOpenChange={(open) => { if (!open) setUninstallPluginId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{l10n("local.uninstall_plugin_6bac25dc")}</DialogTitle>
            <DialogDescription>
              {l10n("local.are_you_sure_you_want_to_uninstall_c091b1c6")}{" "}<strong>{uninstallPluginName}</strong>{l10n("local._this_action_cannot_be_undone_30f98589")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPluginId(null)}>{l10n("local.cancel_19766ed6")}</Button>
            <Button
              variant="destructive"
              disabled={uninstallMutation.isPending}
              onClick={() => {
                if (uninstallPluginId) {
                  uninstallMutation.mutate(uninstallPluginId, {
                    onSettled: () => setUninstallPluginId(null),
                  });
                }
              }}
            >
              {uninstallMutation.isPending ? l10n("local.uninstalling_67c43c33") : l10n("local.uninstall_fe199528")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={errorDetailsPlugin !== null}
        onOpenChange={(open) => { if (!open) setErrorDetailsPlugin(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{l10n("local.error_details_674c0b62")}</DialogTitle>
            <DialogDescription>
              {errorDetailsPlugin?.manifestJson.displayName ?? errorDetailsPlugin?.packageName ?? l10n("local.plugin_ab1173ee")} {l10n("local.hit_an_error_state_0c072758")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">
                    {l10n("local.what_errored_118242fa")}</p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : l10n("local.no_error_summary_available_1acf66ff")}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{l10n("local.full_error_output_414e8495")}</p>
              <pre className="max-h-(--sz-50vh) overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ?? "No stored error message."}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
              {l10n("local.close_7d9eb7ac")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
