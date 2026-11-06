# 本机成员私有模型登录验收

目标：每名成员在自己的 `workerHome` 内保有模型登录；Paperclip 与 GBrain 凭据仍按成员独立。此流程只用于本机，192 是控制面和测试环境。

## 已核对的入口

- 本机 `codex.exe login --help` 提供 `--device-auth` 与 `login status`；`codex exec --help` 提供 `--ephemeral`、`--sandbox read-only`、`--ignore-user-config`。
- 本机 `agent.exe login --help` 明示 `NO_OPEN_BROWSER` 可关闭自动打开浏览器；`agent status --help` 提供只读状态查询，`agent --help` 提供 `--mode ask` 与 `--model`。
- 桥接把 `HOME`、`USERPROFILE`、`CODEX_HOME`、`CURSOR_HOME`、`APPDATA` 和 `LOCALAPPDATA` 指向成员私有目录；启动前检查其中的认证文件。静态文件检查不能证明订阅仍有效。
- 登录脚本与工作器默认清除父进程的代理变量。本机 2026-11-06 的一次只读 HEAD 检查显示 `chatgpt.com` 和 `api2.cursor.sh` 直连可达；这不能保证后续网络环境。需要代理时，在**该成员私有配置**中显式增加 `"localProxyUrl": "http://127.0.0.1:7897"`。只接受无用户名、无密码、无路径的 IPv4 回环 HTTP 地址和明确端口；工作器把 Paperclip 控制面主机、GBrain 主机及回环地址加入 `NO_PROXY`。

## 单名成员的三步操作

以下命令在**已有的 PowerShell 窗口**里由操作员主动执行一次。脚本不建立计划任务、后台进程或自动重试。先以 Luna 配置为例，其他成员换成各自的私有配置路径。

1. 只读查看私有登录是否存在：

   ```powershell
   & '.\scripts\windows-agent-bridge\model-login-once.ps1' -ConfigPath 'H:\AIagent\Luna\.paperclip\worker-luna-192.json'
   ```

   如需确认当前网络，在命令末尾加 `-NetworkCheck`：只发送一次不带凭据的 HTTPS HEAD；输出 HTTP 状态，不保存响应正文。它使用私有配置的代理，未配置则直连。HTTP 403/405 仍只说明 TLS/HTTP 可达，不能说明登录成功。

2. 由该成员主动登录一次：在同一命令末尾加 `-Login`。Codex 显示设备码，由操作员在浏览器完成；Cursor 设置 `NO_OPEN_BROWSER=1`，只显示登录链接，由操作员自行打开。脚本不复制现有共享 `auth.json` 或 `cli-config.json`，不继承 Paperclip/GBrain/模型密钥环境变量。退出码失败后停止，不自动再试。

3. 登录后，由操作员在同一命令末尾改用 `-Probe`。脚本先读私有认证文件和 CLI 登录状态，再发**一次**只读模型请求；30 秒无结果即终止该探针进程树。探针输出不落盘、不打印内容，只报告通过或失败。探针通过仍须用真实任务验证权限、回写与取消停机，不能因此放开桥接入口。

### 当前只读诊断

2026-11-06 的 Luna 私有配置指向 `codex_local`，对应 `workerHome` 及其 `codex-home/auth.json` 尚不存在；默认检查输出 `Private login file present: False`。尚未执行 `-Login` 或 `-Probe`。

## 为什么不能复制共享订阅文件

旧 Codex adapter 在未显式指定 `CODEX_HOME` 时，会从当前用户的 `~/.codex/auth.json` 种入 Paperclip 的 managed home；Cursor 默认查当前 OS 用户的 `~/.cursor/cli-config.json`。这是源码路径，旧 127 进程的实际环境尚未核实。

Codex 源码明确记录：订阅刷新令牌会轮换且只能使用一次。把共享 `auth.json` 复制成多份会产生过期副本，下次刷新可能出现 `refresh_token_reused`；Paperclip 因此把 managed home 的认证文件链接到同一实时来源。七个独立进程同时写一份订阅文件的锁与刷新行为尚未经过真实并发试验，Cursor 的同账号并发行为也未验证。当前不复制、不链接共享登录，且私有登录预检拒绝符号链接。

## 放行门禁

1. 每名成员在自己的私有目录完成登录、只读状态和单次探针；不得用 Luna 的登录或 GBrain 身份代替他人。
2. 如多个成员共用一个模型订阅账号，先单独验证刷新与并发；出现刷新冲突则改为独立账号或受控模型凭据代理。
3. 仅一名成员的真实任务先验证事件、评论、取消停进程树和任务收尾；之后再逐人扩展。
4. `main.ts` 的 `requireWriteFence()` 与 `doctor.ps1` 的禁止安装门禁在上述验收完成前继续保持关闭。

源码证据：`packages/adapters/codex-local/src/server/codex-home.ts` 的 `resolveSharedCodexHomeDir`、`ensureSymlink` 和 `seedManagedCodexHome`；`packages/adapters/cursor-local/src/server/test.ts` 的 `cursorConfigPath`；本目录的 `environment.ts`、`model-readiness.ts` 与 `model-login-once.ps1`。
