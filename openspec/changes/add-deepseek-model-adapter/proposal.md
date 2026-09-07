## Why

当前运行时固定使用 `LocalDemoModel`，只能验证工程闭环，不能对真实简历与 JD 做可靠的语义抽取和匹配。用户已经具备 DeepSeek API Key，需要在不破坏离线测试、证据校验和隐私边界的前提下，引入显式可选的真实模型能力。

## What Changes

- 新增 DeepSeek Responses API Adapter，通过环境变量显式选择 `local` 或 `deepseek` provider；默认仍为本地模型，配置 DeepSeek 但缺少 Key 时启动失败，不静默降级。
- 为 JD 结构化抽取与简历/JD Claim 生成提供独立、版本化 Prompt 和结构化输出 Schema，模型结果必须继续经过 Zod 与原文引用校验。
- 外发前对简历中的手机号、邮箱等直接身份信息做确定性脱敏；API Key、简历/JD 正文和完整 Prompt 不进入普通日志、错误或事件。
- 在报告中记录 provider、model 和 promptVersion，同时兼容既有仅含“本地演示模型”标签的历史报告。
- 区分可重试的限流、超时和服务端错误与不可重试的鉴权、配置和结构错误，并复用现有 Worker 重试/取消机制。
- 默认测试与 Eval 保持离线；新增必须显式提供环境变量才会运行的 DeepSeek live smoke/Eval 入口。
- 更新运行文档和环境变量示例，明确真实模型只提升文本抽取与匹配，不包含联网公司研究、岗位抓取或通勤计算。

## Capabilities

### New Capabilities

- `model-runtime`: 定义模型 provider 选择、DeepSeek 调用、结构化结果校验、错误语义、隐私和模型来源记录。

### Modified Capabilities

- `candidate-profile`: 将纯本地处理边界扩展为用户显式启用真实 provider 后的最小化、脱敏外发行为。
- `text-opportunity-ingestion`: 明确真实模型抽取结果仍需 Schema 校验、逐项失败隔离和可追溯模型来源。
- `opportunity-screening`: 允许真实模型生成受证据约束的匹配 Claim，并要求报告保存 provider/model/prompt 版本；默认测试仍不得访问网络。

## Impact

- 影响 `packages/model-gateway`、`packages/contracts`、`apps/server` 的模型装配、Prompt、报告生成与错误映射。
- 新增 OpenAI JavaScript SDK 运行时依赖，用 DeepSeek 官方 OpenAI-compatible Responses API。
- 不改变 Domain 的确定性约束、红旗、薪资总包和推荐决策职责，也不改动当前 Web 信息架构。
- 不在本 Change 实现 Keychain/UI 密钥管理、联网搜索、公司深研、截图识别、Chat 或其他模型 provider。
