## Context

见 `proposal.md` 的 Why。当前 `ModelGateway` 只有 `generateStructured`，调用者仅传入简短 Prompt、任务 metadata 和校验函数；`LocalDemoModel` 同时承担任务识别与确定性结果生成。`apps/server/src/main.ts` 固定实例化本地模型，`ScreeningReport.modelLabel` 又被契约写死为“本地演示模型”。

本 Change 跨越模型传输、Prompt、Contracts、Run 快照、SQLite 和 Worker 错误处理。实现必须保留当前六维评测和确定性推荐规则，不覆盖现有 Web 未提交改动，也不能让默认测试访问网络。

## Goals / Non-Goals

**Goals:**

- 让同一业务 Workflow 可显式选择本地模型或 DeepSeek，而不在业务层依赖 DeepSeek SDK。
- 真实模型只产生结构化抽取结果和候选 Claim，Zod、原文引用与确定性规则仍是正式结果门禁。
- 冻结并展示 provider、模型与 Prompt 版本，使重启、重试和历史报告可解释。
- 在外发前去除手机号、邮箱等与匹配无关的直接身份信息。

**Non-Goals:**

- 不实现 UI/Keychain 密钥管理、任意 OpenAI-compatible endpoint、模型自动选择或多 Key 轮转。
- 不实现 DeepSeek 联网搜索、公司深研、图片输入、流式 Chat 或 Prompt 管理后台。
- 不用真实模型改写硬约束、红旗、薪资和最终推荐规则。

## Decisions

### 1. 使用 DeepSeek Responses API Adapter，业务层只依赖扩展后的 ModelGateway

`packages/model-gateway` 增加 DeepSeek Adapter 和运行时配置解析，使用官方 OpenAI JavaScript SDK，Base URL 固定为 `https://api.deepseek.com`。默认模型为 `deepseek-v4-flash`，允许通过 `JRA_DEEPSEEK_MODEL` 显式覆盖。

`ModelRequest` 增加稳定的 `task`、`promptVersion`、`instructions`、`input`、`schemaName` 和 JSON Schema；保留 `validate` 作为返回值进入业务层前的最终门禁。调用 Responses API 时选择 JSON Schema 输出，解析后再次调用 `validate`。

选择 Responses API 而不是只依赖 JSON Object Mode，是因为现有领域 DTO 已有 Zod Schema，可以生成更强的结构约束。选择官方 SDK 而不是手写 HTTP，是为了复用 AbortSignal、状态码和连接错误语义；Adapter 仍包住 SDK，避免泄漏到 Application/Domain。

### 2. Prompt 在 Server 侧代码化并版本化

`apps/server` 增加任务 Prompt builder：

- `extract-job-draft/v1`：输入一个不可信 JD 文本，只输出现有 `ExtractedJobSchema` 字段，不推测缺失发薪月数。
- `screen-opportunity/v1`：输入脱敏简历、冻结 JD 和六维标识，只生成有双侧原文短引用的候选 Claim，不输出最终推荐。

Prompt builder 负责把输入标记为不可信数据并明确 JSON 任务；Model Adapter 不理解招聘领域。业务层使用 Zod 的 JSON Schema 转换结果填充 `ModelRequest`。

备选方案是让 DeepSeek Adapter 根据 metadata 拼 Prompt，但这会把领域知识塞进基础设施 Adapter，后续模型替换和 Prompt Eval 都更困难。

### 3. 通过不可变 ModelInvocationConfig 固化调用来源

新增可序列化 `ModelInvocationConfig`：`provider`、`model`、`promptVersions`。配置不包含 API Key。

- 导入批次创建抽取 Job 时，将模型配置写入 Job payload；成功后保存到 JobDraft 的可选 `extractionModel`。
- ResearchRun 创建时将当前筛选模型配置保存到新增 SQLite JSON 列；child retry 复制父 Run 配置。
- Worker 通过 ModelGatewayResolver 按冻结配置解析 Adapter；若当前进程无法提供该冻结配置，则明确失败，不换模型继续。
- ScreeningReport 保留向后兼容的 `modelLabel` 字符串，并增加可选 `modelConfig`。旧报告缺少新字段时映射为本地 legacy 配置，不重写历史数据。

这满足架构基线“每个 Run 固化模型配置和 Prompt 版本”，也避免服务重启后环境变量变化导致同一 Run 悄悄换模型。

### 4. 环境变量是本 Change 唯一凭据入口

支持：

```text
JRA_MODEL_PROVIDER=local|deepseek
DEEPSEEK_API_KEY=<secret>
JRA_DEEPSEEK_MODEL=deepseek-v4-flash
```

provider 缺省为 `local`。选择 `deepseek` 时在启动阶段验证 Key 和模型名；验证失败直接终止启动。`.env.example` 只记录变量名和非秘密默认值，真实 Key 不写入仓库。Keychain 按既有架构保留给后续 Change。

Base URL 不开放环境变量覆盖，防止配置错误把简历发送给未知服务。未来通用 OpenAI-compatible Adapter 应通过独立 Change 引入 endpoint allowlist。

### 5. 外发前执行确定性 PII 脱敏和最小上下文组装

只对发往外部 provider 的简历执行手机号、邮箱模式替换，保留技术经历与岗位相关内容。原始 ProfileSnapshot 不变；模型看到脱敏副本，`validateClaims` 仍针对原始快照检查证据。Prompt 禁止引用脱敏占位符作为匹配 Claim。

JD 本身按当前阶段完整发送，因为结构化抽取和双侧引用需要原文。日志、错误与 RunEvent 只记录 provider/model/task/error code，不记录 SDK 响应正文或请求正文。

### 6. 错误映射复用 Worker 生命周期

DeepSeek Adapter 统一抛出 `ModelGatewayError(code, message, retryable)`：

- 429、408、连接超时和 5xx：`retryable=true`。
- 401/403、配置错误、空响应、JSON 解析失败和最终 Schema 失败：`retryable=false`。
- AbortSignal：保持 `AbortError`，交给现有取消路径。

Worker 当前拥有最大尝试次数和租约恢复逻辑，不在 Adapter 内叠加不可见重试，避免一次 Job 产生难以解释的多次计费。错误 message 使用固定摘要，不包含服务响应体。

### 7. 默认验证离线，真实验证单独计费

Adapter 单测注入伪造 SDK client，覆盖请求形状、校验、错误和取消，不访问网络。现有测试继续显式使用 LocalDemoModel/FakeModel。

新增 `test:deepseek-live`，只有 `JRA_RUN_LIVE_EVAL=1` 且存在 Key 时才运行一条合成 JD 抽取与一条合成 Claim 生成；否则明确退出而不是在默认测试中跳过后伪装成功。该命令不进入 `pnpm test`。

## Risks / Trade-offs

- [简历被发送到外部服务] → 必须显式 provider 配置，发送前脱敏，并在 README 清楚披露边界。
- [真实模型偶发生成无效 JSON 或引用] → JSON Schema、Zod 和原文引用三层校验；失败进入已有可见重试路径。
- [模型更新导致结果漂移] → Run 和 Report 固化模型名及 Prompt 版本，并以合成 live Eval 做显式回归。
- [旧报告与新契约不兼容] → 新 provenance 字段保持可选，读取时为旧标签提供 legacy 映射。
- [一次 Job 因多层重试重复计费] → SDK/Adapter 不自动重试，统一交由持久化 Worker 控制。
- [现有 Web 文件有未提交变更] → 本 Change 不调整页面结构；只让现有报告来源展示兼容新的字符串/可选元数据。

## Migration Plan

1. 先扩展 Contracts 与数据库读取兼容性，旧数据继续按本地 legacy 来源读取。
2. 增加数据库迁移，为 Run 和 Draft 模型配置提供可空 JSON 列；已有记录保持空值并由读取层兼容。
3. 引入 Prompt、Adapter、Resolver 和环境配置，默认 provider 保持 `local`。
4. 将导入与筛选创建路径写入冻结配置，再切换 Worker 使用 Resolver。
5. 完成离线测试、typecheck、OpenSpec strict validate 和 diff check。
6. 用户在本地 shell 临时设置 DeepSeek 环境变量，显式运行 live smoke 后再用真实简历测试。

回滚时将 `JRA_MODEL_PROVIDER` 改回 `local` 即可停止外部请求；新增可空列和兼容字段无需回退。API Key 泄漏时应立即在 DeepSeek 控制台吊销并生成新 Key。
