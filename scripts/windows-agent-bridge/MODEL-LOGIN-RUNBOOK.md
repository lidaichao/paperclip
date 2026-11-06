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

## 2026-11-06 Luna 登录故障记录

Luna 按本手册执行一次私有 `-Login` 后，Codex app CLI 退出 1，报 `HW capability found … but HW capability requested …`，私有 `auth.json` 未产生。后续未重试登录或模型探针。只读对照显示：配置中的 app `codex.exe`（0.166.0-alpha.6）在完整及相同隔离环境下，`--version`、`--help`、`login --help` 均正常；本机 npm 安装内另一份原生 `codex.exe`（0.152.1）在隔离环境下 `--version` 与 `login --help` 也正常。帮助命令没有进入真正登录逻辑，因此不能据此断定登录已修复，也不能把环境清理或 CPU 视为已证明根因。

候选修复：保持私有 `workerHome`，由操作员在下一次受控验证时把**该成员私有配置**的 `localAdapterConfig.command` 临时改为现成 npm 安装的原生 `codex.exe`，仅运行一次 `-Login`；失败立即停止并恢复原命令，不循环重试或复制共享认证。若登录成功，随后单独运行一次 `-Probe` 并检查私有认证文件，才认为该候选可用。CLI 版本差异还需与 Paperclip adapter 的真实任务运行共同验收。

### 候选二进制的只读证据

| 项目 | 2026-11-06 本机结果 |
| --- | --- |
| npm 原生可执行文件 | `C:\Users\Administrator\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` |
| npm 包来源 | `@openai/codex@0.152.1`；原生包 `@openai/codex@0.152.1-win32-x64`，见同级 `package.json` |
| Authenticode | `Valid`，签名主体 `OpenAI OpCo, LLC` |
| SHA-256 | `01B0FD4167393E004B9174C77AE5F8570486118E19DC4216CFC62A62A74B6EE6` |
| 私有环境 `--version` | 退出 0，首行 `codex-cli 0.152.1` |
| 私有环境 `login --help` | 退出 0，首行 `Manage login`；只读取帮助，未登录 |

这次只读对照使用 Luna 配置中的私有 `HOME`、`USERPROFILE`、`CODEX_HOME`、`APPDATA`、`LOCALAPPDATA`、`TEMP`，且没有继承 Paperclip/GBrain/模型密钥。作为对照，当前 Codex app 可执行文件 `C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\a159911ff70742e9\codex.exe` 是 v0.166.0-alpha.6、签名同样有效；完整和私有环境下 `--version`、`--help` 均退出 0。以上只证明帮助路径可启动。

单独修改 Luna **私有桥接配置**的 `localAdapterConfig.command` 只改变未来桥接调用哪个 CLI，不安装或替换程序，不修改已运行 Codex app 的进程和会话。脚本的私有目录与现有 app 登录目录分开，按当前源码应不覆盖现有 app 凭据；设备登录是否还会改写 OS 级状态未实测，因此真实登录后仍要检查现有 app 会话，并在异常时恢复配置。不要在本次只读诊断中更改配置或再次执行登录。

### 设备授权 POST 的 TLS EOF：只读网络诊断

第二次受控登录改用上述 npm CLI 后，在 `auth.openai.com/api/accounts/deviceauth/usercode` 的 POST 收到 TLS EOF；此前无凭据 POST 通过所谓“直连”和 `127.0.0.1:7897` 代理也报告 TLS EOF。此后没有再发送 POST 或登录。

2026-11-06 的无凭据只读检查：

| 检查 | 结果 |
| --- | --- |
| 本机 DNS `auth.openai.com` | `198.18.1.251` |
| 现有 Clash 配置 | `enhanced-mode: fake-ip`，`fake-ip-range: 198.18.0.1/16`，`mixed-port: 7897`；7897 监听进程为 `verge-mihomo` |
| `curl --noproxy '*'` 的 HEAD/GET | 实际远端 IP `198.18.1.251`，TLS 校验 0，接口返回 HTTP 405；响应来自 Cloudflare |
| `curl --proxy http://127.0.0.1:7897` 的 HEAD/GET | 代理入口为 `127.0.0.1`，TLS 校验 0，接口返回 HTTP 405 |
| 本机 curl | 8.21.0 Windows/Schannel 构建不支持 `--http2`，因此未比较 HTTP/2 与 HTTP/1.1 |

**能确定：** CLI v0.152.1 与无凭据 curl 的 POST 都遇到 EOF，故不能把这次 POST 失败归咎于 CLI 版本。HEAD/GET 已抵达 Cloudflare，不能推断 POST 也通畅。`--noproxy '*'` 仍连接到 Clash 假地址，所以本次“直连”和显式代理不是两条独立上游路径。

**尚不能确定：** EOF 发生在 mihomo、其选中的上游节点、边缘防护还是请求体/HTTP 协议处理。现有只读 GET/HEAD 无法证明具体一层。下一次排障应先用**独立网络路径**核对 DNS 不再返回 Clash 假地址，再在受控窗口对同一设备授权流程只尝试一次；失败保留退出码与脱敏网络日志即停。不要循环登录、复制共享认证、改系统代理或把 192 服务器当作成员运行位置。

源码证据：`packages/adapters/codex-local/src/server/codex-home.ts` 的 `resolveSharedCodexHomeDir`、`ensureSymlink` 和 `seedManagedCodexHome`；`packages/adapters/cursor-local/src/server/test.ts` 的 `cursorConfigPath`；本目录的 `environment.ts`、`model-readiness.ts` 与 `model-login-once.ps1`。
