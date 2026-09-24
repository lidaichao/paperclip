import { l10n } from "../i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Flag,
  LogOut,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useSignOut } from "@/hooks/useSignOut";
import { useSidebar } from "../context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface MenuActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({ label, description, icon: Icon, onClick, href, external = false }: MenuActionProps) {
  const className =
    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60";

  const content = (
    <>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  open: controlledOpen,
  onOpenChange,
}: SidebarAccountMenuProps) {
  const isCloud = Boolean(useCloudInstance());
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useSignOut({ onSignedOut: closeNavigationChrome });

  const displayName = session?.user.name?.trim() || "Board";
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? l10n("local.signed_in_ca566c89") : l10n("local.local_workspace_board_0b25be89"));
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function handleSignOut() {
    signOutMutation.mutate();
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <div className={cn("flex items-center gap-0.5", !rail && "px-2")}>
        <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-lg text-left text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground",
              rail ? "w-full px-3 py-2" : "flex-1 px-2 py-1.5",
            )}
            aria-label={l10n("local.open_account_menu_04b5bfe6")}
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className={cn("min-w-0 flex-1 truncate", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-(--sz-277px) max-w-(--sz-calc-24) overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-(image:--gradient-extract-25)" />
          <div className="-mt-8 px-4 pb-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
              </div>
            </div>

            <div className="mt-4 space-y-1">
              <MenuAction
                label={l10n("local.view_profile_d4788f25")}
                description={l10n("local.open_your_activity_task_and_usage_ledger_00a218c3")}
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label={l10n("local.edit_profile_15c4aa13")}
                description={l10n("local.update_your_display_name_and_avatar_5f946ed3")}
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label={l10n("local.documentation_c205924d")}
                description={l10n("local.open_paperclip_docs_in_a_new_tab_1b5779dc")}
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <ThemeToggle variant="menu-action" onAfterToggle={() => setOpen(false)} />
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={handleSignOut}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending ? l10n("local.signing_out_04362316") : l10n("local.sign_out_48f0d3d3")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {l10n("local.end_this_browser_session_c1dadf22")}</span>
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
        </Popover>
        {!rail && !isCloud ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={FEEDBACK_URL}
                target="_blank"
                rel="noreferrer"
                aria-label={l10n("local.share_feedback_2af56867")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">{l10n("local.share_feedback_2af56867")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
