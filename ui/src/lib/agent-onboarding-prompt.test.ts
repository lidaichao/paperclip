import { describe, expect, it } from "vitest";
import { buildAgentOnboardingPrompt } from "./agent-onboarding-prompt";

describe("buildAgentOnboardingPrompt", () => {
  it("includes Hermes Gateway setup guidance for external agents", () => {
    const prompt = buildAgentOnboardingPrompt({
      onboardingTextUrl: "http://localhost:3100/api/invites/token-123/onboarding.txt",
      connectionCandidates: ["http://192.168.1.10:3100"],
    });

    expect(prompt).toContain('adapterType: "hermes_gateway"');
    expect(prompt).toContain("API_SERVER_ENABLED=true");
    expect(prompt).toContain("API_SERVER_KEY");
    expect(prompt).toContain("与 `API_SERVER_KEY` 完全相同的值");
    expect(prompt).toContain("不是 Alice API 密钥");
    expect(prompt).toContain("hermes gateway run --replace --accept-hooks");
    expect(prompt).toContain("Hermes API 服务默认端口为 `8642`");
    expect(prompt).toContain("agentDefaultsPayload.apiBaseUrl");
    expect(prompt).toContain("agentDefaultsPayload.paperclipApiUrl");
    expect(prompt).toContain("http://127.0.0.1:8642");
    expect(prompt).toContain("http://127.0.0.1:9119");
    expect(prompt).toContain("http://127.0.0.1:9119/chat");
    expect(prompt).toContain("Alice 会映射到 `/api`");
    expect(prompt).toContain("`/chat` 和仪表盘根地址都是浏览器界面路由");
    expect(prompt).toContain("`/api/v1/runs`");
    expect(prompt).toContain("http://<private-ip>:8642");
    expect(prompt).toContain("http://<tailnet-host>:8642");
    expect(prompt).toContain("http://host.docker.internal:8642");
    expect(prompt).toContain("https://hermes-gateway.example");
    expect(prompt).toContain("`hermes_local` 在 Alice 主机上运行 Hermes");
    expect(prompt).toContain("Hermes 主动调用 Alice API");
    expect(prompt).toContain("不要手动轮换或编造 Alice 密钥");
    expect(prompt).toContain("从原始 HTTP JSON 响应中解析并保存 `token` 字段");
    expect(prompt).toContain("包含字面量 `...` 或 `[redacted]` 的令牌");
    expect(prompt).toContain("绝不能把包含 `...` 的显示预览保存为真实密钥");
  });
});
