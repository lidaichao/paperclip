import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ProjectWorkspaceShell({
  projectName,
  activeTab,
  navigation,
  children,
  contextRail,
  contentMode = "scroll",
}: {
  projectName: string;
  activeTab: string;
  navigation: ReactNode;
  children: ReactNode;
  contextRail?: ReactNode;
  contentMode?: "scroll" | "fixed";
}) {
  return (
    <section
      className="project-workspace-shell @container flex min-h-0 flex-col overflow-hidden bg-background"
      data-testid="project-workspace-shell"
      data-project-tab={activeTab}
    >
      <header className="project-workspace-header grid h-14 min-h-14 items-stretch border-b" data-testid="project-workspace-header">
        <div className="flex min-w-0 items-center border-r px-3">
          <h1 className="truncate text-base font-semibold" title={projectName}>{projectName}</h1>
        </div>
        <div className="min-w-0 overflow-x-auto px-5" data-testid="work-record-top-navigation">
          {navigation}
        </div>
      </header>
      {contextRail ? (
        <div className="work-record-workspace min-h-0 flex-1" data-testid="work-record-workspace-grid" data-context-rail-width="280px" data-rail-open="true">
          <div className="work-record-rail-shell" data-testid="work-record-rail-shell">
            <div className="work-record-rail-panel">{contextRail}</div>
          </div>
          <div
            className={cn("min-h-0 min-w-0", contentMode === "scroll" ? "overflow-auto py-4 pr-1" : "overflow-hidden")}
            data-testid="project-workspace-content"
            data-scroll-boundary={contentMode}
          >
            {children}
          </div>
        </div>
      ) : (
        <div
          className={cn("min-h-0 flex-1", contentMode === "scroll" ? "overflow-auto py-4 pr-1" : "overflow-hidden")}
          data-testid="project-workspace-content"
          data-scroll-boundary={contentMode}
        >
          {children}
        </div>
      )}
    </section>
  );
}

export function ProjectWorkspaceContextRail({ label, items }: {
  label: string;
  items: Array<{ href: string; label: string; description?: string; current?: boolean }>;
}) {
  return (
    <aside className="work-record-rail-navigation h-full" aria-label={label}>
      <nav className="space-y-1 py-3">
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={cn("work-record-context-link", item.current && "work-record-rail-active")}
            aria-current={item.current ? "page" : undefined}
          >
            <span>{item.label}</span>
            {item.description ? <small>{item.description}</small> : null}
          </a>
        ))}
      </nav>
    </aside>
  );
}
