# Paperclip 简体中文维护包

此目录独立保存中文词库、术语、源码接入补丁、人工审查记录、版本约束与验收证据。运行中的 Paperclip、数据库、登录信息均位于其他目录。

## 固定基线

- 官方包：`paperclipai@2026.831.1`。
- 官方源码：`v2026.831.1`，提交 `65ec059bde30d98c92165b24a30a540800dd1f6f`。
- 中文默认开启，账户菜单可切换 English；选择保存在本机浏览器。
- 后端仍使用相同官方版本，汉化只替换构建后的界面。

## 文件说明

| 路径 | 用途 |
|---|---|
| `locale/en/catalog.json` | 已盘点原文 |
| `locale/zh-CN/` | 独立中文翻译与人工批次 |
| `integration/source-map.json` | 原文、源码位置、上下文、占位符 |
| `integration/reviewed-extra.json` | 自动盘点之后的人工补漏审查 |
| `integration/exclusions*.json` | 命令、路径、代码、产品名等保留理由 |
| `integration/patches/` | 对固定官方源码可重放的补丁 |
| `compatibility.json` | 版本和来源校验 |
| `scripts/prepare-upgrade.mjs` | 新旧版本文字与上下文差异报告 |
| `scripts/build-release.mjs` | 构建独立候选目录并校验后端字节一致 |
| `releases/` | 词库、测试、浏览器与发布验证记录 |

## 翻译边界

翻译页面、菜单、按钮、表单说明、空态、通知、状态显示、日期和无障碍标签。任务标识、API 字段、状态枚举、文件路径、命令、模型标识、用户填写的内容和原始运行日志保持原值。金额仍按原币种显示，美元不会被改成人民币。

显示文字不能用于生成 URL、权限判断或业务分支。已经将发现的分派判断与显示标签分开，并对技能文件默认正文、触发器标识建立保护。

## 重建本版本

优先在相同官方提交的干净源码目录应用 `integration/patches/0001-zh-cn.patch`，执行 `git apply --check` 后再应用。补丁包含新增运行时、词库、显示接入及测试；不要复制整个旧源码去覆盖新版。

源码依赖采用官方 `pnpm-lock.yaml`，使用 `pnpm@9.15.4 --frozen-lockfile`。官方字体从当前官方安装的 `server/ui-dist/fonts` 保留到 `ui/public/fonts` 后构建。运行 UI 类型检查、中文交互测试及回归，再运行 `check-locales.mjs`。

当前工作目录中的抽取重放脚本属于本次迁移工具。它们受固定源码提交约束；升级时必须重新盘点和审查，不能绕过版本检查。`inventory.mjs` 会重新生成盘点，人工补漏需随后执行 `import-reviewed.mjs`、`apply-localization.mjs`、`apply-display-fixes.mjs`、`monitor-display-fix.mjs --apply`，最后运行 `merge-catalogs.mjs`。编辑器通过官方 `translation` 回调加载 `integration/mdx-messages.json`，第三方依赖源码不修改。

## 升级流程

1. 保留当前运行目录与本维护包，获取新版官方源码到独立目录。
2. 对比新旧文案、占位符和上下文；生成新增、删除、改文案及冲突清单。
3. 人工审查变化并补译。对新版做补丁适配，不覆盖旧版词库。
4. 在新候选目录完成构建、回归与浏览器验收，核对资源及后端版本。
5. 备份数据库，确认没有成员正在运行任务，再切换活动指针。
6. 发现问题时，同一后端版本可切回前一界面。跨后端升级若修改过数据库结构，需要按该版本的数据库恢复流程处理。

升级工具会报告冲突并停止。独立文件和修改记录降低丢失风险，但不能保证所有未来版本无需适配。

## 本机启动与回退

参见 `H:/AIagent/Luna/scripts/paperclip/RELEASES.md`。默认官方安装保留；`active-release.json` 控制选用哪个已经通过核验的候选目录。选择器不会自动重启服务，切换由维护者按备份、停机、选择、启动、健康验证的顺序完成。
