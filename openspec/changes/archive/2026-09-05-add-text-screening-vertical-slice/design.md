## Context

`local-runtime` 已归档并提供通用 Job、租约、重试、取消、SSE 与 FakeModel 边界；当前代码尚无求职领域表、Application 层或业务页面。本 Change 需要在不把业务规则塞入 HTTP/Worker 的前提下，交付第一条可运行纵向切片。整体约束以 `docs/architecture.md` 为基线，行为以三个 delta spec 为准。

## Goals / Non-Goals

**Goals:**

- 用真实 SQLite 持久化候选人、导入、Opportunity、Run、Claim 和报告，并保持快照不可变。
- 建立 Ingestion/Profile/Opportunity/Research 的 Application Interface 和事务边界。
- 以 FakeModel 验证完整 Workflow、恢复、SSE 和 UI，而不是验证模型供应商。
- 让每个结论都能追溯到 Snapshot、Claim、规则与来源文本。

**Non-Goals:**

- 不解析 PDF/DOCX 简历文件；本切片只保存用户粘贴的简历文本。
- 不抓取岗位 URL、不识别截图、不做公司联网研究或地图通勤计算。
- 不实现 Chat、HR/面试记录、简历改写、导出和回收站。
- 不实现真实模型 Provider；接口与版本字段预留但默认只注册 FakeModel。

## Decisions

### 1. 增加 Application 包，保持 Route 和 Worker 轻薄

新增 `packages/application`，包含四个深模块：

- `ProfileApplication`：保存/读取当前简历与画像，创建 ProfileSnapshot。
- `IngestionApplication`：创建批次、重试 ImportItem、合并抽取结果、确认 Draft。
- `OpportunityApplication`：列表、详情、Draft 编辑与当前报告读取。
- `ResearchApplication`：启动、取消、重试 Run，协调快照、Workflow 与报告采用。

Application 依赖 Domain 端口和 UnitOfWork，不依赖 Fastify、React、Drizzle 或具体模型。Server 负责实现 repository/UoW、注册 Job handler 和 DTO 映射。备选方案是在 routes 和 handlers 内直接编排，初期文件更少，但会破坏已确认的事务与领域边界。

### 2. 以五个聚合和不可变快照组织数据

- `UserProfile`：单行聚合，持有 profileVersion、resumeVersion、当前简历与画像。
- `ImportBatch`：持有 1–20 个 ImportItem 的独立处理状态。
- `Opportunity`：一次工作机会，持有 SourceInput、JobDraft、当前有效报告 ID 和 version。
- `ResearchRun`：冻结输入后执行 Workflow，持有 currentStage、状态、Checkpoint 和父子关系。
- `ScreeningReport`：完成后不可变，只允许通过元数据标记 partial/stale/invalidated/effective。

`ProfileSnapshot` 和 `JobSnapshot` 使用带 `schemaVersion` 的 JSON 保存，并将 resume/profile/job revision 单独建列用于 stale 判定。重复 JD 不共享 Opportunity，也不引入去重表。

### 3. 迁移按当前切片创建必要表

新增迁移创建：

- `user_profile`
- `profile_snapshots`
- `import_batches`、`import_items`
- `opportunities`、`job_drafts`、`draft_conflicts`
- `job_snapshots`
- `research_runs`、`stage_checkpoints`、`run_events`
- `research_claims`、`screening_reports`
- `idempotency_keys`

常用列表字段单独列出并索引；复杂、不可变内容使用版本化 JSON。Opportunity 关键词检索先以标准化标题/公司/location 的普通索引与 LIKE 实现，本 Change 不提前引入完整 FTS5 文档索引。

### 4. 文本导入统一走异步 Extraction Job

`POST /api/import-batches` 接受 `{ items: [{ text }] }` 和 `Idempotency-Key`。Application 在一个事务中创建 Batch、Item、Opportunity、SourceInput 和 `extract-job-draft` Job；每项拥有自己的 jobId，失败互不回滚。

Fake extraction 使用稳定规则加预设样本输出，仍通过 ModelPort 的 `generateStructured` 调用并经过 Zod schema 验证。URL-only 输入在创建后进入 needs_input，不调用网络。抽取成功通过 expected extractionRevision 合并：仅更新 revision 未改变的字段，其余写入 `draft_conflicts`。

### 5. 用户编辑和确认通过乐观并发保护

`PATCH /api/opportunities/:id/draft` 必须提交 expectedVersion；字段以 `{ value, source, revision }` 存储，用户修改写入 source=user 并增加字段及聚合 version。参与分析字段变化时确认状态回到 draft。

`POST /api/opportunities/:id/draft/confirm` 校验最低字段：岗位名称，以及职责或要求至少一项非空。确认记录 confirmedAt/confirmedVersion。批量页面只允许选择 confirmed 项启动初筛，不要求先修复全部失败项。

### 6. 初筛 Run 与 Job 在同一事务创建

`POST /api/opportunities/:id/screening-runs` 接受 `Idempotency-Key`。ResearchApplication 校验当前简历、画像与 confirmed Draft，冻结 ProfileSnapshot/JobSnapshot，并同时创建 ResearchRun 与类型为 `screen-opportunity` 的通用 Job。幂等键绑定 command type、aggregate ID 和响应 receipt；相同请求返回原 receipt，不同 payload 复用同键返回 409。

通用 Job 仍负责进程级可靠执行；ResearchRun 负责业务状态：

```text
queued → running | cancelling
running → completed | failed | cancelling
cancelling → cancelled
failed → terminal（重试创建 child Run）
completed/cancelled/superseded → terminal
```

本切片不会产生 waiting/needs_attention，但 schema 保留完整枚举，后续深研可直接扩展。

### 7. Workflow 通过 Checkpoint 实现阶段恢复

`screen-opportunity` handler 按以下阶段执行：

```text
constraint_check
→ semantic_match
→ claim_validation
→ recommendation_policy
→ screening_report
```

每阶段读取冻结快照与上一个 Checkpoint，计算 StageResult，并在一个事务中写 Checkpoint、Run currentStage 和 RunEvent。Checkpoint 以 `runId + stage` 唯一，已存在则读取而不重新提交。最后阶段写入 Claims/Report、更新 Run completed，并在满足采用规则时更新 Opportunity.currentReportId。

### 8. FakeModel 产生 Claim，规则引擎产生推荐

扩展 ModelPort 的 request metadata，但保持现有 `generateStructured` 兼容。FakeModel 基于脱敏合成样本或稳定关键词规则返回候选 Claim：resume evidence、JD evidence、dimension、polarity 和 confidence。claim_validation 拒绝无法在 Snapshot 文本中定位的引用。

确定性 `RecommendationPolicy`：

- required 未满足或 blocking 红旗被有效 Claim 确认 → `not_recommended`。
- 有效信息不足以评估核心职责/要求 → `insufficient_information`。
- 其余维度按归一化权重映射 verdict 分值，输出 `strong_match`、`worth_exploring` 或 `cautious`。
- company reliability 与 life radius 在纯文本初筛通常为 unknown，不将 unknown 当 negative；报告必须列入后续核验项。
- 薪资总包采用月薪区间 × payMonths；默认 12 薪时保留 assumption 并降低 confidence。

### 9. RunEvent 与正式数据分离

新增 `GET /api/runs/:id`、`POST /api/runs/:id/cancel`、`POST /api/runs/:id/retry` 和 `GET /api/runs/:id/events`。RunEvent 与业务状态在同事务写入，sequence 在单个 Run 内递增。前端 SSE 只更新轻量进度并使 TanStack Query 失效，报告和 Run 快照始终重新查询；不通过 SSE token 拼装正式报告。

### 10. Web 采用小型路由化工作台

加入 TanStack Router，页面为：

- `/profile`：当前简历文本、画像、约束、红旗和七维权重。
- `/import`：1–20 个文本输入、逐项状态和重试。
- `/opportunities`：历史列表、关键词/状态/推荐筛选。
- `/opportunities/:id`：Draft 编辑/冲突确认、启动 Run、进度、当前及历史报告。

普通字段防抖保存并携带 expectedVersion；确认、启动、取消和重试显式操作。Server 断开时页面进入只读提示，不伪装保存成功。

### 11. API 错误和隐私沿用架构基线

新增 DTO 全部由 contracts Zod schema 验证；validation=400、not_found=404、version_conflict=409、domain_precondition=422、infrastructure_unavailable=503。日志、Job input 摘要与 RunEvent 不写完整简历/JD；实际正文只在本地业务表和不可变快照中保存。

## Risks / Trade-offs

- [一次 Change 跨越多层且表较多] → 按 Profile、Ingestion、Screening、Web 四个垂直子阶段实施，每阶段拥有 repository/Application/API 测试。
- [FakeModel 结果可能让 UI 看起来像真实判断] → 页面和报告明确标记“本地演示模型”，不把结果描述为外部事实。
- [关键词式 FakeModel 对自由文本泛化有限] → 只把它作为架构验收替身，所有模型调用经过稳定端口和 schema，后续 Change 替换 adapter。
- [Snapshot JSON 与关系字段可能漂移] → 每个 JSON 带 schemaVersion，读取经 parser/upcaster，关键 revision 和查询字段单列。
- [字段级 revision 与聚合 version 增加复杂度] → 仅对可抽取 Draft 字段使用字段 revision，其他聚合只使用单一 expectedVersion。

## Migration Plan

在现有 `0001_initial.sql` 后追加新迁移，不改写已归档迁移。实施顺序为 Contracts/Domain → migration/repositories → Application → handlers/API → Web。迁移前的自动备份属于后续数据生命周期 Change，本地开发若迁移失败则 Server 不启动；回滚当前未发布切片可删除本地 `.data` 后重建。
