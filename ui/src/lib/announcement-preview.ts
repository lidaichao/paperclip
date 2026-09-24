import { l10n } from "../i18n";
import animatedHero from "../../../announcements/examples/animated/assets/78bafb6adbfd9da899cdbb5d934b4c0b9df5d419d6f0a5104a87a7b25dcc6bd8.html?raw";
import type { Announcement } from "@paperclipai/shared";

/** Design guide / Storybook only. Never a runtime feed fallback. */
export const announcementPreview: Announcement = {
  id: "preview-work-together",
  eyebrow: "New in Paperclip",
  title: l10n("local.give_your_next_idea_a_team_4e9241f6"),
  description: l10n("local.bring_agents_projects_and_work_together_set_t_c42c81b2"),
  image: { path: `assets/${"0".repeat(64)}.png`, alt: l10n("local.paperclip_ideas_become_work_b9965c07") },
  secondaryLink: { kind: "external", label: l10n("local.learn_more_1445799c"), url: "https://paperclip.ing" },
  primaryAction: { kind: "route", label: l10n("local.explore_your_projects_44b56755"), path: "/projects" },
};

export const announcementAnimationPreview: Announcement = {
  ...announcementPreview,
  animation: { path: "assets/78bafb6adbfd9da899cdbb5d934b4c0b9df5d419d6f0a5104a87a7b25dcc6bd8.html", alt: l10n("local.agents_plan_build_and_review_work_together_30348b94") },
};
export const announcementAnimationPreviewSrc = `data:text/html;charset=utf-8,${encodeURIComponent(animatedHero)}`;
