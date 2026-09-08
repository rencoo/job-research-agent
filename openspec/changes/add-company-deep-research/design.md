## Context

参见 proposal.md。当前 ModelGateway 已支持结构化输出与 DeepSeek；Run 只执行初筛，Claim 为简历/JD 双引用。Web 有未提交的页面改动，本次在独立深研组件内扩展。

## Goals / Non-Goals

实现可恢复的岗位深研、公司共享快照和证据闭环。不重写初筛、不引入通用 Agent 框架或向量数据库。

## Decisions

### 流程与对象

Opportunity → ResearchRun（冻结 JD/Profile/初筛/配置）→ CompanyResolution → CompanyResearchSnapshot → ResearchPlan → SourceDocument → Claim/EvidenceLink → DeepResearchReport。
公司候选必须由已读取页面支持；品牌、官网与法律主体分别记录。身份歧义进入 needs_attention，选择/补充后继续，跳过则公司维度未知。公司事实属于快照，个人适配结论属于 Run。

### 深模块及依赖

ResearchApplication 接收启动、确认、取消、重试命令；CompanyRepository 管理身份和快照；DeepResearchRepository 管理 Run 元数据、文档、证据与报告。Workflow 注入 ModelGateway、SearchPort、PageReaderPort，不依赖模型供应商 SDK。SearchPort 使用 Tavily HTTP Adapter/FakeSearch；PageReader 使用安全 HTTP + Readability/jsdom，必要时无登录态 Playwright。采用已有 Worker，避免独立编排基础设施。

### 持久化与恢复

Run 新增 kind，旧数据默认为 screening。研究元数据单独持久化，阶段、轮次、单页成功结果均 checkpoint。公司刷新使用数据库唯一活跃租约，以 Run 为 owner；等待者释放执行槽，周期检查 owner 完成/失败/取消后重新入队。同公司并发调用的第二个 Run 不重复刷新。取消、重试、崩溃恢复保持冻结输入与预算；报告按输入版本决定 effective。初筛与深研分别保存当前引用。
抽取/初筛并发 2，研究并发 1。工具调用前记录计数，执行时间跨重试累计，用户确认等待不占运行时间。停止条件：问题覆盖满足、连续两轮无新有效 Claim、30 分钟、100 次工具调用。每轮限制搜索结果与页面量，模型输出按 Schema 与引用验证。

### 证据与评估

网页、JD、简历固化为 SourceDocument；EvidenceLink 记录 documentId、quote、start/end、支持/反驳。代码验证文档归属及引用，模型独立核验蕴含关系。搜索摘要不充当证据。按内容哈希及来源归属去重，不将转载视为独立佐证。官网自述保留归因，冲突为 contested，无依据为 unknown/unsupported，非法引用 rejected。六维评估只能引用有效 Claim；模型给出解释，确定性 Domain 决定推荐，不能将缺失条件直接当作不满足。

### 默认值与访问策略

公司快照默认 7 天并按覆盖问题判断可复用，手动刷新绕过缓存。首期 Tavily 不开启 answer/raw_content；正文由 PageReader 管理。所有连接和重定向固定已验证公网 IP，限制时间/体积，浏览器通过校验代理读取子资源，禁用登录态、下载与 service worker。网页只作为不可信数据。环境变量配置真实工具；离线演示使用合成公司，不伪造真实公司的联网事实。

### 接口与界面

新增 POST /api/opportunities/:id/deep-research-runs、POST /api/runs/:id/attention-responses、GET /api/opportunities/:id/deep-research、GET /api/deep-research-reports/:id、GET /api/source-documents/:id、GET /api/companies/:id/snapshots。已有 Run 查询/SSE/取消/重试按 kind 分派。刷新由启动参数 refreshCompany=true 发起；公司补充后支持创建 continuation Run。页面展示阶段、问题/来源数、公司候选与选择/补充/跳过、六维结果、风险、未知项与证据展开。

## Risks / Trade-offs

- 搜索或网页不可达 → 保存读取失败，报告 partial；鉴权配置失败显式报错。
- 模型幻觉/网页指令 → 结构化输出、最小上下文、引用与蕴含复核；不赋予模型工具权限。
- 浏览器 SSRF → 所有请求经公网校验和固定地址连接，阻止非 HTTP 协议及 WebSocket。
- 外部请求在进程崩溃后可能重复 → 调用前计数、成功结果固化；不承诺外部 exactly-once。

## Migration Plan

增加新表和默认值，不改写旧 JSON。沿用启动迁移前备份机制；迁移事务失败不启动 Worker。回滚代码前恢复迁移前备份。先离线验证，再由用户显式执行联网 smoke。现有 UI 修改保留，不执行 build/全量 lint。

## Validation

2026-09-08 完成实现与验证：

- Server 聚焦测试 49 项（deep-research、worker、business-app、business-api）。
- Web 聚焦测试 26 项（deep-research-panel、pages、api）。
- Research tools 18 项、Contracts 11 项、Database 聚焦测试 12 项；合计 116 项通过。
- workspace typecheck、此 Change 的 OpenSpec strict validation、git diff --check 通过。
- 独立临时数据库 + 离线模型浏览器闭环：启动深研、确认公司、部分报告、展开证据；1440px 桌面与 390px 窄屏无横向溢出、无 pageerror。
- 真实 Chromium + 合成 HTTP 响应验证 JS 后备，中文正文正确；页面、脚本及私网子请求均被拦截器接管，私网请求被拒绝。
- 未执行 build、全量 lint、Tavily 联网 smoke 或真实模型调用。真实外部服务可达性和模型事实质量尚未通过 live 验证。

实现细节补充：公司主题逐项提取/复核后才记为覆盖；时间上限通过 AbortSignal 中断在途工具，随后提交 partial 报告。阶段异常只允许仍持有 Job 租约的 Worker 更新 Run；周期协调器将耗尽恢复次数的 Job 同步为失败 Run，释放公司刷新锁。
