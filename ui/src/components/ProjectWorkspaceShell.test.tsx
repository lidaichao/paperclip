import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectWorkspaceContextRail, ProjectWorkspaceShell } from "./ProjectWorkspaceShell";

describe("ProjectWorkspaceShell", () => {
  it("keeps the project title, tabs and content boundary in one neutral shell", () => {
    const html = renderToStaticMarkup(
      <ProjectWorkspaceShell
        projectName="Alice"
        activeTab="configuration"
        navigation={<nav aria-label="项目页签">任务 配置 预算 计划 甘特图 缺陷</nav>}
        contextRail={<ProjectWorkspaceContextRail label="配置目录" items={[{ href: "#project-settings-basic", label: "基础信息" }]} />}
      >
        <div>配置内容</div>
      </ProjectWorkspaceShell>,
    );

    expect(html).toContain('data-testid="project-workspace-shell"');
    expect(html).toContain('data-testid="project-workspace-header"');
    expect(html).toContain('data-testid="work-record-top-navigation"');
    expect(html).toContain('data-scroll-boundary="scroll"');
    expect(html).toContain('data-context-rail-width="280px"');
    expect(html).toContain('href="#project-settings-basic"');
    expect(html).toContain("Alice");
    expect(html).not.toMatch(/(?:green|emerald|lime)-/);
  });
});
