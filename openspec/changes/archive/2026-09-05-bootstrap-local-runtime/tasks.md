## 1. Workspace 与开发工具

- [x] 1.1 创建 `apps/web`、`apps/server`、`packages/contracts`、`packages/domain`、`packages/database`、`packages/model-gateway` 的 TypeScript package，配置 workspace 依赖方向，并通过 `pnpm -r exec tsc --noEmit` 验证类型配置可解析。
- [x] 1.2 安装 React/Vite、Fastify、Zod、Drizzle、`better-sqlite3`、Vitest、tsx 和并行进程编排依赖，补齐根级 `dev`、`test`、`typecheck`、`db:migrate` 脚本，并通过 `pnpm install --frozen-lockfile` 与 `pnpm -r list --depth 0` 验证依赖闭包。
- [x] 1.3 配置 `.data/`、构建输出和测试覆盖率忽略规则，提供不含密钥的 `.env.example`，并通过 `git status --short` 确认本地数据库和环境文件不会进入版本控制。

## 2. 共享契约与领域边界

- [x] 2.1 在 contracts 包定义健康检查、作业快照、取消响应、SSE 事件和统一错误的版本化 Zod schema，使用 schema 解析测试验证有效载荷及非法状态、进度和事件序号会被拒绝。
- [x] 2.2 在 domain 包实现 queued/running/succeeded/failed/cancelled 状态转换、终态保护、租约所有权和重试判定，使用 fake clock/ID 的单元测试覆盖成功、重复领取、过期提交、取消及尝试耗尽。
- [x] 2.3 在 model-gateway 包定义支持 `AbortSignal` 的模型端口和 FakeModel，使用单元测试验证预设成功、结构化失败、延迟和取消均不访问网络且结果确定。

## 3. SQLite 持久化

- [x] 3.1 配置本地 SQLite 连接，使其启用 WAL、foreign keys、busy timeout 并支持 `JRA_DATA_DIR`，使用临时目录测试验证默认/覆盖路径和连接 pragma。
- [x] 3.2 建立 `jobs`、`job_attempts`、`job_events` 与迁移记录的 Drizzle schema 和首个版本化迁移，通过对空数据库连续执行两次迁移验证首次创建和幂等重启。
- [x] 3.3 实现作业 repository 的创建、查询、原子领取、续租、进度、取消、重试和终态提交，通过真实临时 SQLite 集成测试验证两个领取者只能有一个成功且过期 owner 无法提交。
- [x] 3.4 实现作业事件与 attempt 持久化，通过集成测试验证事件序号在单个作业内单调递增、可按游标补放，并且重试保留每次 attempt 结局。

## 4. Worker 与故障恢复

- [x] 4.1 实现类型到处理器的显式 registry、单并发轮询执行器和租约续期，使用短租约集成测试验证长任务持续持有租约且不会被第二个执行器领取。
- [x] 4.2 实现结构化错误分类、默认三次上限和指数退避，通过 fake clock 测试验证可重试错误重新排队、不可重试错误立即失败、耗尽后不再运行。
- [x] 4.3 实现 queued/running 作业取消与处理器安全检查点，使用可阻塞 FakeModel 测试验证排队作业不被领取、运行作业收到 abort 且终态保持幂等。
- [x] 4.4 实现启动恢复与优雅关闭，通过重启集成测试验证过期 running 作业被重新排队或在耗尽时失败，并验证关闭后不领取新作业。

## 5. HTTP、SSE 与 Web 壳

- [x] 5.1 建立 Fastify composition root 和 `GET /api/health`，确保迁移完成后再监听回环地址，通过 Fastify inject 测试验证健康/降级响应及结构符合共享契约。
- [x] 5.2 实现 `GET /api/jobs/:jobId` 与幂等 `POST /api/jobs/:jobId/cancel`，通过 handler 集成测试验证存在、不存在、可取消和已终态作业的响应。
- [x] 5.3 实现 `GET /api/jobs/:jobId/events` SSE 补放与实时推送，通过集成测试验证 `Last-Event-ID` 后续事件、顺序、心跳、断开清理和终态结束行为。
- [x] 5.4 创建最小 React/Vite 页面，展示 API/database/worker 健康状态并封装作业快照与 SSE 客户端；通过组件测试验证健康状态、断线重连游标和错误状态，不添加求职业务界面。
- [x] 5.5 接通根级 `pnpm dev` 对 Web、API 和 Worker 的编排及 Vite `/api` 代理，执行迁移测试、domain/database/server/web 各包的聚焦测试、`pnpm typecheck` 与 `git diff --check`，记录结果且不运行生产 build 或全量 lint。
