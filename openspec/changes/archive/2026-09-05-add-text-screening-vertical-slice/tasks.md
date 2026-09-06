## 1. 领域契约与 Application 骨架

- [x] 1.1 在 `packages/contracts` 定义 Profile、ImportBatch、Opportunity、JobDraft、ResearchRun、ScreeningReport 的 DTO、枚举、Zod schema 与错误映射，并以聚焦契约测试验证合法/非法输入、七维标识和批量上限
- [x] 1.2 在 `packages/domain` 实现七维权重归一化、薪资范围、约束与红旗值对象，并以领域单测验证预设档位、负权重、薪资倒置和默认权重
- [x] 1.3 在 `packages/domain` 实现 UserProfile、ImportBatch、Opportunity、ResearchRun 与 ScreeningReport 聚合不变量，并以领域单测验证版本、状态转换、重复 JD 独立创建和报告不可变性
- [x] 1.4 新建 `packages/application`，定义 Profile、Ingestion、Opportunity、Research Application Interface、CommandReceipt、Repository 与 UnitOfWork 端口，并通过 TypeScript typecheck 验证依赖方向不引用 Server/Web/Drizzle

## 2. 数据库与持久化 Adapter

- [x] 2.1 添加业务迁移，创建 profile、导入、Opportunity/Draft、快照、Run/Checkpoint/Event、Claim/Report 和幂等键所需表及索引，并以迁移聚焦测试验证空库升级成功
- [x] 2.2 实现 UserProfile、ProfileSnapshot、ImportBatch、ImportItem、Opportunity、JobDraft 与 DraftConflict 的 Drizzle repository，并以 repository 测试验证事务回滚、版本递增和字段来源/revision 往返
- [x] 2.3 实现 JobSnapshot、ResearchRun、StageCheckpoint、RunEvent、ResearchClaim、ScreeningReport 与 IdempotencyKey repository，并以 repository 测试验证快照不可变、`runId + stage`/sequence 唯一性和幂等键冲突
- [x] 2.4 实现业务 UnitOfWork 与现有 SQLite Job repository 的同事务协作，并以集成测试验证 Run、快照和 ExecutionJob 要么全部提交、要么全部回滚

## 3. 候选人画像纵向切片

- [x] 3.1 实现 ProfileApplication 的当前资料读取、简历替换、画像更新和 ProfileSnapshot 创建，并以 Application 测试验证简历/画像版本和旧快照不变
- [x] 3.2 实现 `/api/profile` 查询与保存路由、DTO 映射和脱敏错误输出，并以 Server 注入测试验证 400/409、归一化权重和响应不含多余正文
- [x] 3.3 实现 `/profile` 页面，支持简历文本、目标岗位、地点、薪资、通勤容忍度、约束、红旗及七维权重编辑，并以 Web 聚焦测试验证加载、校验、保存和失败不伪装成功

## 4. JD 文本导入与 Draft 纵向切片

- [x] 4.1 实现 IngestionApplication 的 1–20 项批次创建与启动幂等性，在同事务中为每项创建 ImportItem、Opportunity、SourceInput 和 `extract-job-draft` Job，并以 Application 测试验证重复文本仍生成独立 Opportunity
- [x] 4.2 实现 FakeModel 文本抽取器及结构化结果校验，覆盖岗位、公司、地点、薪资、发薪月数、职责、要求和福利，并以聚焦测试验证缺失发薪月数按 12 薪且保留 assumption
- [x] 4.3 注册 `extract-job-draft` Worker handler，完成逐项状态、失败隔离和单项重试，并以 Worker 集成测试验证同批部分失败不影响成功项
- [x] 4.4 实现抽取结果的字段级 revision 合并和 DraftConflict 记录，并以并发测试验证用户编辑不会被迟到抽取覆盖、过期 expectedVersion 返回冲突
- [x] 4.5 实现 Draft 编辑、冲突处理与确认规则，并以领域/Application 测试验证最低字段要求及已确认分析字段修改后自动退回 draft
- [x] 4.6 实现 `/api/import-batches`、单项重试、Opportunity Draft 查询/修改/确认接口，并以 Server 测试验证 URL-only 进入 needs_input、批量上限、409 与 422 映射
- [x] 4.7 实现 `/import` 页面，支持动态添加最多 20 个 JD 文本、展示逐项进度/错误并单项重试，并以 Web 聚焦测试验证单项和批量操作

## 5. 初筛规则与可恢复 Workflow

- [x] 5.1 实现 ProfileSnapshot/JobSnapshot 的 schemaVersion parser 与创建逻辑，并以快照测试验证输入冻结及当前资料变化不改写历史 JSON
- [x] 5.2 实现初筛 Claim 结构、FakeModel 匹配证据生成与引用定位校验，并以单测验证无原文依据的 Claim 被拒绝、七维无有效 Claim 时为 unknown
- [x] 5.3 实现 required/preferred、warning/blocking、薪资总包及七维加权的 RecommendationPolicy，并以决策表测试覆盖五档推荐、blocking 红旗、默认 12 薪置信度和 unknown 不计负分
- [x] 5.4 实现 ResearchApplication 的前置条件、启动幂等、取消和 failed Run child retry，并以 Application 测试验证 confirmed 门槛、同键复用、异载荷 409 及历史 Run 不被改写
- [x] 5.5 实现 `constraint_check → semantic_match → claim_validation → recommendation_policy → screening_report` Workflow 和逐阶段 Checkpoint，并以聚焦测试验证顺序、阶段结果和已提交阶段不会重复执行
- [x] 5.6 注册 `screen-opportunity` Worker handler，原子提交阶段状态/RunEvent，并在完成时保存 Claim/Report 及采用有效报告，并以集成测试验证完成、失败和取消路径
- [x] 5.7 实现 stale/partial/invalidated/effective 判定与当前报告采用策略，并以领域/集成测试验证资料或 Draft 变化后旧报告保留但不再有效
- [x] 5.8 添加至少 10 条脱敏合成 Eval 样本和确定性评测 runner，覆盖正常匹配、字段缺失、证据冲突、硬约束、红旗、薪资和工作过载信号，并验证默认运行不访问网络

## 6. 初筛 API、SSE 与查询模型

- [x] 6.1 实现 Opportunity 历史列表与详情 Read Model，支持关键词、导入/分析状态和推荐档位筛选，并以查询测试验证筛选组合、排序和历史报告完整性
- [x] 6.2 实现启动初筛、Run 查询/取消/重试和 Opportunity 列表/详情接口，并以 Server 测试验证 400/404/409/422/503 映射及幂等 receipt
- [x] 6.3 将业务 RunEvent 接入 SSE，支持 `runId + sequence` 补放且事件不含简历/JD 全文，并以 SSE 集成测试验证断线续传、去重和脱敏
- [x] 6.4 实现 Server 启动后的未完成抽取与初筛恢复，并以重启集成测试验证从下一个未完成 Checkpoint 继续且不重复正式结果

## 7. Opportunity 工作台

- [x] 7.1 配置 TanStack Router 与应用导航，接入 `/profile`、`/import`、`/opportunities` 和 `/opportunities/:id`，并以路由聚焦测试验证直达和刷新
- [x] 7.2 实现 `/opportunities` 历史列表的关键词、状态和推荐筛选，不添加看板，并以 Web 测试验证筛选参数与空/错误状态
- [x] 7.3 实现 Opportunity 详情中的 Draft 字段编辑、冲突提示、显式确认和并发冲突刷新，并以 Web 测试验证 confirmed/draft 转换
- [x] 7.4 实现初筛启动、SSE 进度、取消/重试及断线后的 Query 刷新，并以 Web 测试验证正式报告来自重新查询而非事件拼装
- [x] 7.5 实现当前/历史 ScreeningReport 展示，覆盖五档建议、七维 verdict/confidence、匹配点、风险、未知项、规则、Claim 引用及 FakeModel 标识，并以组件测试验证 unknown、stale、partial、invalidated 状态

## 8. 端到端验收与文档

- [x] 8.1 添加“保存画像 → 批量导入 → 编辑确认 → 初筛 → 查看历史报告”的本地端到端集成测试，并验证单批 20 项和重复 JD 场景
- [x] 8.2 补充业务运行、FakeModel 限制和聚焦验证命令文档，并人工核对文档明确不支持 URL 抓取、截图、真实模型、公司深研、通勤计算和导出
- [x] 8.3 运行受影响包的聚焦测试、workspace typecheck、OpenSpec strict validate 与 `git diff --check`，修复失败并记录验证结果；不得自动运行全量 build 或全量 lint
