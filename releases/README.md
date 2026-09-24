# 汉化候选发布与升级维护

此目录保存兼容性记录；完整运行候选包放在 `H:/AIagent/Luna/tools/paperclip-releases/`。独立词库、源码补丁和版本历史保留在汉化项目中，运行包不作为唯一资产。

## 升级差异检查

```powershell
node H:/AIagent/Luna/tools/paperclip-zh-cn/scripts/prepare-upgrade.mjs --old H:/AIagent/Luna/tools/paperclip-zh-cn/integration/source-map-old.json --new H:/AIagent/Luna/tools/paperclip-zh-cn/integration/source-map.json --out H:/AIagent/Luna/tools/paperclip-zh-cn/integration/upgrade-report.json
```

输入可为词条数组，或包含 `entries` / `items` / `candidates` 数组的对象。每条包含 `key`、`english`、`sourceFile`、`sourceContext`、`placeholders`。相同语义键的英文、上下文或占位符变化均进入重新审查清单，不能自动继承旧译文；新增补译，删除留档。退出码 `0` 表示完全可复用，`2` 表示存在需审查差异，`1` 表示输入或执行错误。报告输出必须在独立汉化目录内。

## 生成候选运行包

前置条件：固定源码提交 `65ec059bde30d98c92165b24a30a540800dd1f6f`、官方安装版本 `2026.831.1`、源码 `ui/dist` 已构建，`locale/` 和 `integration/patches/` 非空，并有含 `passed: true` 的 JSON 验证报告。验证报告应列出实际完成的检查及证据；打包脚本不替代人工验收，也不替调用者杜撰测试结果。

```powershell
# 只做前置检查，不创建发布目录。
node H:/AIagent/Luna/tools/paperclip-zh-cn/scripts/build-release.mjs --release 2026.831.1-zh.1 --test-report H:/AIagent/Luna/tools/paperclip-zh-cn/releases/validation-report.json

# 获准构建候选后追加 --execute；仍不会切换运行服务。
node H:/AIagent/Luna/tools/paperclip-zh-cn/scripts/build-release.mjs --release 2026.831.1-zh.1 --test-report H:/AIagent/Luna/tools/paperclip-zh-cn/releases/validation-report.json --execute
```

脚本复制官方安装的完整根 `node_modules` 依赖树，解引用 Windows 链接。唯一跳过的内容是原 `@paperclipai/server/ui-dist`，随后用匹配源码构建的 `ui/dist` 替换。只复制安装根的 `package.json` / `package-lock.json` 和运行依赖，不复制工作区、数据库、凭据或日志。后端和依赖在复制前后逐文件 SHA-256 校验；不执行数据库迁移或启动服务。

发布目录已存在、路径越界、版本/提交不符、验证报告未通过均会拒绝。失败候选保留 `BUILD-INCOMPLETE.json` 供定位，不能启用；脚本不自动删除失败目录、不覆盖既有候选。成功后写入 `release-manifest.json`，但 `status: candidate` 仍表示待部署负责人验证和切换。

发布清单包括上游版本、提交、npm 完整性、锁文件摘要、汉化版本、词库与补丁摘要、后端版本与全部依赖摘要、UI 资产摘要及验证报告摘要。`backend-files.json` 和 `ui-assets.json` 保存具体文件证据。启动端应验证清单摘要且拒绝不完整目录；本工具不修改 `active-release.json`、启动脚本或当前安装。

## 独立工具测试

```powershell
node --test H:/AIagent/Luna/tools/paperclip-zh-cn/scripts/release-tools.test.mjs
```

测试覆盖五类升级差异、重复键、占位符数量、路径越界、链接越界、覆盖拒绝，以及后端变动检测。临时数据只在经过路径验证的操作系统临时目录内清理。
