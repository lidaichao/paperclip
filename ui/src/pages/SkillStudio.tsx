import { l10n } from "../i18n";
import { AgentIdentity } from "@/components/AgentIdentity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileCode,
  FilePlus,
  FileText,
  FolderMinus,
  FolderPlus,
  FlaskConical,
  GitFork,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Trash2,
} from "lucide-react";
import type {
  Agent,
  CompanySkillDetail,
  CompanySkillListItem,
  CompanySkillTestInput,
  CompanySkillTestRun,
  CompanySkillTestRunDetail,
  CompanySkillTestRunTemplate,
  CompanySkillTestRunTemplateCreateRequest,
  CompanySkillTestRunTemplateUpdateRequest,
  CompanySkillVersion,
  IssueDocument,
  IssueThreadInteraction,
  AskUserQuestionsInteraction,
  AskUserQuestionsAnswer,
} from "@paperclipai/shared";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { classifySkillDenial } from "@/lib/skill-policy-denial";
import { agentsApi } from "@/api/agents";
import { companySkillsApi } from "@/api/companySkills";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCopyToast } from "@/lib/use-copy-action";
import { skillStudioNewRoute, skillStudioRoute } from "@/lib/company-skill-routes";
import {
  buildBlankSkillDraft,
  buildForkSkillDraft,
  defaultSkillMarkdown,
  normalizeSkillDraftSlug,
  SKILL_CREATE_ACCENTS,
  skillAccentColor,
  skillCreateDraftToPayload,
  splitCategoryDraft,
  type SkillCreateDraft,
} from "@/lib/skill-create";
import { getRecentStudioSkillIds, trackRecentStudioSkill } from "@/lib/recent-skills";
import { AgentsUsingSkillBadge } from "@/components/skill-studio/AgentsUsingSkillDialog";
import { ForkSkillDialog } from "@/components/skill-studio/ForkSkillDialog";
import {
  ProjectScanNotice,
  SkillLineageChip,
} from "@/components/skill-studio/SkillProvenance";
import { isProjectScanSkill } from "@/lib/skill-fork";
import { cn, formatCents, relativeTime } from "@/lib/utils";
import { SkillCardIcon, type DiscoveryCard } from "./CompanySkills";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable-panels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileTree, buildFileTree, type FileTreeNode } from "@/components/FileTree";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { FrontmatterPanel } from "@/components/FrontmatterPanel";
import { joinFrontmatterBlock, splitFrontmatterBlock } from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { EntityRow } from "@/components/EntityRow";
import { FilterBar } from "@/components/FilterBar";
import { Identity } from "@/components/Identity";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { IssueAttachmentsSection } from "@/components/IssueAttachmentsSection";
import { ImageGalleryModal, type GalleryMediaItem } from "@/components/ImageGalleryModal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { IssueOutputSection } from "@/components/issue-output/IssueOutputSection";
import { buildLineDiff } from "@/lib/line-diff";
import {
  buildCreateRunRequest,
  buildReRunRequest,
  DEFAULT_TEST_RUN_TEMPLATE_ID,
  EMPTY_SAVED_INPUT_DRAFT_STATE,
  evaluateRunGate,
  getRunAdditionalDocuments,
  getRunMediaGalleryItems,
  getRunRawAttachments,
  isAgentSelectable,
  isInteractionAnswerable,
  isTerminalRunStatus,
  orderRecentlyUpdatedSkills,
  orderRecentlyVisitedSkills,
  skillEditorAvatar,
  NO_TEST_RUN_TEMPLATE_STORAGE_VALUE,
  parseRunTemplateSelection,
  routeInteraction,
  runBadgeStatus,
  runHarnessUnavailableCopy,
  runOutputMode,
  runShortId,
  resolveRunTemplateSelection,
  serializeRunTemplateSelection,
  savedInputDraftDirty,
  selectedSavedInputDraft,
  shouldPollRun,
  showRunErrorCard,
  syncSavedInputDraftState,
  testTaskLinkState,
  type RunTemplateSelection,
  type SavedInputDraftState,
} from "@/lib/skill-studio";

const PANE_STORAGE_KEY = "skillStudio.paneSizes";
const RUN_TEMPLATE_STORAGE_KEY_PREFIX = "skillStudio.runTemplate";
const MOBILE_BREAKPOINT = 900;
const POLL_MS = 2000;
const EMPTY_RUN_TEMPLATES: CompanySkillTestRunTemplate[] = [];

/**
 * Surface a mutation rejection as an error toast. Every Studio mutation routes
 * failures through here so server rejections (409 agent_not_assignable, 422
 * read-only, …) never get silently swallowed (PAP-13001).
 */
function useMutationErrorToast() {
  const toast = useOptionalToastActions();
  return useCallback(
    (title: string) => (error: unknown) => {
      // Under the open default there is no permission chrome. When an action is
      // actually denied — by an explicit company policy (State B) or a platform
      // safety invariant (State C) — show the actionable denial title/remediation
      // instead of a generic "try again" error (§9.10, PAP-13865). Transient
      // failures keep the plain error toast.
      const denial = classifySkillDenial(error);
      if (denial) {
        toast?.pushToast({ tone: "warn", title: denial.title, body: denial.remediation });
        return;
      }
      const body =
        error instanceof Error && error.message ? error.message : "Please try again.";
      toast?.pushToast({ tone: "error", title, body });
    },
    [toast],
  );
}

// ---------------------------------------------------------------------------
// Pane-size persistence (contract: persist per user `skillStudio.paneSizes`)
// ---------------------------------------------------------------------------

type PaneLayout = { skill: number; input: number; runs: number };
const DEFAULT_LAYOUT: PaneLayout = { skill: 37.5, input: 25, runs: 37.5 };

function loadPaneLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(PANE_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<PaneLayout>;
    if (
      typeof parsed?.skill === "number"
      && typeof parsed?.input === "number"
      && typeof parsed?.runs === "number"
    ) {
      return { skill: parsed.skill, input: parsed.input, runs: parsed.runs };
    }
  } catch {
    /* ignore malformed persisted layout */
  }
  return DEFAULT_LAYOUT;
}

function runTemplateStorageKey(companyId: string) {
  return `${RUN_TEMPLATE_STORAGE_KEY_PREFIX}.${companyId}`;
}

function loadRunTemplateSelection(companyId: string): RunTemplateSelection {
  try {
    return parseRunTemplateSelection(localStorage.getItem(runTemplateStorageKey(companyId)));
  } catch {
    return DEFAULT_TEST_RUN_TEMPLATE_ID;
  }
}

function persistRunTemplateSelection(companyId: string, selection: RunTemplateSelection) {
  try {
    localStorage.setItem(runTemplateStorageKey(companyId), serializeRunTemplateSelection(selection));
  } catch {
    /* storage may be unavailable (private mode) — non-fatal */
  }
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < MOBILE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function SkillStudio() {
  const { skillId = "" } = useParams<{ skillId: string }>();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const companyId = selectedCompanyId ?? "";
  const isCreateMode = location.pathname.replace(/\/+$/, "").endsWith("/skills/studio/new");
  const forkFromSkillId = isCreateMode ? searchParams.get("forkFrom")?.trim() || null : null;
  // New skills created from a folder context (e.g. My Skills) carry their
  // destination folder through this query param; without it the created skill
  // silently lands in Unfiled (PAP-14086).
  const newSkillFolderId = isCreateMode ? searchParams.get("folderId")?.trim() || null : null;

  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(companyId),
    queryFn: () => companySkillsApi.list(companyId, { sort: "alphabetical" }),
    enabled: Boolean(companyId),
  });

  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, skillId),
    queryFn: () => companySkillsApi.detail(companyId, skillId),
    enabled: Boolean(companyId && skillId && !isCreateMode),
  });
  const forkDetailQuery = useQuery({
    queryKey: queryKeys.companySkills.detail(companyId, forkFromSkillId ?? ""),
    queryFn: () => companySkillsApi.detail(companyId, forkFromSkillId!),
    enabled: Boolean(companyId && forkFromSkillId),
  });
  const skill = detailQuery.data ?? null;

  useEffect(() => {
    setBreadcrumbs(
      isCreateMode
        ? [
            { label: l10n("local.skills_66d0f523"), href: "/skills" },
            { label: l10n("local.studio_0aa91af2"), href: "/skills/studio" },
            { label: l10n("local.new_skill_9bf06a86") },
          ]
        : skill
        ? [
            { label: l10n("local.skills_66d0f523"), href: "/skills" },
            { label: l10n("local.studio_0aa91af2"), href: "/skills/studio" },
            { label: skill.name },
          ]
        : [
            { label: l10n("local.skills_66d0f523"), href: "/skills" },
            { label: l10n("local.studio_0aa91af2") },
          ],
    );
  }, [isCreateMode, setBreadcrumbs, skill]);

  // Record a per-browser visit whenever a skill successfully opens, powering the
  // landing's "Recently visited" section (PAP-13150).
  useEffect(() => {
    if (skill?.id) trackRecentStudioSkill(skill.id);
  }, [skill?.id]);

  if (!companyId) {
    return <StudioMessage message="Select an organization to open Skill Studio." />;
  }
  if (isCreateMode) {
    return (
      <StudioCreateMode
        companyId={companyId}
        skills={skillsQuery.data ?? []}
        skillsLoading={skillsQuery.isLoading}
        forkFromSkillId={forkFromSkillId}
        folderId={newSkillFolderId}
        forkSkill={forkDetailQuery.data ?? null}
        forkLoading={forkDetailQuery.isLoading}
        forkError={forkDetailQuery.isError}
        onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
      />
    );
  }
  if (!skillId) {
    return (
      <StudioLanding
        companyId={companyId}
        skills={skillsQuery.data ?? []}
        skillsLoading={skillsQuery.isLoading}
        onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
        onCreateNew={() => navigate(skillStudioNewRoute())}
      />
    );
  }
  if (detailQuery.isLoading) {
    return <StudioMessage message="Loading skill…" />;
  }
  if (detailQuery.isError || !detailQuery.data) {
    return <StudioMessage message="Skill not found." />;
  }

  return (
    <StudioShell
      companyId={companyId}
      skill={detailQuery.data}
      skills={skillsQuery.data ?? []}
      skillsLoading={skillsQuery.isLoading}
    />
  );
}

function StudioCreateMode({
  companyId,
  skills,
  skillsLoading,
  forkFromSkillId,
  folderId,
  forkSkill,
  forkLoading,
  forkError,
  onSelectSkill,
}: {
  companyId: string;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  forkFromSkillId: string | null;
  folderId: string | null;
  forkSkill: CompanySkillDetail | null;
  forkLoading: boolean;
  forkError: boolean;
  onSelectSkill: (skillId: string) => void;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={l10n("local.new_skill_9bf06a86")}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StudioNewSkillPanel
            companyId={companyId}
            forkFromSkillId={forkFromSkillId}
            folderId={folderId}
            forkSkill={forkSkill}
            forkLoading={forkLoading}
            forkError={forkError}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

function StudioNewSkillPanel({
  companyId,
  forkFromSkillId,
  folderId,
  forkSkill,
  forkLoading,
  forkError,
}: {
  companyId: string;
  forkFromSkillId: string | null;
  folderId: string | null;
  forkSkill: CompanySkillDetail | null;
  forkLoading: boolean;
  forkError: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const initialDraft = useMemo(() => {
    const base = forkSkill ? buildForkSkillDraft(forkSkill) : buildBlankSkillDraft();
    // An explicit folder context from the URL wins over a fork source's folder
    // so the new skill is filed where the user launched creation (PAP-14086).
    return folderId ? { ...base, folderId } : base;
  }, [forkSkill, folderId]);
  const [draft, setDraft] = useState<SkillCreateDraft>(initialDraft);
  const [slugDirty, setSlugDirty] = useState(initialDraft.slug.trim().length > 0);
  const [categoryDraft, setCategoryDraft] = useState(initialDraft.categories.join(", "));
  const parsedCategories = splitCategoryDraft(categoryDraft);
  const effectiveSlug = draft.slug.trim() || normalizeSkillDraftSlug(draft.name);
  const nameValid = draft.name.trim().length > 0;

  useEffect(() => {
    setDraft(initialDraft);
    setSlugDirty(initialDraft.slug.trim().length > 0);
    setCategoryDraft(initialDraft.categories.join(", "));
  }, [initialDraft]);

  function patchDraft(patch: Partial<SkillCreateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  const createSkill = useMutation({
    mutationFn: () => companySkillsApi.create(companyId, skillCreateDraftToPayload({
      ...draft,
      categories: parsedCategories,
    })),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.list(companyId) });
      toast?.pushToast({
        tone: "success",
        title: skill.forkedFromSkillId ? "Skill fork created" : "Skill created",
        body: `${skill.name} is now editable in the Paperclip workspace.`,
      });
      navigate(skillStudioRoute(skill.id));
    },
    onError: (error) => {
      toast?.pushToast({
        tone: "error",
        title: "Skill creation failed",
        body: error instanceof Error ? error.message : "Failed to create skill.",
      });
    },
  });

  if (forkFromSkillId && forkLoading) {
    return <StudioMessage message="Loading fork source..." />;
  }

  const previewCard: DiscoveryCard = {
    key: effectiveSlug || draft.name || "new-skill",
    skillId: null,
    catalogRef: null,
    name: draft.name || "New Skill",
    slug: effectiveSlug || "skill",
    author: "you",
    version: null,
    tagline: draft.tagline || null,
    description: draft.tagline,
    categories: parsedCategories,
    iconUrl: null,
    color: draft.color,
    starCount: 0,
    agentCount: 0,
    forkCount: 0,
    installed: false,
    required: false,
    forkedFrom: Boolean(draft.forkedFromSkillId),
    updatedAt: Date.now(),
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">
          {draft.forkedFromSkillId ? l10n("local.fork_skill_fa941eb0") : l10n("local.create_a_new_skill_334c7dd9")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {l10n("local.create_an_editable_organization_skill_and_ope_deec8965")}</p>
      </div>

      {draft.forkedFromName ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <GitFork className="h-4 w-4" />
          {l10n("local.forking_e56efe53")}{" "}{draft.forkedFromName}
        </div>
      ) : forkError ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {l10n("local.fork_source_not_found_you_can_still_create_a_e993a033")}</div>
      ) : null}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{l10n("local.basics_8fdd2ee8")}</h2>
          <p className="text-xs text-muted-foreground">{l10n("local.name_the_skill_and_set_the_route_safe_slug_0701145e")}</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="skill-name">{l10n("local.name_dcd1d522")}</Label>
            <Input
              id="skill-name"
              value={draft.name}
              onChange={(event) => {
                const nextName = event.target.value;
                patchDraft({
                  name: nextName,
                  slug: slugDirty ? draft.slug : normalizeSkillDraftSlug(nextName),
                  markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                    ? defaultSkillMarkdown(nextName, draft.tagline)
                    : draft.markdown,
                });
              }}
              placeholder={l10n("local.code_review_3d200671")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-slug">{l10n("local.slug_d15387ec")}</Label>
            <Input
              id="skill-slug"
              value={draft.slug}
              onChange={(event) => {
                const nextSlug = normalizeSkillDraftSlug(event.target.value);
                setSlugDirty(nextSlug.length > 0);
                patchDraft({ slug: nextSlug });
              }}
              placeholder="code-review"
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-tagline">{l10n("local.tagline_fdab2c2f")}</Label>
          <Textarea
            id="skill-tagline"
            value={draft.tagline}
            onChange={(event) => {
              const nextTagline = event.target.value;
              patchDraft({
                tagline: nextTagline,
                description: draft.description ? draft.description : nextTagline,
                markdown: draft.markdown === defaultSkillMarkdown(draft.name, draft.tagline)
                  ? defaultSkillMarkdown(draft.name, nextTagline)
                  : draft.markdown,
              });
            }}
            placeholder={l10n("local.review_repository_changes_for_correctness_tes_1ca7c502")}
            className="min-h-20"
          />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{l10n("local.appearance_3907fa7f")}</h2>
          <p className="text-xs text-muted-foreground">{l10n("local.tune_how_the_skill_appears_in_the_store_and_s_b87e0c2d")}</p>
        </div>
        <div className="flex items-center gap-3">
          <SkillCardIcon card={previewCard} size={48} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{previewCard.name}</div>
            <div className="truncate text-xs text-muted-foreground">{draft.tagline || l10n("local.no_tagline_yet_8e4cf121")}</div>
          </div>
        </div>
        <div className="space-y-2">
          <Label>{l10n("local.color_6b73191a")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            {SKILL_CREATE_ACCENTS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => patchDraft({ color })}
                className={cn(
                  "h-7 w-7 rounded-md border",
                  draft.color === color ? "border-foreground" : "border-border",
                )}
                style={{ backgroundColor: color }}
                aria-label={l10n("local.use_value_4a3ba369", {v0: (color)})}
              />
            ))}
            <Input
              aria-label={l10n("local.hex_color_91f4e4b1")}
              value={draft.color}
              onChange={(event) => patchDraft({ color: event.target.value })}
              className="h-7 w-28 font-mono text-xs"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-categories">{l10n("local.categories_b8b1d894")}</Label>
          <Input
            id="skill-categories"
            value={categoryDraft}
            onChange={(event) => setCategoryDraft(event.target.value)}
            placeholder={l10n("local.engineering_review_memory_60bdd3ca")}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">{l10n("local.sharing_bbedc70e")}</h2>
          <p className="text-xs text-muted-foreground">{l10n("local.choose_who_can_discover_this_skill_inside_pap_4522d774")}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["company", "private"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => patchDraft({ sharingScope: scope })}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm",
                draft.sharingScope === scope ? "border-foreground bg-accent/50" : "border-border",
              )}
            >
              <span className="block font-medium">{scope === "company" ? l10n("local.organization_d764d425") : l10n("local.private_c63eb672")}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {scope === "company" ? l10n("local.visible_inside_this_organization_07a1e6d8") : l10n("local.only_visible_in_your_library_efbca227")}
              </span>
            </button>
          ))}
          <button
            type="button"
            disabled
            className="rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground"
          >
            <span className="block font-medium">{l10n("local.public_591935b1")}</span>
            <span className="mt-1 block text-xs">{l10n("local.coming_later_3ff09ef1")}</span>
          </button>
        </div>
      </section>

      <details className="rounded-md border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">{l10n("local.starter_content_237b1978")}</summary>
        <Textarea
          value={draft.markdown}
          onChange={(event) => patchDraft({ markdown: event.target.value })}
          className="mt-3 min-h-(--sz-22rem) resize-y font-mono text-xs"
        />
      </details>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button variant="ghost" onClick={() => navigate("/skills/studio")} disabled={createSkill.isPending}>
          {l10n("local.cancel_19766ed6")}</Button>
        <Button onClick={() => createSkill.mutate()} disabled={createSkill.isPending || !nameValid}>
          <FilePlus className="h-4 w-4" />
          {createSkill.isPending ? l10n("local.creating_def70944") : draft.forkedFromSkillId ? l10n("local.create_fork_d217b73b") : l10n("local.create_skill_1a903008")}
        </Button>
      </div>
    </div>
  );
}

function StudioMessage({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-(--sz-60vh) items-center justify-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function StudioEmptyState({
  skills,
  skillsLoading,
  onSelectSkill,
  onCreateNew,
}: {
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onCreateNew: () => void;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={l10n("local.select_skill_4511ad1c")}
          />
        </header>
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={FileCode}
            message={skillsLoading ? "Loading skills..." : "Select a skill to open Studio."}
            action="Create a new skill"
            onAction={onCreateNew}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Landing — recently visited + recently updated (PAP-13150)
// ---------------------------------------------------------------------------

function StudioLanding({
  companyId,
  skills,
  skillsLoading,
  onSelectSkill,
  onCreateNew,
}: {
  companyId: string;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onCreateNew: () => void;
}) {
  // Recency-sorted list, enriched with the last human editor (PAP-13149) — the
  // source for both landing sections. Kept separate from the alphabetical
  // switcher list so each cache stays sorted the way its consumer expects.
  const recentQuery = useQuery({
    queryKey: queryKeys.companySkills.listRecent(companyId),
    queryFn: () => companySkillsApi.list(companyId, { sort: "recent", include: ["lastEditor"] }),
    enabled: Boolean(companyId),
  });
  const recentSkills = recentQuery.data ?? [];

  const visited = useMemo(
    () => orderRecentlyVisitedSkills(recentSkills, getRecentStudioSkillIds()),
    [recentSkills],
  );
  const updated = useMemo(
    () => orderRecentlyUpdatedSkills(recentSkills, visited.map((skill) => skill.id)),
    [recentSkills, visited],
  );

  // No skills at all (or still loading) -> today's empty/loading fallback.
  if (recentSkills.length === 0) {
    return (
      <StudioEmptyState
        skills={skills}
        skillsLoading={skillsLoading || recentQuery.isLoading}
        onSelectSkill={onSelectSkill}
        onCreateNew={onCreateNew}
      />
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-3 py-2">
          <SkillSwitcher
            skill={null}
            skills={skills}
            loading={skillsLoading}
            onSelectSkill={onSelectSkill}
            emptyLabel={l10n("local.select_skill_4511ad1c")}
          />
          <Button variant="ghost" size="sm" className="ml-auto" onClick={onCreateNew}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {l10n("local.new_skill_9bf06a86")}</Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
            {visited.length > 0 ? (
              <StudioLandingSection
                title={l10n("local.recently_visited_b3f3bc04")}
                skills={visited}
                onSelectSkill={onSelectSkill}
              />
            ) : null}
            <StudioLandingSection
              title={l10n("local.recently_updated_474b2a86")}
              skills={updated}
              onSelectSkill={onSelectSkill}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function StudioLandingSection({
  title,
  skills,
  onSelectSkill,
}: {
  title: string;
  skills: CompanySkillListItem[];
  onSelectSkill: (skillId: string) => void;
}) {
  if (skills.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {skills.map((skill) => (
          <StudioLandingRow
            key={skill.id}
            skill={skill}
            onSelect={() => onSelectSkill(skill.id)}
          />
        ))}
      </div>
    </section>
  );
}

function StudioLandingRow({
  skill,
  onSelect,
}: {
  skill: CompanySkillListItem;
  onSelect: () => void;
}) {
  const editor = skillEditorAvatar(skill.lastEditor);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent"
    >
      <SkillLandingIcon skill={skill} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{skill.name}</span>
        {skill.tagline ? (
          <span className="truncate text-xs text-muted-foreground">{skill.tagline}</span>
        ) : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {l10n("local.updated_27eb5e51")}{" "}{relativeTime(skill.updatedAt)}
      </span>
      {editor ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Avatar size="xs">
              {editor.imageUrl ? <AvatarImage src={editor.imageUrl} alt="" /> : null}
              <AvatarFallback>{editor.initials}</AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>{editor.name}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="w-5 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function SkillLandingIcon({ skill }: { skill: CompanySkillListItem }) {
  if (skill.iconUrl) {
    return (
      <img
        src={skill.iconUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-md object-cover"
      />
    );
  }
  const accent = skillAccentColor(skill.key, skill.color);
  const letter = (skill.slug || skill.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white"
      style={{ backgroundColor: accent }}
    >
      {letter}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shell — header + three panes (or mobile tabs)
// ---------------------------------------------------------------------------

function StudioShell({
  companyId,
  skill,
  skills,
  skillsLoading,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
}) {
  const skillId = skill.id;
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // --- selection / cross-pane state ---
  const [selectedInputId, setSelectedInputId] = useState<string | null>(
    () => searchParams.get("input"),
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    () => searchParams.get("run"),
  );
  const [adHocMode, setAdHocMode] = useState(false);
  const [adHocContent, setAdHocContent] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [skillDirty, setSkillDirty] = useState(false);
  const [versionSheetOpen, setVersionSheetOpen] = useState(false);
  const [forkDialogOpen, setForkDialogOpen] = useState(false);

  const layoutRef = useRef<PaneLayout>(loadPaneLayout());

  // Keep deep-link params in sync (?input, ?run).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (selectedInputId) next.set("input", selectedInputId);
    else next.delete("input");
    if (selectedRunId) next.set("run", selectedRunId);
    else next.delete("run");
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInputId, selectedRunId]);

  const inputsQuery = useQuery({
    queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
    queryFn: () => companySkillsApi.testInputs(companyId, skillId),
    enabled: Boolean(companyId && skillId),
  });

  const persistLayout = useCallback((layout: Record<string, number>) => {
    const next: PaneLayout = {
      skill: layout.skill ?? layoutRef.current.skill,
      input: layout.input ?? layoutRef.current.input,
      runs: layout.runs ?? layoutRef.current.runs,
    };
    layoutRef.current = next;
    try {
      localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }, []);

  const inputs = inputsQuery.data ?? [];
  const selectedInput = inputs.find((i) => i.id === selectedInputId) ?? null;

  const leftPane = (
    <SkillPane
      companyId={companyId}
      skill={skill}
      onDirtyChange={setSkillDirty}
      onEditACopy={() => setForkDialogOpen(true)}
    />
  );
  const projectScan = isProjectScanSkill(skill.metadata);
  const middlePane = (
    <InputPane
      companyId={companyId}
      skillId={skillId}
      inputs={inputs}
      loading={inputsQuery.isLoading}
      selectedInputId={selectedInputId}
      adHocMode={adHocMode}
      adHocContent={adHocContent}
      onAdHocChange={setAdHocContent}
      onSelectInput={(id) => {
        setSelectedInputId(id);
        setAdHocMode(false);
      }}
      onSelectAdHoc={() => {
        setAdHocContent("");
        setAdHocMode(true);
        setSelectedInputId(null);
      }}
    />
  );
  const rightPane = (
    <RunsPane
      companyId={companyId}
      skill={skill}
      inputs={inputs}
      selectedInput={selectedInput}
      adHocMode={adHocMode}
      adHocContent={adHocContent}
      selectedRunId={selectedRunId}
      onSelectRun={setSelectedRunId}
      selectedAgentId={selectedAgentId}
      onSelectAgent={setSelectedAgentId}
      skillDirty={skillDirty}
      filterInput={selectedInput}
      onClearFilter={() => setSelectedInputId(null)}
    />
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-col">
        <StudioHeader
          companyId={companyId}
          skill={skill}
          skillDirty={skillDirty}
          skills={skills}
          skillsLoading={skillsLoading}
          onSelectSkill={(nextSkillId) => navigate(skillStudioRoute(nextSkillId))}
          onOpenVersions={() => setVersionSheetOpen(true)}
        />
        {projectScan ? (
          <ProjectScanNotice skill={skill} onEditACopy={() => setForkDialogOpen(true)} />
        ) : null}
        {isMobile ? (
          <MobileTabs skill={leftPane} input={middlePane} runs={rightPane} />
        ) : (
          <ResizablePanelGroup
            className="flex-1 min-h-0"
            defaultLayout={{
              skill: layoutRef.current.skill,
              input: layoutRef.current.input,
              runs: layoutRef.current.runs,
            }}
            onLayoutChanged={persistLayout}
          >
            <ResizablePanel id="skill" minSize="280px" className="border-r border-border">
              {leftPane}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="input"
              minSize="240px"
              collapsible
              collapsedSize="40px"
              className="border-r border-border"
            >
              {middlePane}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="runs" minSize="360px">
              {rightPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
      <VersionHistorySheet
        open={versionSheetOpen}
        onOpenChange={setVersionSheetOpen}
        companyId={companyId}
        skill={skill}
        onRestored={() => {
          setSkillDirty(false);
          queryClient.invalidateQueries({
            queryKey: queryKeys.companySkills.detail(companyId, skillId),
          });
        }}
        onFilterRuns={(inputId) => setSelectedInputId(inputId)}
      />
      <ForkSkillDialog
        companyId={companyId}
        skill={skill}
        open={forkDialogOpen}
        onOpenChange={setForkDialogOpen}
      />
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function StudioHeader({
  companyId,
  skill,
  skillDirty,
  skills,
  skillsLoading,
  onSelectSkill,
  onOpenVersions,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  skillDirty: boolean;
  skills: CompanySkillListItem[];
  skillsLoading: boolean;
  onSelectSkill: (skillId: string) => void;
  onOpenVersions: () => void;
}) {
  const version = skill.currentVersion?.revisionNumber ?? null;
  const toast = useOptionalToastActions();
  const copyShareLink = useCallback(() => {
    const href = typeof window !== "undefined" ? window.location.href : "";
    void copyTextToClipboard(href)
      .then(() => toast?.pushToast({ tone: "success", title: "Link copied", body: "Skill Studio link copied to clipboard." }))
      .catch((error) => toast?.pushToast({
        tone: "error",
        title: "Copy failed",
        body: error instanceof Error ? error.message : "Could not copy the link.",
      }));
  }, [toast]);

  return (
    <header className="flex items-center gap-3 border-b border-border px-3 py-2">
      <SkillSwitcher
        skill={skill}
        skills={skills}
        loading={skillsLoading}
        onSelectSkill={onSelectSkill}
      />
      {version !== null && (
        <span className="font-mono text-xs text-muted-foreground">v{version}</span>
      )}
      {skillDirty ? (
        <Badge variant="secondary">{l10n("local.unsaved_edits_4cea356a")}</Badge>
      ) : null}
      {!skill.editable ? (
        <Badge variant="secondary">{l10n("local.read_only_72bb9089")}</Badge>
      ) : null}
      {skill.forkedFromSkillId ? (
        <SkillLineageChip
          companyId={companyId}
          forkedFromSkillId={skill.forkedFromSkillId}
        />
      ) : null}
      <AgentsUsingSkillBadge companyId={companyId} skill={skill} />
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onOpenVersions}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          {l10n("local.version_history_a6df11e7")}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={l10n("local.studio_menu_b7bc60e8")}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={copyShareLink}>
              <Share2 className="mr-2 h-4 w-4" /> {l10n("local.share_link_712a4823")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

type SkillSwitcherOption = SearchableSelectOption<string> & {
  skill: CompanySkillListItem | CompanySkillDetail;
};

function SkillSwitcher({
  skill,
  skills,
  loading,
  onSelectSkill,
  emptyLabel = "Select skill",
}: {
  skill: CompanySkillDetail | null;
  skills: CompanySkillListItem[];
  loading: boolean;
  onSelectSkill: (skillId: string) => void;
  emptyLabel?: string;
}) {
  const groups = useMemo<readonly SearchableSelectGroup<string, SkillSwitcherOption>[]>(() => {
    const options: SkillSwitcherOption[] = withCurrentSkill(skills, skill).map((item) => ({
      key: item.id,
      value: item.id,
      label: item.name,
      title: item.name,
      searchText: [item.name, item.slug, item.key, item.description ?? ""].join(" "),
      skill: item,
    }));
    return [{ id: "skills", options }];
  }, [skill, skills]);

  return (
    <SearchableSelect<string, SkillSwitcherOption>
      value={skill?.id ?? ""}
      groups={groups}
      loading={loading}
      loadingMessage={l10n("local.loading_skills_7cf5fa27")}
      placeholder={emptyLabel}
      searchPlaceholder={l10n("local.search_skills_65104bc4")}
      emptyMessage={l10n("local.no_matching_skills_18f3ee30")}
      onValueChange={(value) => {
        if (value !== skill?.id) onSelectSkill(value);
      }}
      triggerClassName="h-8 w-64 border-0 bg-transparent px-0 text-base font-semibold shadow-none hover:bg-accent md:w-80"
      contentClassName="w-80"
      contentWidth="auto"
      renderValue={(option) => option?.label ?? skill?.name ?? emptyLabel}
      renderOption={(option, { selected }) => (
        <span className="flex min-w-0 flex-col">
          <span className={cn("truncate", selected && "font-medium")}>{option.label}</span>
          <span className="truncate text-(length:--text-micro) text-muted-foreground">
            {option.skill.slug}
          </span>
        </span>
      )}
    />
  );
}

function withCurrentSkill(
  skills: CompanySkillListItem[],
  skill: CompanySkillDetail | null,
): Array<CompanySkillListItem | CompanySkillDetail> {
  if (!skill) return skills;
  return skills.some((candidate) => candidate.id === skill.id) ? skills : [skill, ...skills];
}

// ---------------------------------------------------------------------------
// Left — Skill files + editor
// ---------------------------------------------------------------------------

function SkillPane({
  companyId,
  skill,
  onDirtyChange,
  onEditACopy,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  onDirtyChange: (dirty: boolean) => void;
  onEditACopy: () => void;
}) {
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const paths = useMemo(
    () => skill.fileInventory.map((f) => f.path),
    [skill.fileInventory],
  );
  const [selectedFile, setSelectedFile] = useState<string>(
    () => paths.find((p) => /skill\.md$/i.test(p)) ?? paths[0] ?? "SKILL.md",
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [createDialog, setCreateDialog] = useState<"file" | "folder" | null>(null);
  const [deleteFolderOpen, setDeleteFolderOpen] = useState(false);
  // Gate rich-editor onChange until the user actually interacts with the body.
  // MDXEditor can emit a normalizing onChange on mount, which would otherwise
  // dirty the file on open and break the byte-identity guarantee (PAP-13156).
  const bodyInteractedRef = useRef(false);
  const markBodyInteracted = useCallback(() => {
    bodyInteractedRef.current = true;
  }, []);

  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(paths.map((p) => [p, ""]))),
    [paths],
  );

  const fileQuery = useQuery({
    queryKey: queryKeys.companySkills.file(companyId, skillId, selectedFile),
    queryFn: () => companySkillsApi.file(companyId, skillId, selectedFile),
    enabled: Boolean(companyId && skillId && selectedFile),
  });

  useEffect(() => {
    if (fileQuery.data) {
      bodyInteractedRef.current = false;
      setDraft(fileQuery.data.content);
      setSavedContent(fileQuery.data.content);
    }
  }, [fileQuery.data]);

  const dirty = draft !== savedContent;
  const currentFolder = parentFolder(selectedFile);
  const pathSet = useMemo(() => new Set(paths), [paths]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const selectFile = useCallback((path: string) => {
    if (path === selectedFile) return;
    if (
      dirty
      && typeof window !== "undefined"
      && !window.confirm(l10n("local.discard_unsaved_edits_and_switch_files_8f639fa5"))
    ) {
      return;
    }
    setSelectedFile(path);
  }, [dirty, selectedFile]);

  const saveMutation = useMutation({
    mutationFn: () => companySkillsApi.updateFile(companyId, skillId, selectedFile, draft),
    onSuccess: (updated) => {
      setSavedContent(updated.content);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: onError("Couldn't save file"),
  });

  const createMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      companySkillsApi.updateFile(companyId, skillId, path, content),
    onSuccess: (created) => {
      setSelectedFile(created.path);
      setDraft(created.content);
      setSavedContent(created.content);
      setCreateDialog(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: onError("Couldn't create file"),
  });

  const deleteMutation = useMutation({
    mutationFn: (input: { path: string; target: "file" | "folder" }) =>
      companySkillsApi.deleteFile(companyId, skillId, input),
    onSuccess: (result) => {
      const deleted = new Set(result.deletedPaths);
      const remaining = paths.filter((path) => !deleted.has(path));
      setSelectedFile(remaining.find((path) => /skill\.md$/i.test(path)) ?? remaining[0] ?? "SKILL.md");
      setDeleteFolderOpen(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.detail(companyId, skillId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.list(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.versions(companyId, skillId),
      });
    },
    onError: onError("Couldn't delete file"),
  });

  // Read-only skills (bundled Paperclip, remote GitHub, URL, skills.sh) reject
  // file writes server-side; reflect that up-front instead of letting the user
  // type into an editor whose Save silently 422s (PAP-13001 Bug B).
  const readOnly = skill.editable === false || fileQuery.data?.editable === false;

  if (paths.length === 0) {
    return (
      <PaneScaffold
        title={<SkillPaneTitle skillName={skill.name} folder="root" />}
        action={
          <SkillFileActions
            readOnly={readOnly}
            selectedFile={selectedFile}
            currentFolder=""
            canDeleteFile={false}
            pending={createMutation.isPending || deleteMutation.isPending || dirty}
            onAddFile={() => setCreateDialog("file")}
            onAddFolder={() => setCreateDialog("folder")}
            onDeleteFile={() => {}}
            onDeleteFolder={() => setDeleteFolderOpen(true)}
          />
        }
      >
        <EmptyState icon={FileCode} message="This skill has no files yet." />
        <SkillPathDialog
          mode={createDialog}
          open={createDialog !== null}
          onOpenChange={(open) => {
            if (!open) setCreateDialog(null);
          }}
          currentFolder=""
          existingPaths={pathSet}
          pending={createMutation.isPending}
          onSubmit={(path, content) => createMutation.mutate({ path, content })}
        />
      </PaneScaffold>
    );
  }

  const isMarkdown = fileQuery.data?.markdown ?? /\.md$/i.test(selectedFile);
  const markdownBlock = isMarkdown ? splitFrontmatterBlock(draft) : null;

  return (
    <PaneScaffold
      title={<SkillPaneTitle skillName={skill.name} folder={currentFolder || "root"} />}
      action={
        <SkillFileActions
          readOnly={readOnly}
          selectedFile={selectedFile}
          currentFolder={currentFolder}
          canDeleteFile={selectedFile !== "SKILL.md"}
          pending={createMutation.isPending || deleteMutation.isPending || dirty}
          onAddFile={() => setCreateDialog("file")}
          onAddFolder={() => setCreateDialog("folder")}
          onDeleteFile={() => deleteMutation.mutate({ path: selectedFile, target: "file" })}
          onDeleteFolder={() => setDeleteFolderOpen(true)}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {dirty && !readOnly ? (
          <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>{l10n("local.unsaved_edits_live_only_in_this_studio_sessio_9484eaf8")}</span>
          </div>
        ) : null}
        <div className="max-h-(--sz-11_75rem) overflow-auto border-b border-border p-1">
          <FileTree
            nodes={nodes}
            selectedFile={selectedFile}
            expandedDirs={expandedDirs}
            onToggleDir={(path) =>
              setExpandedDirs((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onSelectFile={selectFile}
            showCheckboxes={false}
            ariaLabel={l10n("local.skill_files_9c95bd62")}
          />
        </div>
        {readOnly && (
          <div className="flex items-start gap-3 border-b border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p>
                {skill.editableReason ?? l10n("local.this_skill_is_read_only_because_it_comes_from_cc235b68")}
                {" "}{l10n("local.make_an_editable_copy_to_change_it_the_origin_12741dd9")}</p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                onClick={onEditACopy}
              >
                <GitFork className="mr-1.5 h-3.5 w-3.5" />
                {l10n("local.edit_a_copy_10b82721")}</Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <span className="truncate font-mono text-xs text-muted-foreground">
            {selectedFile}
            {skill.currentVersion ? ` · v${skill.currentVersion.revisionNumber}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {readOnly ? (
              <Badge variant="secondary">{l10n("local.read_only_72bb9089")}</Badge>
            ) : (
              <>
                {dirty && <Badge variant="secondary">{l10n("local.unsaved_6250d572")}</Badge>}
                <Button
                  size="sm"
                  disabled={!dirty || saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? l10n("local.saving_23e39291") : l10n("local.save_1509f561")}
                </Button>
              </>
            )}
          </div>
        </div>
        {isMarkdown && markdownBlock?.hasFrontmatter ? (
          <FrontmatterPanel
            key={`fm:${selectedFile}`}
            frontmatterText={markdownBlock.frontmatterText}
            hasFrontmatter={markdownBlock.hasFrontmatter}
            fileName={selectedFile}
            skillSlug={skill.slug}
            readOnly={readOnly}
            onChange={(change) => {
              setDraft((prev) =>
                joinFrontmatterBlock({
                  frontmatterText: change.frontmatterText,
                  body: splitFrontmatterBlock(prev).body,
                  hasFrontmatter: change.hasFrontmatter,
                }),
              );
            }}
          />
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-auto px-3 pb-3"
          onBeforeInputCapture={markBodyInteracted}
          onDropCapture={markBodyInteracted}
          onInput={markBodyInteracted}
          onKeyDownCapture={markBodyInteracted}
          onPasteCapture={markBodyInteracted}
          onPointerDownCapture={markBodyInteracted}
        >
          {isMarkdown && markdownBlock ? (
            <MarkdownEditor
              key={`body:${selectedFile}`}
              value={markdownBlock.body}
              onChange={(nextBody) => {
                // Ignore MDXEditor's on-mount normalization; only apply real edits.
                if (!bodyInteractedRef.current) return;
                setDraft((prev) => {
                  const block = splitFrontmatterBlock(prev);
                  return joinFrontmatterBlock({ ...block, body: nextBody });
                });
              }}
              bordered={false}
              readOnly={readOnly}
              className="min-h-(--sz-320px)"
            />
          ) : (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={readOnly}
              className="min-h-(--sz-320px) font-mono text-xs"
              spellCheck={false}
            />
          )}
        </div>
      </div>
      <SkillPathDialog
        mode={createDialog}
        open={createDialog !== null}
        onOpenChange={(open) => {
          if (!open) setCreateDialog(null);
        }}
        currentFolder={currentFolder}
        existingPaths={pathSet}
        pending={createMutation.isPending}
        onSubmit={(path, content) => createMutation.mutate({ path, content })}
      />
      <DeleteFolderDialog
        open={deleteFolderOpen}
        onOpenChange={setDeleteFolderOpen}
        currentFolder={currentFolder}
        existingPaths={pathSet}
        pending={deleteMutation.isPending}
        onSubmit={(path) => deleteMutation.mutate({ path, target: "folder" })}
      />
    </PaneScaffold>
  );
}

function parentFolder(filePath: string) {
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function normalizeStudioPath(value: string) {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join("/");
}

function folderSeedFile(folderPath: string) {
  return `${folderPath}/README.md`;
}

function folderSeedContent(folderPath: string) {
  const label = folderPath.split("/").filter(Boolean).at(-1) ?? l10n("local.folder_74ccd433");
  return `# ${label}\n`;
}

function SkillPaneTitle({ skillName, folder }: { skillName: string; folder: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{skillName}</span>
      <ChevronRight className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono normal-case tracking-normal">{folder}</span>
    </span>
  );
}

function SkillFileActions({
  readOnly,
  selectedFile,
  canDeleteFile,
  pending,
  onAddFile,
  onAddFolder,
  onDeleteFile,
  onDeleteFolder,
}: {
  readOnly: boolean;
  selectedFile: string;
  currentFolder: string;
  canDeleteFile: boolean;
  pending: boolean;
  onAddFile: () => void;
  onAddFolder: () => void;
  onDeleteFile: () => void;
  onDeleteFolder: () => void;
}) {
  const disabled = readOnly || pending;
  const deleteDisabled = disabled || !canDeleteFile;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFile} aria-label={l10n("local.add_file_2c83c00f")}>
              <FilePlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{l10n("local.add_file_2c83c00f")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onAddFolder} aria-label={l10n("local.add_folder_5bbfc5a6")}>
              <FolderPlus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{l10n("local.add_folder_5bbfc5a6")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={deleteDisabled}
              onClick={() => {
                if (typeof window === "undefined" || window.confirm(l10n("local.delete_value_a19801bb", {v0: (selectedFile)}))) {
                  onDeleteFile();
                }
              }}
              aria-label={l10n("local.delete_file_28e18dc9")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{canDeleteFile ? l10n("local.delete_file_28e18dc9") : l10n("local.skill_md_cannot_be_deleted_6d30e963")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={onDeleteFolder} aria-label={l10n("local.delete_folder_39f35f2d")}>
              <FolderMinus className="h-4 w-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{l10n("local.delete_folder_39f35f2d")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function SkillPathDialog({
  mode,
  open,
  onOpenChange,
  currentFolder,
  existingPaths,
  pending,
  onSubmit,
}: {
  mode: "file" | "folder" | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolder: string;
  existingPaths: Set<string>;
  pending: boolean;
  onSubmit: (path: string, content: string) => void;
}) {
  const [pathValue, setPathValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !mode) return;
    setPathValue(mode === "folder"
      ? normalizeStudioPath(currentFolder ? `${currentFolder}/new-folder` : "new-folder")
      : normalizeStudioPath(currentFolder ? `${currentFolder}/new-file.md` : "notes.md"));
    setError(null);
  }, [currentFolder, mode, open]);

  const title = mode === "folder" ? l10n("local.add_folder_5bbfc5a6") : l10n("local.add_file_2c83c00f");
  const label = mode === "folder" ? l10n("local.folder_path_98bca2fa") : l10n("local.file_path_2fb6d386");

  function submit() {
    if (!mode) return;
    const normalized = normalizeStudioPath(pathValue);
    if (!normalized) {
      setError(l10n("local.value_is_required_22ce83a7", {v0: (label)}));
      return;
    }
    if (mode === "file") {
      if (existingPaths.has(normalized)) {
        setError(l10n("local.a_file_already_exists_at_that_path_036ff1df"));
        return;
      }
      onSubmit(normalized, "");
      return;
    }

    const folderPath = normalized.replace(/\/+$/, "");
    if ([...existingPaths].some((path) => path.startsWith(`${folderPath}/`))) {
      setError(l10n("local.a_folder_already_exists_at_that_path_df1b81d8"));
      return;
    }
    onSubmit(folderSeedFile(folderPath), folderSeedContent(folderPath));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {l10n("local.saved_changes_create_a_new_version_immediatel_08326963")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skill-path-input">{label}</Label>
          <Input
            id="skill-path-input"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setError(null);
            }}
            placeholder={mode === "folder" ? "references/examples" : "references/examples.md"}
          />
          {mode === "folder" ? (
            <p className="text-xs text-muted-foreground">{l10n("local.a_readme_md_seed_file_is_created_so_the_folde_07f10711")}</p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button disabled={pending} onClick={submit}>
            {l10n("local.create_4759498a")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFolderDialog({
  open,
  onOpenChange,
  currentFolder,
  existingPaths,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolder: string;
  existingPaths: Set<string>;
  pending: boolean;
  onSubmit: (path: string) => void;
}) {
  const [pathValue, setPathValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPathValue(currentFolder);
    setError(null);
  }, [currentFolder, open]);

  function submit() {
    const normalized = normalizeStudioPath(pathValue).replace(/\/+$/, "");
    if (!normalized) {
      setError(l10n("local.folder_path_is_required_91bac2ff"));
      return;
    }
    const matchingFiles = [...existingPaths].filter((path) => path.startsWith(`${normalized}/`));
    if (matchingFiles.length === 0) {
      setError(l10n("local.no_files_exist_under_that_folder_358bb187"));
      return;
    }
    if (matchingFiles.includes("SKILL.md")) {
      setError(l10n("local.skill_md_cannot_be_deleted_7504fb92"));
      return;
    }
    onSubmit(normalized);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{l10n("local.delete_folder_39f35f2d")}</DialogTitle>
          <DialogDescription>
            {l10n("local.this_removes_every_skill_file_under_the_folde_20551451")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skill-folder-delete">{l10n("local.folder_path_98bca2fa")}</Label>
          <Input
            id="skill-folder-delete"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setError(null);
            }}
            placeholder="references/examples"
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button variant="destructive" disabled={pending} onClick={submit}>
            {l10n("local.delete_e2d0a549")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Middle — Inputs (path-foldered) + editor + save-as-input
// ---------------------------------------------------------------------------

function InputPane({
  companyId,
  skillId,
  inputs,
  loading,
  selectedInputId,
  adHocMode,
  adHocContent,
  onAdHocChange,
  onSelectInput,
  onSelectAdHoc,
}: {
  companyId: string;
  skillId: string;
  inputs: CompanySkillTestInput[];
  loading: boolean;
  selectedInputId: string | null;
  adHocMode: boolean;
  adHocContent: string;
  onAdHocChange: (value: string) => void;
  onSelectInput: (id: string) => void;
  onSelectAdHoc: () => void;
}) {
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  // The row's menu closes on click, so its copy confirmation goes to a toast.
  const copyWithToast = useCopyToast();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [savedInputDraft, setSavedInputDraft] = useState<SavedInputDraftState>(
    EMPTY_SAVED_INPUT_DRAFT_STATE,
  );
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const selectedInput = inputs.find((i) => i.id === selectedInputId) ?? null;

  // In ad-hoc mode the editor is controlled by the shared shell state; otherwise
  // it edits a local copy of the selected saved input.
  const savedDraft = selectedSavedInputDraft(savedInputDraft, selectedInput);
  const draft = adHocMode ? adHocContent : savedDraft;
  const setDraft = adHocMode
    ? onAdHocChange
    : (value: string) => {
        setSavedInputDraft((previous) => ({
          inputId: selectedInput?.id ?? previous.inputId,
          draft: value,
          baselineContent: selectedInput?.content ?? previous.baselineContent,
        }));
      };

  useEffect(() => {
    if (adHocMode) return;
    setSavedInputDraft((previous) => syncSavedInputDraftState(previous, selectedInput));
  }, [adHocMode, selectedInput?.content, selectedInput?.id]);

  useEffect(() => {
    if (!loading && inputs.length === 0 && !adHocMode && !selectedInputId) {
      onSelectAdHoc();
    }
  }, [adHocMode, inputs.length, loading, onSelectAdHoc, selectedInputId]);

  const nameToId = useMemo(
    () => new Map(inputs.map((i) => [i.name, i.id])),
    [inputs],
  );
  const nodes: FileTreeNode[] = useMemo(
    () => buildFileTree(Object.fromEntries(inputs.map((i) => [i.name, i.content]))),
    [inputs],
  );
  const selectedName = selectedInput?.name ?? null;
  const dirty = !adHocMode && savedInputDraftDirty(savedInputDraft, selectedInput);
  const canSaveSelectedInput = Boolean(selectedInput && dirty && draft.trim());

  const confirmDiscardDirtyInput = useCallback(() => {
    if (!dirty) return true;
    return (
      typeof window === "undefined"
      || window.confirm(l10n("local.discard_unsaved_changes_to_this_input_f3dcc461"))
    );
  }, [dirty]);

  const selectSavedInput = useCallback((id: string) => {
    if (!adHocMode && id === selectedInputId) return;
    if (!confirmDiscardDirtyInput()) return;
    onSelectInput(id);
  }, [adHocMode, confirmDiscardDirtyInput, onSelectInput, selectedInputId]);

  const selectAdHocInput = useCallback(() => {
    if (!adHocMode && !confirmDiscardDirtyInput()) return;
    onSelectAdHoc();
  }, [adHocMode, confirmDiscardDirtyInput, onSelectAdHoc]);

  const updateMutation = useMutation({
    mutationFn: (payload: { content: string }) =>
      companySkillsApi.updateTestInput(companyId, skillId, selectedInput!.id, payload),
    onSuccess: (updated) => {
      setSavedInputDraft({
        inputId: updated.id,
        draft: updated.content,
        baselineContent: updated.content,
      });
      queryClient.setQueryData<CompanySkillTestInput[]>(
        queryKeys.companySkills.testInputs(companyId, skillId),
        (current) => current?.map((input) => input.id === updated.id ? updated : input),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
    },
    onError: onError("Couldn't save input"),
  });
  const deleteMutation = useMutation({
    mutationFn: (inputId: string) => companySkillsApi.deleteTestInput(companyId, skillId, inputId),
    onSuccess: (deleted) => {
      if (deleted.id === selectedInputId) {
        onSelectAdHoc();
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
    },
    onError: onError("Couldn't delete input"),
  });

  return (
    <PaneScaffold
      title={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={collapsed ? l10n("local.expand_input_8999b91a") : l10n("local.collapse_input_55720f6c")}
                onClick={() => setCollapsed((current) => !current)}
              >
                {collapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{collapsed ? l10n("local.expand_input_8999b91a") : l10n("local.collapse_input_55720f6c")}</TooltipContent>
          </Tooltip>
          <span>{l10n("local.input_36ecb4f8")}</span>
        </span>
      }
      action={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={selectAdHocInput} aria-label={l10n("local.new_input_6ab4b774")}>
                <Plus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{l10n("local.new_input_6ab4b774")}</TooltipContent>
          </Tooltip>
        </div>
      }
    >
      {collapsed ? (
        <button
          type="button"
          className="flex min-h-(--sz-32px) items-center gap-2 border-b border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setCollapsed(false)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
          <span>{l10n("local.input_folded_32c15719")}</span>
        </button>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {loading || inputs.length > 0 ? (
            <div className="max-h-(--sz-11_75rem) overflow-auto border-b border-border p-1">
              {loading ? (
                <div className="p-3 text-xs text-muted-foreground">{l10n("local.loading_inputs_828e1062")}</div>
              ) : (
                <>
                  {adHocMode && (
                    <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sm italic text-muted-foreground">
                      <FilePlus className="h-3.5 w-3.5" /> {l10n("local.new_input_not_saved_dfc15bd1")}</div>
                  )}
                  <FileTree
                    nodes={nodes}
                    selectedFile={selectedName}
                    expandedDirs={expandedDirs}
                    onToggleDir={(path) =>
                      setExpandedDirs((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onSelectFile={(name) => {
                      const id = nameToId.get(name);
                      if (id) selectSavedInput(id);
                    }}
                    showCheckboxes={false}
                    renderFileExtra={(node) => {
                      const id = nameToId.get(node.path);
                      if (!id) return null;
                      return (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                              aria-label={l10n("local.input_actions_for_value_f369a858", {v0: (node.name)})}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onClick={() => {
                                const input = inputs.find((i) => i.id === id);
                                if (input) void copyWithToast(input.content, "Input content copied");
                              }}
                            >
                              <Copy className="mr-2 h-4 w-4" /> {l10n("local.copy_content_4ad7ba81")}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => deleteMutation.mutate(id)}
                            >
                              <Trash2 className="mr-2 h-4 w-4" /> {l10n("local.delete_e2d0a549")}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      );
                    }}
                    ariaLabel={l10n("local.test_inputs_0d2e939f")}
                  />
                </>
              )}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={l10n("local.paste_text_treated_as_a_new_issue_description_7be6c2fb")}
              aria-label={l10n("local.skill_test_input_b36f6be0")}
              className="min-h-0 flex-1 resize-none border-0 bg-transparent px-3 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-2">
            <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {selectedInput ? selectedInput.name : adHocMode ? l10n("local.new_input_6ab4b774") : l10n("local.no_input_selected_60e878f7")}
              </span>
              {dirty ? <Badge variant="secondary">{l10n("local.unsaved_6250d572")}</Badge> : null}
            </div>
            {selectedInput && dirty ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={updateMutation.isPending}
                  onClick={() => setSavedInputDraft({
                    inputId: selectedInput.id,
                    draft: selectedInput.content,
                    baselineContent: selectedInput.content,
                  })}
                >
                  {l10n("local.revert_0026c505")}</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canSaveSelectedInput || updateMutation.isPending}
                  onClick={() => updateMutation.mutate({ content: draft })}
                >
                  {updateMutation.isPending ? l10n("local.saving_dc85af8f") : l10n("local.save_changes_dd0ae7a5")}
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              disabled={!draft.trim()}
              onClick={() => setSaveDialogOpen(true)}
            >
              {l10n("local.save_as_input_32f02651")}</Button>
          </div>
        </div>
      )}
      <SaveInputDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        companyId={companyId}
        skillId={skillId}
        initialContent={draft}
        onSaved={(input) => {
          setSaveDialogOpen(false);
          onSelectInput(input.id);
        }}
      />
    </PaneScaffold>
  );
}

function SaveInputDialog({
  open,
  onOpenChange,
  companyId,
  skillId,
  initialContent,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  skillId: string;
  initialContent: string;
  onSaved: (input: CompanySkillTestInput) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [content, setContent] = useState(initialContent);

  useEffect(() => {
    if (open) {
      setContent(initialContent);
      setName("");
    }
  }, [open, initialContent]);

  const createMutation = useMutation({
    mutationFn: () => companySkillsApi.createTestInput(companyId, skillId, { name: name.trim(), content }),
    onSuccess: (input) => {
      queryClient.setQueryData<CompanySkillTestInput[]>(
        queryKeys.companySkills.testInputs(companyId, skillId),
        (current) => {
          const withoutDuplicate = (current ?? []).filter((item) => item.id !== input.id);
          return [...withoutDuplicate, input].sort((a, b) =>
            a.name.localeCompare(b.name) || Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)),
          );
        },
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testInputs(companyId, skillId),
      });
      onSaved(input);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{l10n("local.save_test_input_a94553cb")}</DialogTitle>
          <DialogDescription>
            {l10n("local.runs_snapshot_input_at_run_time_editing_later_66fb8b9b")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="input-name">{l10n("local.name_dcd1d522")}</Label>
            <Input
              id="input-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="onboarding/happy-path"
            />
            <p className="text-xs text-muted-foreground">{l10n("local.use_for_folders_e_g_onboarding_happy_path_51b6a98f")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="input-content">{l10n("local.content_47bd2907")}</Label>
            <Textarea
              id="input-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-(--sz-160px)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button
            disabled={!name.trim() || !content.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {l10n("local.save_1509f561")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Right — agent picker + Run + history + detail
// ---------------------------------------------------------------------------

type RunTemplateDialogState =
  | { mode: "create"; source?: CompanySkillTestRunTemplate | null }
  | { mode: "edit"; source: CompanySkillTestRunTemplate }
  | null;

function RunsPane({
  companyId,
  skill,
  inputs,
  selectedInput,
  adHocMode,
  adHocContent,
  selectedRunId,
  onSelectRun,
  selectedAgentId,
  onSelectAgent,
  skillDirty,
  filterInput,
  onClearFilter,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  inputs: CompanySkillTestInput[];
  selectedInput: CompanySkillTestInput | null;
  adHocMode: boolean;
  adHocContent: string;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  skillDirty: boolean;
  filterInput: CompanySkillTestInput | null;
  onClearFilter: () => void;
}) {
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const toast = useOptionalToastActions();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<RunTemplateSelection>(
    () => loadRunTemplateSelection(companyId),
  );
  const [templateDialog, setTemplateDialog] = useState<RunTemplateDialogState>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const agents = agentsQuery.data ?? [];
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  useEffect(() => {
    setSelectedTemplateId(loadRunTemplateSelection(companyId));
  }, [companyId]);

  const updateTemplateSelection = useCallback((selection: RunTemplateSelection) => {
    setSelectedTemplateId(selection);
    persistRunTemplateSelection(companyId, selection);
  }, [companyId]);

  const templatesQuery = useQuery({
    queryKey: queryKeys.companySkills.testRunTemplates(companyId),
    queryFn: () => companySkillsApi.testRunTemplates(companyId),
    enabled: Boolean(companyId),
  });
  const templates = templatesQuery.data ?? EMPTY_RUN_TEMPLATES;

  useEffect(() => {
    if (!templatesQuery.isSuccess) return;
    const resolution = resolveRunTemplateSelection(selectedTemplateId, templates);
    if (!resolution.recovered) return;
    updateTemplateSelection(resolution.selection);
    toast?.pushToast({
      tone: "warn",
      title: "Run template reset",
      body: "The saved run template is no longer available. Default test template is selected.",
      dedupeKey: `skill-studio-template-reset:${companyId}`,
    });
  }, [
    companyId,
    selectedTemplateId,
    templates,
    templatesQuery.isSuccess,
    toast,
    updateTemplateSelection,
  ]);

  const filterInputId = filterInput?.id ?? null;
  const runsQuery = useQuery({
    queryKey: queryKeys.companySkills.testRuns(companyId, skillId, filterInputId),
    queryFn: () =>
      companySkillsApi.testRuns(companyId, skillId, filterInputId ? { inputId: filterInputId } : {}),
    enabled: Boolean(companyId && skillId),
    refetchInterval: (query) => {
      const data = query.state.data as CompanySkillTestRun[] | undefined;
      return data?.some((r) => shouldPollRun(r.status)) ? POLL_MS : false;
    },
  });
  const runs = runsQuery.data ?? [];

  const hasInput = adHocMode ? adHocContent.trim().length > 0 : Boolean(selectedInput?.content.trim());
  const gate = evaluateRunGate({
    hasAgent: Boolean(selectedAgent),
    hasInput,
    skillFileCount: skill.fileInventory.length,
    hasUnsavedSkillEdits: skillDirty,
  });
  const templateGateReason = templatesQuery.isLoading
    ? "Loading run templates"
    : templatesQuery.isError
      ? "Run templates couldn't load"
      : null;

  const createTemplateMutation = useMutation({
    mutationFn: (payload: CompanySkillTestRunTemplateCreateRequest) =>
      companySkillsApi.createTestRunTemplate(companyId, payload),
    onSuccess: (template) => {
      setTemplateDialog(null);
      updateTemplateSelection(template.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: "Template saved",
        body: `${template.name} is ready for Skills Studio runs.`,
      });
    },
    onError: onError("Couldn't save template"),
  });

  const updateTemplateMutation = useMutation({
    mutationFn: ({ templateId, payload }: {
      templateId: string;
      payload: CompanySkillTestRunTemplateUpdateRequest;
    }) => companySkillsApi.updateTestRunTemplate(companyId, templateId, payload),
    onSuccess: (template) => {
      setTemplateDialog(null);
      updateTemplateSelection(template.id);
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: "Template updated",
        body: `${template.name} is ready for Skills Studio runs.`,
      });
    },
    onError: onError("Couldn't update template"),
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (templateId: string) => companySkillsApi.deleteTestRunTemplate(companyId, templateId),
    onSuccess: (template) => {
      const fallback = resolveRunTemplateSelection(selectedTemplateId, templates.filter((entry) => entry.id !== template.id));
      if (selectedTemplateId === template.id || fallback.recovered) {
        updateTemplateSelection(fallback.selection);
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunTemplates(companyId),
      });
      toast?.pushToast({
        tone: "success",
        title: "Template deleted",
        body: `${template.name} was removed from Skills Studio runs.`,
      });
    },
    onError: onError("Couldn't delete template"),
  });

  const selectedTemplate = selectedTemplateId === null
    ? null
    : templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedTemplateName = selectedTemplateId === null
    ? "No template"
    : selectedTemplate?.name ?? "Default test template";
  const runDisabledReason = gate.reason ?? templateGateReason;

  const createRunMutation = useMutation({
    mutationFn: () => {
      if (!templatesQuery.isSuccess) {
        throw new Error(templateGateReason ?? "Run templates are not ready.");
      }
      const resolution = resolveRunTemplateSelection(selectedTemplateId, templates);
      if (resolution.recovered) {
        updateTemplateSelection(resolution.selection);
        throw new Error("Selected run template is no longer available. The selection was reset.");
      }
      return companySkillsApi.createTestRun(companyId, skillId, buildCreateRunRequest({
        agentId: selectedAgentId!,
        inputId: adHocMode ? null : selectedInput?.id ?? null,
        content: adHocMode ? adHocContent : selectedInput ? null : adHocContent,
        templateId: resolution.selection,
      }));
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRuns(companyId, skillId, filterInputId),
      });
      onSelectRun(run.id);
    },
    onError: onError("Couldn't start run"),
  });

  if (selectedRunId) {
    return (
      <RunDetailView
        companyId={companyId}
        skill={skill}
        runId={selectedRunId}
        agents={agents}
        onBack={() => onSelectRun(null)}
        onSelectRun={onSelectRun}
      />
    );
  }

  return (
    <PaneScaffold
      title={l10n("local.test_runs_70b86f32")}
      action={
        <div className="flex items-center gap-2">
          <AgentPicker
            agents={agents}
            selectedAgent={selectedAgent}
            onSelect={onSelectAgent}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper keeps the tooltip reachable while the button is disabled */}
              <span>
                <Button
                  size="sm"
                  disabled={gate.disabled || Boolean(templateGateReason) || createRunMutation.isPending}
                  onClick={() => createRunMutation.mutate()}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" /> {l10n("local.run_00d60e31")}</Button>
              </span>
            </TooltipTrigger>
            {runDisabledReason && <TooltipContent side="bottom">{runDisabledReason}</TooltipContent>}
          </Tooltip>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <RunTemplateAdvancedPanel
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          templates={templates}
          templatesLoading={templatesQuery.isLoading}
          templatesError={templatesQuery.isError}
          selectedTemplateId={selectedTemplateId}
          selectedTemplate={selectedTemplate}
          selectedTemplateName={selectedTemplateName}
          onSelectTemplate={updateTemplateSelection}
          onCreateTemplate={() => setTemplateDialog({ mode: "create" })}
          onEditTemplate={(template) => setTemplateDialog({ mode: "edit", source: template })}
          onDuplicateTemplate={(template) => setTemplateDialog({ mode: "create", source: template })}
          onDeleteTemplate={(template) => {
            if (
              typeof window !== "undefined"
              && !window.confirm(l10n("local.delete_run_template_value_dad148aa", {v0: (template.name)}))
            ) {
              return;
            }
            deleteTemplateMutation.mutate(template.id);
          }}
          deletingTemplateId={deleteTemplateMutation.variables ?? null}
          actionPending={
            createTemplateMutation.isPending
            || updateTemplateMutation.isPending
            || deleteTemplateMutation.isPending
          }
        />
        {filterInput && (
          <div className="px-3 pt-2">
            <FilterBar
              filters={[{ key: "input", label: l10n("local.input_36ecb4f8"), value: filterInput.name }]}
              onRemove={onClearFilter}
              onClear={onClearFilter}
            />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {runsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">{l10n("local.loading_runs_8438ea39")}</div>
          ) : runs.length === 0 ? (
            <EmptyState icon={FlaskConical} message="No test runs yet. Pick an agent and Run." />
          ) : (
            <div className="space-y-1 rounded-md border border-border p-1">
              {runs.map((run) => (
                <RunHistoryRow
                  key={run.id}
                  run={run}
                  agents={agents}
                  onSelect={() => onSelectRun(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <RunTemplateDialog
        state={templateDialog}
        pending={createTemplateMutation.isPending || updateTemplateMutation.isPending}
        onOpenChange={(open) => {
          if (!open) setTemplateDialog(null);
        }}
        onSubmit={(payload) => {
          if (templateDialog?.mode === "edit") {
            updateTemplateMutation.mutate({ templateId: templateDialog.source.id, payload });
          } else {
            createTemplateMutation.mutate(payload);
          }
        }}
      />
    </PaneScaffold>
  );
}

type RunTemplateOption = SearchableSelectOption<string> & {
  description: string | null;
  builtIn: boolean;
};

function runTemplateOptionValue(selection: RunTemplateSelection) {
  return selection ?? NO_TEST_RUN_TEMPLATE_STORAGE_VALUE;
}

function runTemplateSelectionFromOption(value: string): RunTemplateSelection {
  return value === NO_TEST_RUN_TEMPLATE_STORAGE_VALUE ? null : value;
}

function RunTemplateAdvancedPanel({
  open,
  onOpenChange,
  templates,
  templatesLoading,
  templatesError,
  selectedTemplateId,
  selectedTemplate,
  selectedTemplateName,
  onSelectTemplate,
  onCreateTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  deletingTemplateId,
  actionPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: CompanySkillTestRunTemplate[];
  templatesLoading: boolean;
  templatesError: boolean;
  selectedTemplateId: RunTemplateSelection;
  selectedTemplate: CompanySkillTestRunTemplate | null;
  selectedTemplateName: string;
  onSelectTemplate: (selection: RunTemplateSelection) => void;
  onCreateTemplate: () => void;
  onEditTemplate: (template: CompanySkillTestRunTemplate) => void;
  onDuplicateTemplate: (template: CompanySkillTestRunTemplate) => void;
  onDeleteTemplate: (template: CompanySkillTestRunTemplate) => void;
  deletingTemplateId: string | null;
  actionPending: boolean;
}) {
  const templateGroups = useMemo<readonly SearchableSelectGroup<string, RunTemplateOption>[]>(() => {
    const noTemplateOption: RunTemplateOption = {
      key: "no-template",
      value: NO_TEST_RUN_TEMPLATE_STORAGE_VALUE,
      label: "No template",
      title: "No template",
      description: "Run only the input text.",
      builtIn: true,
      searchText: "no template plain input",
    };
    const toOption = (template: CompanySkillTestRunTemplate): RunTemplateOption => ({
      key: template.id,
      value: template.id,
      label: template.name,
      title: template.name,
      description: template.description,
      builtIn: template.builtIn,
      searchText: [template.name, template.description ?? "", template.builtIn ? "built in" : "custom"].join(" "),
    });
    const builtIn = templates.filter((template) => template.builtIn).map(toOption);
    const custom = templates.filter((template) => !template.builtIn).map(toOption);
    return [
      { id: "built-in", label: l10n("local.built_in_78a6a8fe"), options: [noTemplateOption, ...builtIn] },
      ...(custom.length > 0 ? [{ id: "custom", label: l10n("local.custom_494ca78f"), options: custom }] : []),
    ];
  }, [templates]);

  const selectedValue = runTemplateOptionValue(selectedTemplateId);
  const selectedMissing = selectedTemplateId !== null && !selectedTemplate && !templatesLoading;
  const canEdit = Boolean(selectedTemplate && !selectedTemplate.builtIn);
  const canDuplicate = Boolean(selectedTemplate);
  const canDelete = Boolean(selectedTemplate && !selectedTemplate.builtIn);

  return (
    <div className="border-b border-border">
      <button
        type="button"
        className="flex min-h-(--sz-32px) w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => onOpenChange(!open)}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <span className="font-semibold uppercase tracking-wide">{l10n("local.advanced_9f088dbe")}</span>
        <span className="ml-auto truncate">{selectedTemplateName}</span>
      </button>
      {open ? (
        <div className="space-y-3 px-3 pb-3 pt-1">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label>{l10n("local.run_template_b940a3fb")}</Label>
              <SearchableSelect<string, RunTemplateOption>
                value={selectedValue}
                groups={templateGroups}
                loading={templatesLoading}
                disabled={templatesLoading || templatesError}
                loadingMessage={l10n("local.loading_templates_8b316924")}
                placeholder={l10n("local.select_template_8e56330b")}
                searchPlaceholder={l10n("local.search_templates_79760c54")}
                emptyMessage={l10n("local.no_templates_1c9dddad")}
                contentClassName="w-(--sz-320px)"
                onValueChange={(value) => onSelectTemplate(runTemplateSelectionFromOption(value))}
                renderValue={(option) => option?.label ?? selectedTemplateName}
                renderOption={(option, { selected }) => (
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("truncate", selected && "font-medium")}>{option.label}</span>
                    <span className="truncate text-(length:--text-micro) text-muted-foreground">
                      {option.description ?? (option.builtIn ? l10n("local.built_in_78a6a8fe") : l10n("local.custom_494ca78f"))}
                    </span>
                  </span>
                )}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={l10n("local.create_run_template_1306b1ea")}
                  disabled={actionPending}
                  onClick={onCreateTemplate}
                >
                  <Plus />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{l10n("local.create_run_template_1306b1ea")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={l10n("local.edit_run_template_2842f471")}
                    disabled={!canEdit || actionPending}
                    onClick={() => selectedTemplate && onEditTemplate(selectedTemplate)}
                  >
                    <Pencil />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{l10n("local.edit_custom_template_72b92d09")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={l10n("local.duplicate_run_template_d75ef08f")}
                    disabled={!canDuplicate || actionPending}
                    onClick={() => selectedTemplate && onDuplicateTemplate(selectedTemplate)}
                  >
                    <Copy />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {selectedTemplate?.builtIn ? l10n("local.duplicate_built_in_template_4b61c8e8") : l10n("local.duplicate_template_b876040a")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={l10n("local.delete_run_template_de584e70")}
                    className="text-destructive hover:text-destructive"
                    disabled={!canDelete || actionPending || deletingTemplateId === selectedTemplate?.id}
                    onClick={() => selectedTemplate && onDeleteTemplate(selectedTemplate)}
                  >
                    <Trash2 />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{l10n("local.delete_custom_template_08edc092")}</TooltipContent>
            </Tooltip>
          </div>

          {templatesError ? (
            <p className="text-xs text-destructive">{l10n("local.run_templates_could_not_load_b698b60f")}</p>
          ) : selectedTemplateId === null ? (
            <p className="text-xs text-muted-foreground">{l10n("local.runs_will_use_only_the_input_text_dcda7d05")}</p>
          ) : selectedMissing ? (
            <p className="text-xs text-destructive">{l10n("local.selected_template_is_no_longer_available_3fb121a0")}</p>
          ) : selectedTemplate ? (
            <div className="space-y-2">
              {selectedTemplate.description ? (
                <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
              ) : null}
              <pre className="max-h-(--sz-240px) overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                {selectedTemplate.body}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{l10n("local.loading_template_f687834d")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function RunTemplateDialog({
  state,
  pending,
  onOpenChange,
  onSubmit,
}: {
  state: RunTemplateDialogState;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CompanySkillTestRunTemplateCreateRequest) => void;
}) {
  const source = state?.source ?? null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!state) return;
    setName(state.mode === "edit" ? source?.name ?? "" : source ? `${source.name} copy` : "");
    setDescription(source?.description ?? "");
    setBody(source?.body ?? "");
  }, [source, state]);

  const title = state?.mode === "edit"
    ? l10n("local.edit_run_template_2842f471")
    : source?.builtIn
      ? l10n("local.duplicate_built_in_template_4b61c8e8")
      : l10n("local.create_run_template_1306b1ea");
  const descriptionText = state?.mode === "edit"
    ? l10n("local.update_the_custom_run_instructions_used_by_sk_430b00cb")
    : l10n("local.save_reusable_run_instructions_for_skills_stu_1cda9529");

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{descriptionText}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="run-template-name">{l10n("local.name_dcd1d522")}</Label>
            <Input
              id="run-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={l10n("local.focused_smoke_791d5c0f")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-template-description">{l10n("local.description_526e0087")}</Label>
            <Input
              id="run-template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={l10n("local.short_instructions_for_common_skill_checks_d03d6192")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="run-template-body">{l10n("local.body_6ccaa641")}</Label>
            <Textarea
              id="run-template-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              className="min-h-(--sz-240px) font-mono text-xs leading-5"
            />
            <p className="text-xs text-muted-foreground">
              {l10n("local.placeholders_f28f35e8")}{" "}{"{{skillName}}"}, {"{{skillKey}}"}, {"{{skillInvocation}}"}, {"{{skillVersion}}"}, {"{{runId}}"}, {"{{issueId}}"}, {"{{outputDocumentKey}}"}.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {l10n("local.cancel_19766ed6")}</Button>
          <Button
            disabled={!name.trim() || !body.trim() || pending}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                description: description.trim() || null,
                body,
              })
            }
          >
            {pending ? l10n("local.saving_dc85af8f") : l10n("local.save_template_47f72a2f")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunHistoryRow({
  run,
  agents,
  onSelect,
}: {
  run: CompanySkillTestRun;
  agents: Agent[];
  onSelect: () => void;
}) {
  const agent = agents.find((a) => a.id === run.agentId) ?? null;
  const removed = !agent;
  const snapshotName =
    (run.agentConfigSnapshot?.name as string | undefined) ?? "Agent";
  const name = agent?.name ?? snapshotName;
  return (
    <EntityRow
      leading={<StatusBadge status={runBadgeStatus(run.status)} />}
      identifier={runShortId(run)}
      title={removed ? l10n("local.value_removed_33092e12", {v0: (name)}) : name}
      subtitle={relativeTime(run.createdAt)}
      trailing={
        <span className="font-mono text-xs text-muted-foreground">
          {formatCents(run.cost.costCents)}
        </span>
      }
      onClick={onSelect}
    />
  );
}

function AgentPicker({
  agents,
  selectedAgent,
  onSelect,
}: {
  agents: Agent[];
  selectedAgent: Agent | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          {selectedAgent ? (
            <AgentIdentity agent={selectedAgent} size="xs" />
          ) : (
            <span className="text-muted-foreground">{l10n("local.pick_an_agent_012c15d6")}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={l10n("local.search_agents_e05cb78e")} />
          <CommandList>
            <CommandEmpty>{l10n("local.no_agents_04e3179b")}</CommandEmpty>
            <CommandGroup>
              {agents.map((agent) => {
                const selectable = isAgentSelectable(agent);
                return (
                  <CommandItem
                    key={agent.id}
                    value={agent.name}
                    disabled={!selectable}
                    onSelect={() => {
                      if (!selectable) return;
                      onSelect(agent.id);
                      setOpen(false);
                    }}
                    className={cn("flex items-center gap-2", !selectable && "opacity-50")}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selectable ? "bg-green-500" : "bg-orange-400",
                      )}
                      aria-hidden
                    />
                    <AgentIdentity agent={agent} size="xs" />
                    {!selectable && (
                      <Badge variant="secondary" className="ml-auto">
                        {l10n("local.paused_e159b061")}</Badge>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------

function RunDetailView({
  companyId,
  skill,
  runId,
  agents,
  onBack,
  onSelectRun,
}: {
  companyId: string;
  skill: CompanySkillDetail;
  runId: string;
  agents: Agent[];
  onBack: () => void;
  onSelectRun: (id: string | null) => void;
}) {
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const onError = useMutationErrorToast();
  const detailQuery = useQuery({
    queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
    queryFn: () => companySkillsApi.testRunDetail(companyId, skillId, runId),
    enabled: Boolean(companyId && skillId && runId),
    refetchInterval: (query) => {
      const data = query.state.data as CompanySkillTestRunDetail | undefined;
      return data && shouldPollRun(data.status) ? POLL_MS : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => companySkillsApi.cancelTestRun(companyId, skillId, runId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
      }),
    onError: onError("Couldn't cancel run"),
  });

  // Re-run reproduces the VIEWED run's snapshots — pinned skill version, saved
  // input (or the ad-hoc snapshot), and agent — rather than whatever the picker
  // happens to hold this session (PAP-13001 Bug A). Reading detailQuery.data at
  // mutate() time keeps the hook order stable across the loading guards below.
  const reRunMutation = useMutation({
    mutationFn: () => {
      const d = detailQuery.data;
      if (!d) throw new Error("Run details are still loading.");
      return companySkillsApi.createTestRun(companyId, skillId, buildReRunRequest(d));
    },
    onSuccess: (run) => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(run.id);
    },
    onError: onError("Couldn't re-run"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => companySkillsApi.deleteTestRun(companyId, skillId, runId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["company-skills", companyId, skillId, "test-runs"],
      });
      onSelectRun(null);
    },
    onError: onError("Couldn't delete run"),
  });

  const detail = detailQuery.data ?? null;
  const additionalDocuments = useMemo(() => detail ? getRunAdditionalDocuments(detail) : [], [detail]);
  const rawAttachments = useMemo(() => detail ? getRunRawAttachments(detail) : [], [detail]);
  const unavailableCopy = useMemo(() => detail ? runHarnessUnavailableCopy(detail) : null, [detail]);
  const mediaGalleryItems = useMemo<GalleryMediaItem[]>(
    () => detail ? getRunMediaGalleryItems(detail) : [],
    [detail],
  );
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);

  if (detailQuery.isLoading) {
    return (
      <PaneScaffold title={l10n("local.run_00d60e31")} action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">{l10n("local.loading_run_ad8b3027")}</div>
      </PaneScaffold>
    );
  }
  if (!detail) {
    return (
      <PaneScaffold title={l10n("local.run_00d60e31")} action={<BackButton onBack={onBack} />}>
        <div className="p-3 text-xs text-muted-foreground">{l10n("local.run_not_found_3e498fa2")}</div>
      </PaneScaffold>
    );
  }

  const agent = agents.find((a) => a.id === detail.agentId) ?? null;
  const agentName =
    agent?.name ?? (detail.agentConfigSnapshot?.name as string | undefined) ?? "Agent";
  const removed = !agent;
  const outputMode = runOutputMode(detail);
  const nonTerminal = !isTerminalRunStatus(detail.status);
  const taskLink = testTaskLinkState(detail);

  return (
    <PaneScaffold title={l10n("local.run_00d60e31")} action={<BackButton onBack={onBack} />}>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={runBadgeStatus(detail.status)} />
          <AgentIdentity agent={agent ?? { id: detail.agentId, name: agentName }} size="xs" />
          {removed && <Badge variant="secondary">{l10n("local.removed_e1f79758")}</Badge>}
          <span className="font-mono text-xs text-muted-foreground">
            v{detail.skillVersion.revisionNumber}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {formatCents(detail.cost.costCents)}
          </span>
        </div>

        {/* snapshot property block */}
        <div className="rounded-md border border-border text-xs">
          <PropRow label={l10n("local.input_36ecb4f8")} value={detail.inputId ? "saved input" : "ad-hoc paste"} />
          <PropRow label={l10n("local.template_0575f29d")} value={detail.templateName ?? "No template"} />
          <PropRow label={l10n("local.skill_version_4ba07298")} value={`v${detail.skillVersion.revisionNumber}`} />
          <PropRow label={l10n("local.created_d70b9e24")} value={relativeTime(detail.createdAt)} />
        </div>

        {showRunErrorCard(detail.status) && (
          <Card className="border-destructive/50">
            <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-sm font-medium">{l10n("local.run_failed_97fddf2d")}</span>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {detail.error ?? l10n("local.the_test_task_ended_with_an_error_5c8600f3")}
            </CardContent>
          </Card>
        )}

        {/* Output snapshot / draft-at-failure */}
        {outputMode === "output" || outputMode === "draft" ? (
          <section className="space-y-2">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {outputMode === "draft" ? l10n("local.draft_at_failure_39d035d4") : l10n("local.output_snapshot_1a9c81c2")}
            </h3>
            <div className="rounded-md border border-border p-3">
              <MarkdownBody>{detail.outputBody || l10n("local._no_output_f1361846")}</MarkdownBody>
            </div>
          </section>
        ) : outputMode === "pending" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {l10n("local.working_output_will_appear_here_b716072f")}</div>
        ) : null}

        {unavailableCopy ? (
          <RunHarnessUnavailableNotice copy={unavailableCopy} />
        ) : null}

        {additionalDocuments.length > 0 ? (
          <RunDocumentsSection documents={additionalDocuments} />
        ) : null}

        <IssueOutputSection
          workProducts={detail.harnessContent.workProducts}
          onMediaClick={(item) => {
            const meta = item.metadata;
            if (!meta) return;
            const idx = mediaGalleryItems.findIndex((galleryItem) => (
              galleryItem.contentPath === meta.contentPath ||
              galleryItem.id === `work-product-${item.id}` ||
              galleryItem.id === meta.attachmentId
            ));
            setGalleryIndex(idx >= 0 ? idx : 0);
            setGalleryOpen(true);
          }}
        />

        {rawAttachments.length > 0 ? (
          <IssueAttachmentsSection
            attachments={rawAttachments}
            onImageClick={(attachment) => {
              const idx = mediaGalleryItems.findIndex((item) => (
                item.id === attachment.id || item.contentPath === attachment.contentPath
              ));
              setGalleryIndex(idx >= 0 ? idx : 0);
              setGalleryOpen(true);
            }}
          />
        ) : null}

        {/* Interactions */}
        <InteractionSection
          companyId={companyId}
          detail={detail}
          agents={agents}
          onAnswered={() =>
            queryClient.invalidateQueries({
              queryKey: queryKeys.companySkills.testRunDetail(companyId, skillId, runId),
            })
          }
        />

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={reRunMutation.isPending}
            onClick={() => reRunMutation.mutate()}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> {l10n("local.re_run_31e1d3ec")}</Button>
          {nonTerminal ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {l10n("local.cancel_19766ed6")}</Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> {l10n("local.delete_e2d0a549")}</Button>
          )}
          {taskLink.enabled && detail.harnessIssue ? (
            <Button variant="link" size="sm" asChild>
              <Link to={`/issues/${detail.harnessIssue.id}`}>{l10n("local.open_test_task_0c16eec1")}</Link>
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-not-allowed text-xs text-muted-foreground">
                  {l10n("local.open_test_task_0c16eec1")}</span>
              </TooltipTrigger>
              <TooltipContent>{taskLink.reason}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <ImageGalleryModal
          items={mediaGalleryItems}
          initialIndex={galleryIndex}
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
        />
      </div>
    </PaneScaffold>
  );
}

function RunHarnessUnavailableNotice({
  copy,
}: {
  copy: NonNullable<ReturnType<typeof runHarnessUnavailableCopy>>;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-foreground">{copy.title}</p>
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
    </div>
  );
}

function RunDocumentsSection({ documents }: { documents: IssueDocument[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium text-muted-foreground">{l10n("local.documents_b4e929d8")}</h3>
        <span className="text-xs text-muted-foreground">{documents.length}</span>
      </div>
      <div className="space-y-2">
        {documents.map((document) => (
          <article key={document.id} className="rounded-md border border-border p-3">
            <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">
                {document.title ?? document.key}
              </span>
              <span className="ml-auto shrink-0">{relativeTime(document.updatedAt)}</span>
            </div>
            <MarkdownBody className="paperclip-edit-in-place-content text-sm leading-7" softBreaks={false}>
              {document.body}
            </MarkdownBody>
          </article>
        ))}
      </div>
    </section>
  );
}

function InteractionSection({
  companyId,
  detail,
  agents,
  onAnswered,
}: {
  companyId: string;
  detail: CompanySkillTestRunDetail;
  agents: Agent[];
  onAnswered: () => void;
}) {
  const harnessIssueId = detail.harnessIssue?.id ?? null;
  const hasInlineAnswerable = detail.interactions.some((i) => isInteractionAnswerable(i));

  // Only fetch the full interaction objects (needed to render answerable cards)
  // when there is at least one pending inline interaction on a live harness issue.
  const fullQuery = useQuery({
    queryKey: ["skill-studio", "interactions", harnessIssueId],
    queryFn: () => issuesApi.listInteractions(harnessIssueId!),
    enabled: Boolean(harnessIssueId && hasInlineAnswerable),
    refetchInterval: hasInlineAnswerable ? POLL_MS : false,
  });
  const fullById = useMemo(
    () => new Map((fullQuery.data ?? []).map((i) => [i.id, i])),
    [fullQuery.data],
  );
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const accept = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; optionIds?: string[] }) =>
      issuesApi.acceptInteraction(harnessIssueId!, vars.interaction.id, {
        selectedOptionIds: vars.optionIds,
      }),
    onSuccess: onAnswered,
  });
  const respond = useMutation({
    mutationFn: (vars: { interaction: AskUserQuestionsInteraction; answers: AskUserQuestionsAnswer[] }) =>
      issuesApi.respondToInteraction(harnessIssueId!, vars.interaction.id, { answers: vars.answers }),
    onSuccess: onAnswered,
  });
  const reject = useMutation({
    mutationFn: (vars: { interaction: IssueThreadInteraction; reason?: string }) =>
      issuesApi.rejectInteraction(harnessIssueId!, vars.interaction.id, vars.reason),
    onSuccess: onAnswered,
  });

  if (detail.interactions.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {l10n("local.interactions_9089e4b7")}</h3>
      <div className="space-y-2">
        {detail.interactions.map((summary) => {
          const inline = routeInteraction(summary.kind) === "inline";
          const full = fullById.get(summary.id);
          if (inline && full) {
            return (
              <IssueThreadInteractionCard
                key={summary.id}
                interaction={full}
                agentMap={agentMap}
                onAcceptInteraction={async (interaction, _keys, optionIds) => {
                  await accept.mutateAsync({ interaction, optionIds });
                }}
                onRejectInteraction={async (interaction, reason) => {
                  await reject.mutateAsync({ interaction, reason });
                }}
                onSubmitInteractionAnswers={async (interaction, answers) => {
                  await respond.mutateAsync({ interaction, answers });
                }}
              />
            );
          }
          // Fallback: summary row + open-test-task link (never dropped).
          return (
            <EntityRow
              key={summary.id}
              title={summary.title}
              subtitle={`${summary.kind} · ${summary.status}`}
              trailing={
                harnessIssueId ? (
                  <Button variant="link" size="xs" asChild>
                    <Link to={`/issues/${harnessIssueId}`}>{l10n("local.open_test_task_0c16eec1")}</Link>
                  </Button>
                ) : null
              }
            />
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Version history drawer
// ---------------------------------------------------------------------------

function VersionHistorySheet({
  open,
  onOpenChange,
  companyId,
  skill,
  onRestored,
  onFilterRuns,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  skill: CompanySkillDetail;
  onRestored: () => void;
  onFilterRuns: (inputId: string) => void;
}) {
  const skillId = skill.id;
  const queryClient = useQueryClient();
  const versionsQuery = useQuery({
    queryKey: queryKeys.companySkills.versions(companyId, skillId),
    queryFn: () => companySkillsApi.versions(companyId, skillId),
    enabled: open && Boolean(companyId && skillId),
  });
  const versions = versionsQuery.data ?? [];
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async (version: CompanySkillVersion) => {
      // Restore = write each file from the chosen version back, then cut a new
      // head version (immutability: never rewrites history).
      for (const file of version.fileInventory) {
        await companySkillsApi.updateFile(companyId, skillId, file.path, file.content);
      }
      return companySkillsApi.createVersion(companyId, skillId, {
        label: `Restore of v${version.revisionNumber}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companySkills.versions(companyId, skillId) });
      onRestored();
    },
  });

  const left = versions.find((v) => v.id === leftId) ?? null;
  const right = versions.find((v) => v.id === rightId) ?? null;
  const diff = left && right ? buildLineDiff(
    left.fileInventory.map((f) => `# ${f.path}\n${f.content}`).join("\n\n"),
    right.fileInventory.map((f) => `# ${f.path}\n${f.content}`).join("\n\n"),
  ) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full sm:max-w-(--sz-560px)">
        <SheetHeader>
          <SheetTitle>{l10n("local.version_history_a6df11e7")}</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-2 overflow-auto">
          {versionsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">{l10n("local.loading_versions_9780e2c9")}</div>
          ) : versions.length === 0 ? (
            <EmptyState icon={History} message="No versions yet. Save changes to create the first." />
          ) : (
            <div className="space-y-1 rounded-md border border-border p-1">
              {versions.map((v) => (
                <EntityRow
                  key={v.id}
                  identifier={`v${v.revisionNumber}`}
                  title={v.label ?? l10n("local.version_value_be51d2b6", {v0: (v.revisionNumber)})}
                  subtitle={relativeTime(v.createdAt)}
                  selected={v.id === leftId || v.id === rightId}
                  onClick={() => {
                    // click to build a two-version diff selection
                    if (!leftId) setLeftId(v.id);
                    else if (!rightId && v.id !== leftId) setRightId(v.id);
                    else {
                      setLeftId(v.id);
                      setRightId(null);
                    }
                  }}
                  trailing={
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={restore.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        restore.mutate(v);
                      }}
                    >
                      {l10n("local.restore_as_v_4944ba44")}{(skill.currentVersion?.revisionNumber ?? v.revisionNumber) + 1}
                    </Button>
                  }
                />
              ))}
            </div>
          )}
          {diff && (
            <div className="rounded-md border border-border">
              <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                {l10n("local.diff_v_97888195")}{left?.revisionNumber} → v{right?.revisionNumber}
              </div>
              <pre className="max-h-64 overflow-auto p-2 text-xs">
                {diff.map((row, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap",
                      row.kind === "added" && "bg-green-500/10 text-green-700 dark:text-green-300",
                      row.kind === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300",
                    )}
                  >
                    {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                    {row.text}
                  </div>
                ))}
              </pre>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function PaneScaffold({
  title,
  action,
  children,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {action}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> {l10n("local.back_76900f1b")}</Button>
  );
}

function MobileTabs({
  skill,
  input,
  runs,
}: {
  skill: React.ReactNode;
  input: React.ReactNode;
  runs: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="skill" className="flex flex-1 flex-col">
      <TabsList variant="line" className="px-3">
        <TabsTrigger value="skill">{l10n("local.skill_6df1bb18")}</TabsTrigger>
        <TabsTrigger value="input">{l10n("local.input_36ecb4f8")}</TabsTrigger>
        <TabsTrigger value="runs">{l10n("local.runs_848f54e8")}</TabsTrigger>
      </TabsList>
      <TabsContent value="skill" className="min-h-0 flex-1">
        {skill}
      </TabsContent>
      <TabsContent value="input" className="min-h-0 flex-1">
        {input}
      </TabsContent>
      <TabsContent value="runs" className="min-h-0 flex-1">
        {runs}
      </TabsContent>
    </Tabs>
  );
}
