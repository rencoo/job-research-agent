## Why

项目目前只有规范工具和最小包管理配置，尚不存在可运行、可持久化、可恢复的应用底座。先建立本地优先的 Web、API、数据库与后台任务运行时，后续简历、岗位分析和公司研究能力才能以稳定的纵向切片逐步交付。

## What Changes

- 建立 pnpm workspace，划分 Web 应用、API/Worker 应用以及共享 contracts、domain、database、model-adapter 包。
- 提供统一的本地开发入口，使 Web、API 和后台 Worker 能够协同启动与关闭。
- 引入 SQLite 与版本化迁移，建立后台作业、执行尝试和事件所需的最小持久化结构。
- 建立可恢复的后台作业执行机制，包括原子领取、租约、重试、取消和进度事件。
- 提供健康检查、SSE 事件订阅以及 FakeModel 测试适配器，为后续 AI 分析能力提供可验证边界。
- 本 Change 不包含用户画像、简历、JD 导入、匹配分析、公司研究或正式模型接入。

## Capabilities

### New Capabilities

- `local-runtime`: 本地应用启动、SQLite 迁移、后台作业生命周期、故障恢复和实时事件订阅的运行时约束。

### Modified Capabilities

无。

## Impact

- 新增 workspace 应用与共享包目录，以及根级开发、测试和数据库脚本。
- 新增 Fastify、React/Vite、Drizzle/SQLite、Zod、SSE 和测试相关依赖。
- 新增本地 SQLite 数据文件及迁移目录；数据文件不提交到 Git。
- 为后续能力定义稳定的 HTTP、事件和后台作业边界，但不引入任何具体求职业务接口。
