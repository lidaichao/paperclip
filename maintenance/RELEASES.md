# Paperclip 版本选择与回退

未创建 `H:/AIagent/Luna/.paperclip/active-release.json` 时，启动入口始终使用现有官方安装 `H:/AIagent/Luna/tools/paperclip`。

独立汉化发布放在 `H:/AIagent/Luna/tools/paperclip-releases/<版本>`。选择器要求完整发布清单、通过的验证报告、匹配的证据哈希及后端版本 `2026.831.1`。符号链接、目录越界、不完整构建和跨后端版本均拒绝。发布构建脚本负责校验完整后端与界面文件；启动入口核对清单、证据及已选清单指纹。

部署人员依次执行。2026-09-03 已完成中文版上线及“中文 → 原版 → 中文”回退演练，证据见维护包 `releases/activation.json`：

```powershell
# 只核验，不改指针、不停止服务
& H:/AIagent/Luna/scripts/paperclip/select-release.ps1 -Release '2026.831.1-zh.1' -CheckOnly
# 确定部署后：停止、选择、启动
& H:/AIagent/Luna/scripts/paperclip/stop.ps1
& H:/AIagent/Luna/scripts/paperclip/select-release.ps1 -Release '2026.831.1-zh.1'
& H:/AIagent/Luna/scripts/paperclip/start.ps1
```

回退时使用相同步骤，将版本参数改为 `previous` 或 `official`。选择器以同盘原子替换方式更新指针，并保留上一版本身份和旧指针备份，不删除任何发布目录或数据库。`previous` 表示上一次所选版本，可用于前后切换；`official` 始终表示最初的官方安装。

停止和选择前会查询所有公司的实时运行，存在运行中或排队任务时拒绝操作。选择只改变下次启动版本，不自动重启。启动时若已有其他版本正在监听，会提示先停止。三个入口互斥，避免同时启动、停止或修改指针。

数据库位置保持 `H:/AIagent/Luna/.paperclip/instances/default/db`，数据库控制工具继续使用原官方安装。跨后端升级必须另行执行并验证数据库备份和迁移流程；这些入口不提供跳过此限制的开关。
