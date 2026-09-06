## Context

仓库当前只有根级 pnpm 配置与 OpenSpec，没有应用代码、数据库或测试设施。本 Change 是后续文本岗位筛选纵向切片的运行基础，行为约束见 `specs/local-runtime/spec.md`。

应用定位为单用户、本地优先的 Web 应用：浏览器承载界面，本机 Node 进程承载 API、SQLite 和后台执行器。当前不引入云端部署、账户体系或多设备同步。

## Goals / Non-Goals

**Goals:**

- 建立边界清晰、可独立测试的 Web、HTTP、领域、持久化与模型适配结构。
- 保证长耗时 AI/研究任务不会阻塞 HTTP 请求，并能在进程重启后可靠恢复。
- 让前端通过快照查询与 SSE 事件流获得一致的作业状态。
- 为后续业务 Change 提供共享契约，而不提前固化岗位分析领域模型。

**Non-Goals:**

- 不接入真实 LLM、搜索或网页抓取服务。
- 不实现用户画像、简历、岗位、公司或报告数据结构。
- 不提供公网监听、远程访问、账户鉴权、桌面壳或生产部署。
- 不为多个进程或多台机器提供分布式任务队列。

## Decisions

### 1. 使用 pnpm monorepo 分离运行边界

- `apps/web`：React、TypeScript、Vite，只通过共享 contracts 与 API 通信。
- `apps/server`：Fastify HTTP 服务和同进程 Worker 生命周期管理；API handler 不直接执行长任务。
- `packages/contracts`：Zod 请求、响应、事件和错误契约，可由 Web 与 Server 共享。
- `packages/domain`：不依赖框架的作业状态机、端口和领域错误。
- `packages/database`：SQLite 连接、Drizzle schema、migration 和 repository 实现。
- `packages/model-gateway`：模型端口及 FakeModel；真实供应商适配器留给后续 Change。

选择 monorepo 是为了让前后端共享经过校验的契约，同时维持依赖方向。备选的单包结构初期文件更少，但会快速混合 UI、HTTP、数据库和模型代码。

### 2. 本地开发由一个根命令编排两个进程

根级 `pnpm dev` 并行启动 Vite 和 Server；Server 内部启动 Worker。Vite 将 `/api` 代理到仅监听 `127.0.0.1` 的 Fastify。关闭 Server 时先停止领取新作业，再等待当前处理器到达安全检查点并释放资源。

不在此阶段引入 Electron/Tauri。浏览器 Web 形态开发反馈更快，本地回环监听仍满足当前单机产品边界，后续若需要桌面壳可复用 HTTP 与领域层。

### 3. 使用 SQLite、Drizzle 与显式迁移

数据库默认位于仓库忽略的 `.data/job-research-agent.sqlite`，测试使用独立临时数据库；允许通过 `JRA_DATA_DIR` 覆盖数据目录。采用 WAL、foreign keys 和 busy timeout，减少 HTTP 查询与 Worker 写入之间的锁冲突。

迁移文件进入版本控制，由独立 `db:migrate` 脚本执行；Server 启动时先运行迁移再开放端口。选择 SQLite 是因为产品单用户、本地优先；暂不引入需要额外服务的 PostgreSQL。

### 4. 以数据库表实现可恢复作业队列

最小持久化模型包括：

- `jobs`：ID、类型、版本化 JSON 输入、状态、进度、结果引用、取消标记、尝试次数、最大尝试次数、租约 owner/expiry、错误摘要和时间戳。
- `job_attempts`：每次执行的开始/结束、worker ID、结局和错误摘要。
- `job_events`：作业内单调递增序号、事件类型、版本化 JSON payload 和创建时间。
- `schema_migrations`：已执行迁移记录。

Worker 在短事务内领取最早可执行作业并写入租约；耗时处理在事务外进行，按固定间隔续租。每次提交进度或终态都校验 job ID、running 状态和 lease owner，防止过期执行器覆盖新结果。

单机数据库队列比引入 Redis/BullMQ 更符合本地产品形态，也减少安装成本。并发执行数默认 1，但执行器接口保留配置入口。

### 5. 重试只覆盖可重试故障

作业默认 `maxAttempts = 3`。处理器返回结构化错误并标记 `retryable`：临时网络错误、限流和进程中断可以指数退避重试；输入无效、主动取消和明确的业务拒绝直接进入终态。持久化中只保存经过清理的错误 code/message，不保存密钥、完整响应或堆栈。

统一限制次数可以避免后台任务无限消耗模型 token。不同业务若需要不同阈值，可在创建作业时显式覆盖，但必须保持有限值。

### 6. HTTP 返回快照，SSE 传递增量事件

基础公开接口为：

- `GET /api/health`：返回 API、database、worker 的健康状态。
- `GET /api/jobs/:jobId`：返回作业快照。
- `POST /api/jobs/:jobId/cancel`：幂等提交取消请求。
- `GET /api/jobs/:jobId/events`：SSE 订阅；读取 `Last-Event-ID`，也接受等价查询参数便于测试。

业务 Change 通过应用服务创建具体类型作业，不提供允许任意 payload 的公共通用创建接口。SSE 连接先从数据库补放缺失事件，再订阅进程内通知；数据库是事实来源，进程内通知只用于降低延迟。前端断线或错过通知时，重新查询快照即可收敛。

### 7. 契约与时间相关逻辑必须可注入

所有 HTTP 输入、JSON payload 和 SSE 事件先经过 Zod 解析。领域层以端口依赖 job repository、clock、ID generator 和 model gateway；生产实现与测试替身在 composition root 组装。FakeModel 支持预设成功、结构化失败、延迟和 AbortSignal，以确定性覆盖恢复与取消场景。

测试采用 Vitest：领域状态机做纯单元测试，repository 使用真实临时 SQLite，Server 使用 Fastify inject，SSE 和重启恢复做集成测试。Web 在本 Change 只验证启动、健康状态显示和事件消费适配器，不构建业务界面。

## Risks / Trade-offs

- [SQLite 同时写入可能产生锁等待] → 启用 WAL/busy timeout，保持事务短小，默认单 Worker 并发。
- [API 与 Worker 同进程导致进程崩溃时同时中断] → 所有执行状态先持久化，依靠租约过期恢复；保留未来拆分 Worker 的模块边界。
- [SSE 连接丢失进程内通知] → 事件先落库，重连按事件序号补放，并提供作业快照查询作为最终一致性兜底。
- [通用作业模型过早抽象] → 仅固定生命周期与可靠性字段，业务输入和结果采用带版本的类型化 payload，由后续 Change 定义。
- [Node 原生 SQLite 生态兼容性变化] → 使用有稳定 Drizzle 支持的 SQLite driver，并通过 Node 24 的 CI/本地测试锁定运行基线。

## Migration Plan

这是空仓库的首次运行时引入，无历史数据迁移。实施时先建立包结构和契约，再提交初始数据库迁移，最后接入 API、Worker 与 Web 壳。任一步失败都可删除未提交的本地 `.data` 数据库并重新执行迁移；已提交迁移不得原地改写，只能追加修正迁移。
