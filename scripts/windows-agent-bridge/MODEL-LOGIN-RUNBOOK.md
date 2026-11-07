# 本机模型登录与成员身份隔离验收

## 2026-11-08 当前 Belle 运行路径

Belle 的 Cursor 已在自己的 Windows 工作器目录完成官方登录，`modelAuthMode=private`；`CURSOR_CONFIG_DIR` 指向私有 `home/.cursor`，`CURSOR_DATA_DIR` 指向私有 `cursor-data`。CLI 程序仍从这台电脑的官方 Cursor 安装读取，模型登录文件、Paperclip/GBrain 凭据和进程不在 192 测试服务器。共享 Cursor 登录模式继续禁止启动，因为 CLI 会改写共享配置。

首次准备新电脑时，在**该成员电脑现有 PowerShell 窗口**运行一次 `prepare-private-cursor-runtime.ps1 -WorkerHome <成员私有工作器目录> -CursorInstallRoot <本机官方 Cursor 安装目录>`。此脚本只生成无凭据的本机转发程序及官方 `node.exe/index.js` 路径，不登录、不注册计划任务。然后在成员私有环境执行官方 Cursor `agent login`；把成员配置的 `localAdapterConfig.command` 指向该转发程序，设置 `modelAuthMode=private`，`extraArgs=["--trust","--auto-review"]`。`--auto-review` 只用于受控任务运行；不得换成 `--yolo`。CLI 升级后重新运行准备脚本以刷新官方路径。

2026-11-08 单次验收：Belle 原任务 PAP-11 来源运行 `8a265f2f-da56-4eb2-a2b1-8130d85c5f44`、本人评论 `fe0bb398-e388-4678-93d2-dbcfaa81838a`、Luna 审核运行 `59f0a532-17be-4c16-b108-15d50a351c25` 均成功，任务 `done`。第一次 ask 模式没有任务写入；第二次 agent 模式只用 `--trust` 时 Shell 审核卡住并已取消；最终 `--auto-review` 允许完成身份、只读回读、证据写回与审核交接。审核人被暂停时交接会拒绝，须先用正式 `resume` 清除 `pausedAt`；不得绕过审核。单次运行成功不等于常驻自动启动或零可见终端已验收。

## 历史调研与候选方案（以下状态以本页顶部最新结论为准）

目标：Paperclip 与 GBrain 凭据按成员独立。模型订阅可以由同一台电脑的同一 Windows 用户共享，**不要求七人各登录一次**。下方私有登录步骤仅是现有桥接代码支持的候选路径，不是已放行的运行流程。192 只作为控制面和测试环境。

2026-11-06 的只读核对显示，本机共享 Codex 与 Cursor 登录均有效；七名成员的 GBrain 本人变量和项目级 Codex 配置已分别核对。真实桥接启动门仍关闭，不运行下方登录或探针来解决共享认证问题。

## 已核对的入口

- 本机 `codex.exe login --help` 提供 `--device-auth` 与 `login status`；`codex exec --help` 提供 `--ephemeral`、`--sandbox read-only`、`--ignore-user-config`。
- 本机 `agent.exe login --help` 明示 `NO_OPEN_BROWSER` 可关闭自动打开浏览器；`agent status --help` 提供只读状态查询，`agent --help` 提供 `--mode ask` 与 `--model`。
- 当前桥接实现把 `HOME`、`USERPROFILE`、`CODEX_HOME`、`CURSOR_HOME`、`APPDATA` 和 `LOCALAPPDATA` 指向成员私有目录；启动前检查其中的认证文件。这只是现有实现的限制。静态文件检查不能证明订阅仍有效。

## 共享订阅登录的工程门禁

同一 Windows 用户可以共享模型订阅，但必须继续保持每成员独立的 Paperclip 密钥、GBrain 本人令牌、工作目录和状态锁。当前不能把共享用户的 `CODEX_HOME` 直接交给 Codex adapter：即使指定外部目录，adapter 仍会在执行时重写该目录的 `config.toml`，并注入 `skills`；并行成员或用户正在使用 Codex 时可能互相覆盖。Cursor 的共享认证目录也要单独验证实际 CLI 路径与写入行为。

不复制订阅认证文件：Codex 刷新令牌会轮换。当前 Windows 进程创建文件符号链接返回 `EPERM`，不能依赖无权限的自动建链。硬链接也不能当作等价替代：用同卷假文件实测，源文件经原子替换后，硬链接仍读到旧内容；Codex 是否采用这种替换方式尚未核实。未来每人独立电脑时，各自电脑需有自己的模型订阅登录或受管模型凭据，不能引用 Jack 电脑的本机认证文件。

隔离工作树现已加入显式 `"modelAuthMode": "shared_user_codex"`：只有 Codex 成员可选。工作器继续使用成员私有 `HOME`、`APPDATA`、Paperclip/GBrain 环境，只把 `CODEX_HOME` 指向当前 Windows 用户的 `.codex`。适配器的 `externalCodexHomeNoManagedWrites` 模式跳过共享目录的 MCP 配置、技能写入和认证缓存回填；不复制登录文件，也不自动登录。模拟测试已覆盖这些适配器写入，尚未用真实模型运行验证 Codex CLI 自身写入、多个成员并发刷新或项目级 MCP 配置。Cursor 不复用这条证据，继续按独立门禁处理。`doctor.ps1` 和 `main.ts` 的真实启动门继续关闭。

### Cursor 共享订阅的独立审查

[Cursor 官方配置文档](https://prod.cursor.com/docs/cli/reference/configuration)写明 Windows CLI 的默认配置文件在 `%USERPROFILE%\.cursor\cli-config.json`，且可用 `CURSOR_CONFIG_DIR` 指定目录；[官方认证文档](https://prod.cursor.com/docs/cli/reference/authentication)说明浏览器登录保存在本机，并提供 `agent status` 状态查询。本轮没有运行 `agent status` 或模型命令，因为官方文档还说明 CLI 会自修复缺失/损坏的配置，无法把状态命令视为严格无写入探针。

桥接已加入显式 `"modelAuthMode": "shared_user_cursor"` 的配置解析与模拟预检：只让 Cursor 使用本机用户共享的 `.cursor` 作为 `CURSOR_CONFIG_DIR`，成员 `HOME`、`USERPROFILE`、`APPDATA`、Paperclip/GBrain 环境仍独立；Cursor adapter 的技能目录从成员私有 `config.env.HOME` 解析，不再落到共享用户 `.cursor/skills`。本机共享认证文件只读检查为常规文件且字段形状符合预检，未输出任何凭据。由于 CLI 自身可能改写共享 `cli-config.json`，也尚未验证并发与登录有效性，launcher 对此模式**显式拒绝启动**；`main.ts` 和 `doctor.ps1` 的总门禁也保持关闭。未来每人独立电脑时，应在各自电脑完成 Cursor 登录或使用各自受管凭据。

#### Belle 单次受控检查（尚未执行）

1. 在 Cursor 空闲的维护窗口，只读确认共享 `cli-config.json` 是有效 JSON，记录文件哈希和修改时间；不复制文件或输出认证字段值。
2. 由独立的临时子进程执行**一次** `agent status --format json`：`CURSOR_CONFIG_DIR` 指向当前 Windows 用户 `.cursor`，`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 指向 Belle 私有目录，环境只保留必要系统键，不注入任何 GBrain、Paperclip 或模型 API key；`windowsHide=true`、`shell=false`、10 秒超时、无自动重试。不要把状态原文写入 Paperclip 日志。
3. 退出后再次只读核对共享配置哈希、修改时间与登录状态。若配置被改写、出现身份不一致、弹出窗口或超时，立即停止该路线并检查差异；不要自动覆盖或恢复共享配置。
4. 只有状态检查可解释且写入围栏、进程停稳门禁都完成后，才安排 Belle 的一条受控真实任务；验证当前任务回写、取消和全树停稳，再决定是否解除 launcher 的 Cursor 专用拒绝。当前不得提前运行该步骤。
- 登录脚本与工作器默认清除父进程的代理变量。本机 2026-11-06 的一次只读 HEAD 检查显示 `chatgpt.com` 和 `api2.cursor.sh` 直连可达；这不能保证后续网络环境。需要代理时，在**该成员私有配置**中显式增加 `"localProxyUrl": "http://127.0.0.1:7897"`。只接受无用户名、无密码、无路径的 IPv4 回环 HTTP 地址和明确端口；工作器把 Paperclip 控制面主机、GBrain 主机及回环地址加入 `NO_PROXY`。

## 私有登录备选流程（当前暂停）

以下命令在**已有的 PowerShell 窗口**里由操作员主动执行一次。脚本不建立计划任务、后台进程或自动重试。先以 Luna 配置为例，其他成员换成各自的私有配置路径。

1. 只读查看私有登录是否存在：

   ```powershell
   & '.\scripts\windows-agent-bridge\model-login-once.ps1' -ConfigPath 'H:\AIagent\Luna\.paperclip\worker-luna-192.json'
   ```

   如需确认当前网络，在命令末尾加 `-NetworkCheck`：只发送一次不带凭据的 HTTPS HEAD；输出 HTTP 状态，不保存响应正文。它使用私有配置的代理，未配置则直连。HTTP 403/405 仍只说明 TLS/HTTP 可达，不能说明登录成功。

2. 由该成员主动登录一次：在同一命令末尾加 `-Login`。Codex 显示设备码，由操作员在浏览器完成；Cursor 设置 `NO_OPEN_BROWSER=1`，只显示登录链接，由操作员自行打开。脚本不复制现有共享 `auth.json` 或 `cli-config.json`，不继承 Paperclip/GBrain/模型密钥环境变量。退出码失败后停止，不自动再试。

3. 登录后，由操作员在同一命令末尾改用 `-Probe`。脚本先读私有认证文件和 CLI 登录状态，再发**一次**只读模型请求；30 秒无结果即终止该探针进程树。探针输出不落盘、不打印内容，只报告通过或失败。探针通过仍须用真实任务验证权限、回写与取消停机，不能因此放开桥接入口。

### 当前只读诊断

2026-11-06 的 Luna 私有配置指向 `codex_local`，对应 `workerHome` 及其 `codex-home/auth.json` 尚不存在；默认检查输出 `Private login file present: False`。私有登录后续尝试失败；本轮共享用户订阅的只读 `login status` 已有效，未执行新的登录或模型探针。

## 为什么不能复制共享订阅文件

旧 Codex adapter 在未显式指定 `CODEX_HOME` 时，会从当前用户的 `~/.codex/auth.json` 种入 Paperclip 的 managed home；Cursor 默认查当前 OS 用户的 `~/.cursor/cli-config.json`。这是源码路径，旧 127 进程的实际环境尚未核实。

Codex 源码明确记录：订阅刷新令牌会轮换且只能使用一次。把共享 `auth.json` 复制成多份会产生过期副本，下次刷新可能出现 `refresh_token_reused`；Paperclip 因此把 managed home 的认证文件链接到同一实时来源。七个独立进程同时写一份订阅文件的锁与刷新行为尚未经过真实并发试验，Cursor 的同账号并发行为也未验证。当前共享 Codex 模式直接引用本机用户目录，不复制、不链接登录文件。

## 放行门禁

1. 每名成员的 Paperclip/GBrain 本人身份、私有运行环境和项目级 Codex 配置分别验证；模型订阅可由同一 Windows 用户共享。
2. 如多个成员共用一个模型订阅账号，先单独验证刷新与并发；出现刷新冲突则改为独立账号或受控模型凭据代理。
3. 仅一名成员的真实任务先验证事件、评论、取消停进程树和任务收尾；之后再逐人扩展。
4. `main.ts` 的 `requireWriteFence()` 与 `doctor.ps1` 的禁止安装门禁在上述验收完成前继续保持关闭。

## 2026-11-06 Luna 登录故障记录

Luna 按本手册执行一次私有 `-Login` 后，Codex app CLI 退出 1，报 `HW capability found … but HW capability requested …`，私有 `auth.json` 未产生。后来 npm CLI 的第二次登录在设备授权 POST 收到 TLS EOF；没有私有模型探针。只读对照显示：配置中的 app `codex.exe`（0.166.0-alpha.6）在完整及相同隔离环境下，`--version`、`--help`、`login --help` 均正常；本机 npm 安装内另一份原生 `codex.exe`（0.152.1）在隔离环境下 `--version` 与 `login --help` 也正常。帮助命令没有进入真正登录逻辑，因此不能据此断定私有登录已修复，也不能把环境清理或 CPU 视为已证明根因。

私有登录方案暂停；不因本轮共享模式的静态测试重复触发 `-Login`。CLI 版本差异仍需随未来受控真实任务验证。

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

随后只读检查找到一条**仅供 curl 验证的物理路径**：DoH 返回真实 IP `172.64.146.15`；本机以太网为 `192.168.72.214`、默认网关 `192.168.72.1`。用 `curl --interface 192.168.72.214 --noproxy '*' --resolve auth.openai.com:443:172.64.146.15` 对同一接口发无凭据 HEAD，返回 HTTP 403、TLS 校验 0，curl 的 `local_ip` 为物理源地址，`remote_ip` 为真实 IP。带 `-LocalIPAddress 192.168.72.214` 的 `Find-NetRoute` 也选择以太网默认路由，而非 Meta TUN。与 TUN 路径的 405 不同，说明出口确实改变；403 仍不能证明 POST 或设备登录可用。Codex CLI 没有已核实的源接口绑定参数，不能把 curl 的这条路径直接套用到 CLI。下一步留在人工网络窗口评估 CLI 可用的独立出口，本轮停止网络探测。

源码证据：`packages/adapters/codex-local/src/server/codex-home.ts` 的 `resolveSharedCodexHomeDir`、`ensureSymlink` 和 `seedManagedCodexHome`；`packages/adapters/cursor-local/src/server/test.ts` 的 `cursorConfigPath`；本目录的 `environment.ts`、`model-readiness.ts` 与 `model-login-once.ps1`。
