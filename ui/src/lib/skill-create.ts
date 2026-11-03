import type {
  CompanySkillCreateRequest,
  CompanySkillDetail,
  CompanySkillSharingScope,
} from "@paperclipai/shared";

export const SKILL_CREATE_ACCENTS = [
  "#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#22c55e",
  "#3b82f6", "#a855f7",
];

export type SkillCreateDraft = {
  name: string;
  slug: string;
  tagline: string;
  description: string;
  color: string;
  categories: string[];
  markdown: string;
  sharingScope: Exclude<CompanySkillSharingScope, "public_link">;
  forkedFromSkillId: string | null;
  forkedFromName: string | null;
  /** Destination folder for the new skill (null = Unfiled / top level). */
  folderId: string | null;
};

export function normalizeSkillDraftSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function splitCategoryDraft(value: string) {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const entry of value.split(",")) {
    const category = entry.trim().replace(/\s+/g, " ");
    if (!category) continue;
    const key = category.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
  }
  return categories;
}

export function defaultSkillMarkdown(name: string, tagline: string) {
  const title = name.trim() || "新技能";
  const summary = tagline.trim() || "说明智能体应在什么情况下使用此技能。";
  return [
    "---",
    `name: ${title}`,
    `description: ${summary}`,
    "---",
    "",
    `# ${title}`,
    "",
    summary,
    "",
    "## 使用场景",
    "",
    "- 当任务需要此技能提供的专用流程时使用。",
    "",
    "## 工作流程",
    "",
    "1. 检查任务上下文。",
    "2. 严格执行工作流程。",
    "3. 说明改动内容与验证结果。",
    "",
  ].join("\n");
}

export function skillAccentColor(key: string, explicit: string | null | undefined): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return SKILL_CREATE_ACCENTS[hash % SKILL_CREATE_ACCENTS.length]!;
}

export function buildBlankSkillDraft(): SkillCreateDraft {
  return {
    name: "",
    slug: "",
    tagline: "",
    description: "",
    color: SKILL_CREATE_ACCENTS[0]!,
    categories: [],
    markdown: defaultSkillMarkdown("", ""),
    sharingScope: "company",
    forkedFromSkillId: null,
    forkedFromName: null,
    folderId: null,
  };
}

export function buildForkSkillDraft(skill: CompanySkillDetail): SkillCreateDraft {
  const name = `${skill.name} Fork`;
  const slug = normalizeSkillDraftSlug(`${skill.slug}-fork`);
  return {
    name,
    slug,
    tagline: skill.tagline ?? "",
    description: skill.description ?? "",
    color: skill.color ?? skillAccentColor(skill.key, null),
    categories: skill.categories,
    markdown: skill.markdown.replace(/^name:\s*.*$/m, `name: ${name}`),
    sharingScope: "company",
    forkedFromSkillId: skill.id,
    forkedFromName: skill.name,
    folderId: null,
  };
}

export function skillCreateDraftToPayload(draft: SkillCreateDraft): CompanySkillCreateRequest {
  const effectiveSlug = draft.slug.trim() || normalizeSkillDraftSlug(draft.name);
  const effectiveMarkdown = draft.markdown.trim().length > 0
    ? draft.markdown
    : defaultSkillMarkdown(draft.name, draft.tagline);

  return {
    name: draft.name.trim(),
    slug: effectiveSlug || null,
    description: draft.description.trim() || draft.tagline.trim() || null,
    markdown: effectiveMarkdown,
    color: draft.color,
    tagline: draft.tagline.trim() || null,
    categories: draft.categories,
    sharingScope: draft.sharingScope,
    forkedFromSkillId: draft.forkedFromSkillId,
    folderId: draft.folderId ?? undefined,
  };
}
