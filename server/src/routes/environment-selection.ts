import { unprocessable } from "../errors.js";

export async function assertEnvironmentSelectionForCompany(
  environmentsSvc: {
    getById(environmentId: string): Promise<{
      id: string;
      driver: string;
      status?: string | null;
      config: Record<string, unknown> | null;
    } | null>;
  },
  _companyId: string,
  environmentId: string | null | undefined,
  options?: {
    allowedDrivers?: string[];
    allowedSandboxProviders?: string[];
  },
) {
  if (environmentId === undefined || environmentId === null) return;
  const environment = await environmentsSvc.getById(environmentId);
  if (!environment) {
    throw unprocessable("未找到环境。");
  }
  if (environment.status === "archived") {
    throw unprocessable("环境已归档。");
  }
  if (options?.allowedDrivers && !options.allowedDrivers.includes(environment.driver)) {
    throw unprocessable(
      `此处不允许使用环境驱动“${environment.driver}”。允许的驱动：${options.allowedDrivers.join("、")}`,
    );
  }
  if (environment.driver === "sandbox") {
    const config = environment.config && typeof environment.config === "object"
      ? environment.config as Record<string, unknown>
      : {};
    const provider = typeof config.provider === "string" ? config.provider : "";
    if (provider === "fake") {
      throw unprocessable(
        `此处不允许使用环境沙箱提供方“${provider}”。内置模拟提供方仅供探测，不能执行运行任务。`,
      );
    }
    if (
      options?.allowedSandboxProviders
      && options.allowedSandboxProviders.length > 0
      && !options.allowedSandboxProviders.includes(provider)
    ) {
      throw unprocessable(
        `此处不允许使用环境沙箱提供方“${provider || "未知"}”。允许的提供方：${options.allowedSandboxProviders.join("、")}`,
      );
    }
  }
}
