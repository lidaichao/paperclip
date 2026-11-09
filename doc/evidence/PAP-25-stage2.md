# PAP-25 Alice V1 阶段 2 验证记录

## 范围与环境

- 基线：`919b0c9623dcc2d0d6783f10e44ec2f93e38f770`
- 隔离候选：`H:\project\Papercilp\.worktrees\pap-25-stage2`
- Paperclip 运行号：`a4cc6ee9-6f68-4433-bd96-90c882cce9b5`
- 192 控制面：`192.168.72.157:3100` TCP 可达，`/api/health` 返回 200；未部署、未上传源码、模型或凭据，未改变 workflow V2 cohort。
- 浏览器：本机 Google Chrome；服务和内置 PostgreSQL 均位于隔离测试目录。

## 验收映射

1. 同源记录：共享契约、路由、计划表、甘特和缺陷定向测试验证同一 `work_record.id` 的保存与回读；甘特拖动继续 PATCH 原记录，不创建副本。
2. 日期和依赖：覆盖日期保存、依赖全量保留、并发依赖写冲突和环检测；甘特真实浏览器覆盖拖动、改依赖、撤销及脏容器聚焦。
3. 零副作用保存：业务记录保存和个人视图保存后，issue、heartbeat run 数量不变，记录 execution 仍为空；工作包 preview 的服务测试验证 issue、wake、run 均为零。
4. 显式派发：prepare/confirm 覆盖首次创建、同键复用、超时查询恢复、跨两个真实 API client 的断线边界与所有持久化 failpoint。
5. 权限和恢复：覆盖 viewer 只读 preview、路由授权、revision 冲突、依赖冲突、刷新后视图回读及投影 reconcile 不新增工作。

## 通过的命令

```powershell
.\node_modules\.bin\vitest.CMD run packages/shared/src/work-records.test.ts server/src/__tests__/work-record-safe-dispatch.test.ts server/src/__tests__/work-package-dispatch.test.ts server/src/__tests__/work-record-view-preferences.test.ts server/src/__tests__/work-record-view-preference-routes.test.ts server/src/__tests__/work-record-routes-authz.test.ts ui/src/components/WorkRecordGantt.test.ts ui/src/components/ProjectWorkRecords.test.tsx ui/src/components/WorkRecordContainerTree.test.tsx -t "SD-01|G1 persists|G1 preserves every predecessor|serializes concurrent dependency writers|SD-03|queries a timed-out dispatch|D01 keeps writes disabled|D06 exercises two real API clients|R04-R06|supports personal named view lifecycle|exposes named personal view CRUD|validates G1 planned dates|viewers preview facts|WorkRecordGantt|ProjectWorkRecords|WorkRecordContainerTree"
```

结果：`8 passed | 1 skipped`，`50 passed | 44 skipped`，退出码 0。

真实 Chrome 定向结果：

- `work-record-g3b3.spec.ts` 通过，生成 `g3b3-wide.png`、`g3b3-narrow.png`。
- `work-record-demo1.spec.ts` 两项均已分别通过：密集计划/缺陷视图保存不执行，以及业务草稿/视图草稿四态独立处理。
- `work-record-safe-dispatch.spec.ts` 已验证预览前后 issue/run 零增长、非 cohort 确认返回 403、运行中/离线/重连/减少动态效果，以及 stale reconcile；仍有 3 个旧契约断言未收口，见下节。
- Playwright 每轮启动前均完成 UI production build；构建成功，只有既有 CSS pseudo-element 与 chunk-size 警告。

## 本次修复

- `ProjectWorkRecords.test.tsx` 补 `MemoryRouter`，与组件当前 `useLocation` 依赖一致。
- `work-record-safe-dispatch.test.ts` 的两个并发依赖写请求补真实 `dependencySetRevision`，恢复“同一依赖版本下仅一个写入成功”的测试语义。
- `work-record-demo1.spec.ts` 对齐当前表格/原位详情、自定义业务草稿决策框及移动端导航；两项真实 Chrome 用例已通过。
- `work-record-safe-dispatch.spec.ts` 已对齐当前四层字段、预览/确认入口、离线立即降级和 stale 文案，并保留非 cohort 403 零副作用证据。

## 限制与待审核门禁

- `work-record-safe-dispatch.spec.ts` 连续三轮修复后仍有 3 个阻断：非 cohort 的 403 错误提示定位、完成运行后的 15 秒 live-runs 缓存刷新、冲突投影拦截后的显式刷新。按仓库规则停止继续试修；下一窗口应拆开这三个假设并各自单测，不能以放开 192 cohort 或改生产范围绕过。
- 本机未能从 Playwright CDN 下载捆绑 Chromium（`ECONNRESET`），已改用已安装 Chrome 完成真实浏览器执行。
- 192 的 Alice 开发项目不在 workflow V2 cohort；待 Luna 审核后，仍需由环境负责人按批准 cohort 执行测试环境门禁，不由 Rabbit 本次部署。

## Luna 集成验收（2026-11-09）

Rabbit 停稳后，Luna 将上述两个提交接入包含 `session_write_dispatch_deferred` 的隔离集成工作树，逐项核对三个浏览器阻断：403 的服务端诊断会由界面本地化、实时运行采用轮询、第二个冲突投影必须重新载入才能替换查询缓存。现已将派发按钮改为明确告知创建执行任务，补充项目未开放派发的中英文提示，并将实时运行轮询从 15 秒收紧到 5 秒。

- 本地化及工作包组件：44/44 通过；前端 `tsc -b` 通过。
- 本机真实 Chrome 最终整组：`work-record-allowed-dispatch`、`work-record-safe-dispatch`、`work-record-demo1`、`work-record-g3b3` 共 7/7 通过，含预览零原生任务、确认一次创建、重复确认复用同一关联 ID、计划/缺陷密集视图和甘特依赖编辑。
- 首次整组因临时内置 PostgreSQL 建索引失败而未进入浏览器断言；错开后一次合跑中 6/7 通过，剩余用例暴露派发关联为异步投影，修正等待条件后最终 7/7 通过。以上不改变 192 的项目 cohort。
