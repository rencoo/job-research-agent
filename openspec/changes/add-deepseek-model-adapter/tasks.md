## 1. 契约与持久化基础

- [x] 1.1 在 `packages/contracts` 定义向后兼容的 ModelInvocationConfig、JobDraft 抽取来源、ResearchRun 冻结模型配置和 ScreeningReport 模型来源契约，并以契约测试验证旧本地报告仍可解析、DeepSeek 配置不包含 API Key
- [x] 1.2 添加 SQLite 迁移及 BusinessRepository 映射，持久化可空的 Draft 抽取模型配置和 Run 模型配置，并以迁移/repository 测试验证旧行兼容、JSON 往返和 child Run 配置复制
- [x] 1.3 为 `packages/model-gateway` 添加官方 OpenAI SDK 依赖并更新锁文件，以包级 typecheck 验证依赖仅停留在 Adapter 包

## 2. 模型运行时与 Prompt

- [x] 2.1 扩展 ModelGateway 请求与描述契约，加入 task、promptVersion、instructions、input、schemaName、JSON Schema 和 provider/model descriptor，并以 LocalDemoModel/FakeModel 测试验证既有离线行为保持确定性
- [x] 2.2 实现 DeepSeek Responses API Adapter，支持结构化输出解析、Zod 再校验、AbortSignal 和脱敏错误映射，并以注入伪造 client 的单测覆盖成功、空响应、非法 JSON、Schema 错误、401、429、5xx、超时与取消且不访问网络
- [x] 2.3 实现环境配置解析和 ModelGatewayResolver，默认 local、DeepSeek Base URL 固定、模型默认 `deepseek-v4-flash`，并以配置测试验证缺 Key/非法 provider 明确失败且不静默降级
- [x] 2.4 实现 JD 抽取与六维 Claim 生成的版本化 Prompt builder、Zod JSON Schema 转换及不可信输入边界，并以快照/结构测试验证模型不能负责最终推荐
- [x] 2.5 实现手机号、邮箱确定性脱敏和外部 provider 最小上下文组装，并以单测验证原始快照不变、技术内容保留、联系方式及脱敏占位符不会成为 Claim 证据

## 3. 导入与初筛集成

- [x] 3.1 将抽取模型配置冻结到 Import Job 并在成功后写入 JobDraft，Worker 通过 Resolver 执行指定 provider，并以 Application/Worker 测试验证 local、DeepSeek 替身、单项非法输出失败隔离和单项重试
- [x] 3.2 在创建 ResearchRun 时冻结筛选模型配置和 Prompt 版本，child retry 沿用父配置，并以 repository/Application 测试验证环境配置变化不改写已有 Run
- [x] 3.3 将 semantic_match 接入版本化 Prompt、PII 脱敏、Resolver 和原文引用校验，并在 ScreeningReport 写入与 Run 一致的模型来源；以集成测试验证 DeepSeek 替身报告、旧本地报告读取和无依据 Claim 被拒绝
- [x] 3.4 校准 Worker 模型错误处理，使可重试错误进入现有有限重试、不可重试错误立即失败、事件只含安全摘要，并以 Worker/Server 测试验证 429、401、取消和日志/事件不泄露 Key、简历、JD 或完整 Prompt

## 4. 显式验证与使用文档

- [x] 4.1 新增不属于默认测试链路的 `test:deepseek-live` 合成 smoke/Eval 入口，要求 `JRA_RUN_LIVE_EVAL=1` 和 API Key，并以无开关时明确拒绝、伪造配置时不被默认 `pnpm test` 调用来验证费用边界
- [x] 4.2 更新 `.env.example` 与 README，记录 DeepSeek 环境变量、隐私披露、模型来源识别、local 回滚方式以及不包含联网公司研究等边界，并人工核对文档不含真实 Key
- [x] 4.3 运行受影响包聚焦测试、workspace typecheck、OpenSpec strict validation 与 `git diff --check`，修复失败并记录结果；不得自动运行全量 build 或全量 lint，也不得执行真实 DeepSeek live Eval，除非用户另行明确授权产生外部请求和费用
