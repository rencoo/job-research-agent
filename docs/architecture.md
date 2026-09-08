# Job Research Agent 完整架构实施计划

## 1. 基线与分层

先固化共同语言和不可逆决策：

- `CONTEXT.md`：纯领域词汇、对象关系和严格定义。
- `docs/product-spec.md`：产品流程、输入输出、页面和 MVP 边界。
- `docs/architecture.md`：分层、数据流、状态机、事务、恢复和 ADR 索引。
- ADR 记录本地模块化单体、不可变分析快照、显式 Workflow 三项决策。

Workspace：

```text
apps/web                 React + Vite + TanStack Router/Query
apps/server              Fastify、Worker、Drizzle、Application 实现与 Adapter
packages/contracts       Zod DTO、错误和 SSE Event
packages/domain          聚合、值对象、决策规则、不变量
packages/agent-runtime   Workflow、Prompt、ContextBuilder、ModelPort
packages/research-tools  SearchPort、PageReaderPort、AccessPolicy
```

依赖方向：

```text
Web → Contracts → HTTP Adapter → Application → Domain
                                  ↓
                      Agent Runtime / Repository Interfaces
                                  ↑
                         Infrastructure Adapters
```

Domain 不依赖 Fastify、Drizzle、文件系统或模型 SDK。Route 一个用户意图只调用一个 Application Interface，不负责事务和业务编排。

## 2. Application 与领域模型

七个深 Application Module：

```text
IngestionApplication
ProfileApplication
OpportunityApplication
CompanyApplication
ResearchApplication
ConversationApplication
ExportApplication
```

主要 Interface：

- Ingestion：`importBatch`、`retryItem`、`confirmDraft`
- Profile：`importResume`、`updateProfile`
- Opportunity：`updateDraft`、`recordDecision`、`recordApplicationEvent`、回收站与永久删除
- Company：`resolveForOpportunity`、`respondToResolution`、`refreshResearch`
- Research：`startScreening`、`startDeepResearch`、`respondToAttention`、`resume`、`cancel`、`retryFailed`
- Conversation：`sendMessage`、`acceptProposal`、`rejectProposal`
- Export：`exportOne`、`exportBatch`

Transport DTO 映射为 Application Command，再转换为 Domain 值对象。Command 成功返回轻量 `CommandReceipt`；Query 使用独立 Read Model。导入和启动 Run 接受幂等键，其他命令依靠聚合状态及 `expectedVersion` 防重和处理并发。

核心聚合：

- `UserProfile`
- `Opportunity`
- `Company`
- `ResearchRun`
- `ImportBatch`

不可变对象：

- `ProfileSnapshot`
- `JobSnapshot`
- `CompanyResearchSnapshot`
- `ScreeningReport`
- `DeepResearchReport`

Opportunity 代表一次工作机会，至少拥有一个 `SourceInput` 即可创建。重复 JD 创建新 Opportunity。公司以展示名、别名和法律主体表示；未确认主体时只保存候选项。

证据模型：

```text
SourceInput        用户提交的文本、链接或截图
SourceDocument     实际读取并固化的内容
ResearchClaim      单一、可独立验证的主张
EvidenceLink       支持或反驳 Claim 的来源片段
Artifact           简历、截图等文件引用
```

Claim 状态为 `supported | contested | unsupported | unknown | rejected`。公司 Claim 属于公司快照，岗位 Claim 属于 Run。没有有效 Claim 的评测维度必须为 unknown。

## 3. 数据流、状态和接口

### 核心数据流

```text
混合输入
→ ImportBatch/Item/Opportunity
→ 异步 ExtractionAttempt
→ 合并到可编辑 JobDraft
→ 用户确认 Draft
→ 冻结 Job/Profile Snapshot
→ 同事务创建 ResearchRun + ExecutionJob
→ Worker 执行 Workflow
→ StageResult/Checkpoint/RunEvent
→ Claim 与报告
→ Opportunity 采用有效报告
→ Query/SSE 更新 Web
```

所有输入统一异步处理。批量最多 20 项，每项独立成功或失败。Draft 字段记录来源和 revision；迟到的模型结果只能填充未被用户修改的字段，冲突进入待确认列表。

初筛：

```text
constraint_check
→ semantic_match
→ claim_validation
→ recommendation_policy
→ screening_report
```

深研：

```text
resolve_company
→ select_or_refresh_company_snapshot
→ build_research_plan
→ gather_sources
→ build_claims
→ assess_dimensions
→ recommendation_policy
→ deep_research_report
```

深研要求当前、非 stale 的初筛报告。公司不确定时允许继续生成 partial 报告；用户也可以确认公司并创建 continuation Run。

### Run 与 Job

```text
RunStatus:
queued | running | waiting | needs_attention |
cancelling | cancelled | completed | failed | superseded
```

`currentStage` 与 RunStatus 分开。一个 Run 可以产生多个 ExecutionJob；每次 Stage 调用产生 StageAttempt，只有成功提交的 Attempt 成为 Checkpoint。

严格转换：

```text
queued → running | cancelling
running → waiting | needs_attention | completed | failed | cancelling
waiting → queued | cancelling | superseded
needs_attention → queued | cancelled | superseded
cancelling → cancelled
completed/cancelled/superseded → terminal
failed → 创建 child Run
```

`waiting` 由系统依赖或退避自动解除；`needs_attention` 必须通过类型化 `AttentionResponse` 处理。输入改变时原 Run 进入 superseded，并记录 successorRunId。

Worker 使用 SQLite 持久化 Job、租约和心跳。抽取/初筛并发 2，深研并发 1。同公司只允许一个 active refresh，等待者通过 dependencyId 唤醒。

### 报告与评测

报告状态：

- `partial`：研究覆盖不足，但已有内容有效。
- `stale`：输入、画像或公司快照变化。
- `invalidated`：关键来源删除或 Claim rejected。

Run 期间输入变化时，报告保留为历史但不自动采用。partial 报告可自动采用；invalidated 报告不能作为 effective current report。

六个顶层维度：

```text
people_and_company_reliability
life_radius
compensation_package
workload_and_role_boundaries
work_content
career_growth
```

`work_content`（工作内容）评估日常做什么以及是否对味，并包含主导权与产品方向。

每项输出：

```ts
type DimensionAssessment = {
  verdict: "positive" | "mixed" | "negative" | "unknown";
  confidence: "high" | "medium" | "low";
  claimIds: string[];
  risks: string[];
  unknowns: string[];
};
```

约束分为 `required | preferred`，红旗分为 `warning | blocking`。确定性决策表负责硬门槛、红线、薪资总包和最终档位；模型只负责证据归纳与解释。未注明发薪月数时按 12 薪计算并标记默认假设。

### REST 与 SSE

资源入口：

```text
/api/profile
/api/import-batches
/api/opportunities
/api/companies
/api/runs
/api/settings
/api/exports
/api/trash
```

`GET /api/runs/:id/events` 提供 SSE。RunEvent 与状态同事务提交，事件使用 `runId + sequence` 去重和断线续传。正式报告不通过逐 Token SSE 构建；Chat 使用独立文本流，完成后一次持久化消息。

公共结果：

```ts
type UseCaseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApplicationError };

type ApplicationError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};
```

映射规则：

- validation：400
- not_found：404
- version_conflict：409
- domain_precondition：422
- infrastructure_unavailable：503

`needs_attention` 和网页 `blocked` 属于成功业务结果，不作为 HTTP 错误。

## 4. 持久化、AI Runtime 与安全

使用 Drizzle + `better-sqlite3`：

- UUIDv7 作为领域 ID，时间统一保存 UTC。
- 不可变快照以带 schemaVersion 的 JSON 保存，常用筛选字段单独索引。
- Claim、EvidenceLink、SourceDocument、Run、Job 和事件规范化存储。
- 历史关键词搜索使用 SQLite FTS5。
- 旧 JSON 通过 upcaster 读取，不重写历史快照。
- Migration 前备份 SQLite，保留最近 5 份；失败时不启动 Worker。

Artifact 先写临时文件并计算哈希，数据库提交引用后原子 rename。删除先 tombstone 引用，再异步清理无引用文件。永久删除 Opportunity 前先取消并等待活跃 Run；超时进入 `deletion_pending`。

ModelPort：

```text
generateStructured
streamText
runToolLoop
analyzeImage
```

实现 OpenAI Responses 与 OpenAI-compatible Chat Completions 两个 Adapter，并配置 `screening / research / vision` 三种模型角色。Prompt 代码化、版本化；每次 Run 固化版本和模型配置。

Research Tools：

- Tavily Search Adapter
- HTTP + Readability PageReader
- 无登录态 Playwright 后备
- ContextBuilder 按阶段、来源等级、相关性和 Token 预算选取片段
- 外部页面一律视为不可信数据，不允许影响工具权限
- 只允许 HTTP/HTTPS 公网地址，每次重定向重新校验 DNS/IP
- 不携带 Cookie，不绕过登录、验证码或平台限制

正常研究以“覆盖满足”或“连续两轮无新 Claim”为停止条件；异常保护为最长 30 分钟或 100 次工具调用。

安全默认：

- Server 只监听 loopback，严格 Origin、同源 Cookie/启动令牌、禁用开放 CORS。
- API Key 保存到系统 Keychain，环境变量可覆盖。
- 日志脱敏并保留 14 天，不记录简历/JD/网页全文、Prompt 全文或密钥。
- 模型只接收当前 Stage 所需的最小资料；搜索词不得包含个人联系方式。
- MVP 依赖 macOS 文件权限与 FileVault，不实现应用层加密。

## 5. 实施与验证

### 第一阶段：规范和骨架

- 建立 workspace、TypeScript 配置和包依赖规则。
- 写入 Product Spec、CONTEXT、Architecture、状态转换和关键数据流。
- 建立 Contracts、Domain、UnitOfWork、Repository Interface、Fake Adapter。
- 不提前创建未被用例使用的数据库表。

### 第二阶段：首个垂直切片

完成：

```text
文本导入
→ ImportBatch/Opportunity
→ 异步抽取
→ JobDraft 确认
→ ScreeningRun
→ Worker/Checkpoint
→ ScreeningReport
→ SSE
→ 历史列表与详情
→ 重启恢复
```

先使用 FakeModel 跑通，再接真实模型 Adapter。

### 后续切片

1. 简历、Profile、红线、薪资和推荐决策表。
2. 批量、链接、截图、抽取冲突和用户修正。
3. 公司解析、Tavily、PageReader、Claim/Evidence 和深研。
4. Chat、ChangeProposal、HR/面试反馈和简历修改建议。
5. 回收站、单个 Markdown 和批量 ZIP 导出。

ZIP 只包含独立 Markdown 报告，不默认包含附件，也不生成额外索引。

### 测试与验收

- Domain：聚合不变量、决策表、状态转换、stale/invalidated、12 薪默认。
- Contracts：DTO、错误、SSE 判别联合和模型 Schema。
- Server：事务、乐观并发、幂等、Worker 租约、取消、等待、恢复和备份。
- Evidence：冲突来源、拒绝 Claim、来源删除和引用完整性。
- Research Tools：公开页、JS 后备、blocked 页面、SSRF 和正文截断。
- Web：导入、Draft 确认、SSE 恢复、历史筛选、报告状态和导出。
- 至少 10 条脱敏/合成 AI Eval，覆盖缺失、冲突、红线和过载信号。
- 默认测试使用 FakeModel/FakeSearch；真实模型评测通过显式命令运行。
- 日常验收只运行聚焦测试、typecheck 和 `git diff --check`，不自动运行全量 build 或全量 lint。

## Assumptions

- macOS 首发、单用户、无账号、无云同步、无外部遥测。
- MVP 是浏览器 Web UI + 本机服务，不是桌面安装包。
- 首页是混合输入入口；历史使用列表、搜索和筛选，不做看板。
- 只维护一份当前简历，报告提供岗位定制修改建议。
- 不自动抓取 BOSS、不使用登录态、不自动投递或开聊。
- 浏览器插件、地图通勤计算、桌面打包、语义检索和 SaaS 均不属于 MVP。

## 公司与岗位深研实现（2026-09-08）

公司识别默认在歧义时暂停并展示候选与原文依据；用户可以选择、补充线索或跳过。跳过时不采用未确认公司的网页证据。

页面读取失败时，可将搜索摘要固化为 `method=search_snippet` 的资料用于公司候选识别，并在界面明确标记。摘要不能触发自动确认公司，也不进入正式 Claim 提取与引用链；正文不足时仍按覆盖不足生成 partial 报告。公司识别和 Claim 模型异常统一交由 Worker 错误路径分类、退避或失败重试，不能转换为主体歧义或成功报告。失败后的 child Run 复用成功 I/O checkpoint，重新执行失败的模型调用。

```text
Opportunity → ResearchRun → CompanyResolution
                              ↓
                    CompanyResearchSnapshot
                              ↓
ResearchPlan → SearchPort → PageReaderPort → SourceDocument
                                              ↑
DeepResearchReport → ResearchClaim → EvidenceLink
```

实现模块：`apps/server/src/deep-research.ts` 编排与 Application、`research-prompts.ts` 结构化提取/独立复核、`packages/research-tools` 搜索/公网访问/正文读取、`packages/database/src/research-repository.ts` 持久化。现有 `model-gateway` 继续承担模型 Adapter，不增加平行模型框架。

公司快照按身份、模式、7 天有效期及六个公司主题的覆盖复用。品牌、法律主体、官网分别保存；公司快照不含个人简历。每个 Claim 指向 SourceDocument 的逐字引用，代码校验引用和模型独立复核语义均通过才可使用；冲突并列保留。

初筛与深研分别保存 current report 引用。ResearchRun.kind 默认为 screening，新增 deep_research；深研状态、预算、当前问题、身份确认版本独立存储。暂停/等待结束当前 ExecutionJob，后续创建新 Job；同公司刷新由数据库锁协调。快照保存后释放锁，等待者随后复用；失败/取消也释放并唤醒。Worker 分为两个抽取/初筛槽及一个研究槽。

研究调用前计数，成功 I/O 和轮次结果持久化，重启复用；最长 30 分钟、100 次调用，child retry 继承消耗。完成条件为覆盖满足或连续两轮无新有效 Claim。预算不足、受限网页或缺少公司身份产出 partial；鉴权/模型错误明确失败，不切换演示数据。历史报告在输入变化或采用更新公司快照后视为 stale。

PageReader 使用 HTTP + Readability/jsdom 与无登录态 Playwright 后备。HTTP DNS 校验后固定 socket 地址，每次重定向重复校验；浏览器请求通过同一安全读取器履约，禁用 service worker、WebSocket、Cookie、下载和非 GET 请求。默认 15 秒 HTTP 超时、2 MB 响应体、6 次重定向、60k 正文字符；浏览器额外限制 30 个子请求。

REST 入口：岗位 deep-research-runs（支持 refreshCompany/parentRunId）、岗位 deep-research 查询、Run attention-responses、deep-research-reports、source-documents、companies/:id/snapshots。沿用 Run SSE/取消/重试。研究页面展示阶段、覆盖问题、资料数量、候选依据和报告证据。

默认 `JRA_RESEARCH_MODE=demo` 仅返回标识清楚的合成公司资料。`live` 使用已配置真实模型与 Tavily；公开页面可能不可达，不能保证查清所有维度。实时联网 smoke 不加入默认测试。
