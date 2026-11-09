# PAP-25 Alice V1 阶段 2 验证记录

## 范围与环境

- 基线：`919b0c9623dcc2d0d6783f10e44ec2f93e38f770`
- 隔离候选：`H:\project\Papercilp\.worktrees\pap-25-stage2`
- Paperclip 运行号：`24ef63e1-9155-4a6b-9ac9-31fcb7376d02`
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

真实 Chrome 首轮定向结果：`work-record-g3b3.spec.ts` 通过，生成 `g3b3-wide.png`、`g3b3-narrow.png`；`work-record-demo1.spec.ts` 在失败点之前已完成业务保存、视图保存、回读及 issue/run 零增长断言。

## 本次修复

- `ProjectWorkRecords.test.tsx` 补 `MemoryRouter`，与组件当前 `useLocation` 依赖一致。
- `work-record-safe-dispatch.test.ts` 的两个并发依赖写请求补真实 `dependencySetRevision`，恢复“同一依赖版本下仅一个写入成功”的测试语义。

## 限制与待审核门禁

- 旧浏览器脚本仍假设卡片 DOM、原生确认框和旧视图草稿时序；现 UI 已改为表格/抽屉和自定义决策对话框。`work-record-safe-dispatch.spec.ts` 3 项因此在定位阶段失败；`work-record-demo1.spec.ts` 的剩余旧交互也未全绿。未以放开 192 cohort 或改生产范围绕过。
- 本机未能从 Playwright CDN 下载捆绑 Chromium（`ECONNRESET`），已改用已安装 Chrome 完成真实浏览器执行。
- 192 的 Alice 开发项目不在 workflow V2 cohort；待 Luna 审核后，仍需由环境负责人按批准 cohort 执行测试环境门禁，不由 Rabbit 本次部署。
