export type AgentOnboardingPromptInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

export function buildAgentOnboardingPrompt(input: AgentOnboardingPromptInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((url) => `- ${url}`).join("\n")
      : "-（暂时没有可用的候选地址。）";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `没有可用的候选地址。请让管理员配置一个你的运行环境能够访问的 Alice 主机名，然后重试。
建议管理员执行以下步骤：
- 选择一个能从你的运行环境解析到 Alice 主机的主机名
- 运行：npx paperclipai allowed-hostname <host>
- 重启 Alice
- 使用以下命令验证：curl -fsS http://<host>:3100/api/health
- 重新生成这份智能体接入提示词`
      : `如果所有地址都无法访问，请让管理员添加一个可访问的 Alice 主机名，重启后再试。
建议管理员执行：
- npx paperclipai allowed-hostname <host>
然后使用以下命令验证：curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\n如果你的运行环境提供回调或网关地址，请使用以下地址测试 Alice 到智能体的连通性：${resolutionTestUrl}?url=<urlencoded-agent-url>。`
    : "";

  return `你受邀作为智能体加入一个 Alice 组织。

首先回复用户：你已理解请求，并将开始接入 Alice。然后按以下步骤操作。

可尝试访问的 Alice 接入文档：
${candidateList}

连通性说明：
你的运行环境必须能够访问 Alice。请使用以下请求验证基础地址：GET <base-url>/api/health
${connectivityBlock}${resolutionLine}

加入流程：
1. 从上方第一个可访问的地址读取 onboarding.txt 文档。
2. 向邀请注册接口提交智能体加入请求。
3. 在 \`agentName\` 中填写你自己的智能体名称。
4. 提供简洁的 \`capabilities\` 能力摘要，方便管理者判断应向你分配哪些工作。
5. 如果存在与你运行环境匹配的适配器，请将 \`adapterType\` 设置为对应的 Alice 适配器。
6. 将运行环境特有的设置放入 \`agentDefaultsPayload\`。
7. 等待管理者批准后再领取 API 密钥。
8. 通过标准领取接口一次性领取 Alice API 密钥，安全保存，并用于后续 Alice API 调用。打印或总结响应之前，先从原始 HTTP JSON 响应中解析并保存 \`token\` 字段；不要从聊天、转录或工具输出预览中复制令牌。包含字面量 \`...\` 或 \`[redacted]\` 的令牌只是脱敏预览，不是有效密钥。不要手动轮换或编造 Alice 密钥。

OpenClaw Gateway 说明：
如果你是 OpenClaw Gateway 智能体，请使用 \`adapterType: "openclaw_gateway"\`，将 \`agentDefaultsPayload.url\` 设置为你的 \`ws://\` 或 \`wss://\` 网关地址，并在 \`agentDefaultsPayload.headers["x-openclaw-token"]\` 中提供网关令牌。此加入流程不要使用 \`/v1/responses\` 或 \`/hooks/*\`。

Hermes Gateway 说明：
如果你是 Hermes Gateway 智能体，请使用 \`adapterType: "hermes_gateway"\`。
- 对于全新 Hermes 安装，先生成一个新的随机网关密钥，使用 \`API_SERVER_ENABLED=true\` 和 \`API_SERVER_KEY=<random-gateway-key>\` 启动 Hermes，再运行 \`hermes gateway run --replace --accept-hooks\`。Hermes API 服务默认端口为 \`8642\`。
- 将 \`agentDefaultsPayload.apiBaseUrl\` 设置为 Alice 能访问的 Hermes 网关地址，将 \`agentDefaultsPayload.apiKey\` 设置为与 \`API_SERVER_KEY\` 完全相同的值，并将 \`agentDefaultsPayload.paperclipApiUrl\` 设置为 Hermes 能访问的 Alice 基础地址。\`agentDefaultsPayload.apiKey\` 是 Hermes 网关密钥，不是 Alice API 密钥。
- \`apiBaseUrl\` 示例：本机回环 API \`http://127.0.0.1:8642\`；本机仪表盘根地址 \`http://127.0.0.1:9119\`（Alice 会映射到 \`/api\`）；局域网/专用网络 \`http://<private-ip>:8642\`；专用覆盖网络 \`http://<tailnet-host>:8642\`；Docker \`http://host.docker.internal:8642\`；反向代理/TLS \`https://hermes-gateway.example\`。
- 如果你只有 Hermes 默认仪表盘或聊天地址，也可以使用 \`http://127.0.0.1:9119\` 和 \`http://127.0.0.1:9119/chat\`，系统会自动映射到 \`/api\`。
- 注意：\`/chat\` 和仪表盘根地址都是浏览器界面路由。Alice 会先将它们映射到 API 基础地址，再测试 \`/api/health\`，并通过 \`/api/v1/runs\` 启动运行。
- 请区分三种用途：\`hermes_local\` 在 Alice 主机上运行 Hermes；\`hermes_gateway\` 通过 \`apiBaseUrl\` 调用已经运行的 Hermes API 服务；Hermes 主动调用 Alice API 时使用已领取的 \`PAPERCLIP_API_KEY\` 和 \`PAPERCLIP_API_URL\`，而不是 \`agentDefaultsPayload.apiBaseUrl\`。
- 从 Hermes 领取 Alice API 密钥时，请把原始响应中的 \`token\` 直接写入私密存储，并通过一次 Alice API 调用验证。Hermes 或工具界面可能会脱敏或截断密钥，所以绝不能把包含 \`...\` 的显示预览保存为真实密钥。

连接到 Alice 后，请阅读并遵循 onboarding.txt 中的完整接入说明。
`;
}

function buildCandidateOnboardingUrls(input: AgentOnboardingPromptInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) urls.add(trimmed);
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentOnboardingPromptInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution",
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
