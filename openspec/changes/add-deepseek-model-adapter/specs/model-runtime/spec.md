## Purpose

定义本地演示模型与 DeepSeek 真实模型之间的显式选择、结构化调用、错误处理、隐私保护和来源追踪，使真实模型能力可用但不会破坏离线开发与可复现性。

## ADDED Requirements

### Requirement: 模型 Provider 必须显式选择
系统 SHALL 默认使用本地演示模型，并只在用户显式配置 DeepSeek provider 时调用 DeepSeek。若已选择 DeepSeek 但 API Key、模型名或基础配置无效，系统 MUST 明确失败且不得静默退回本地演示模型。

#### Scenario: 未配置真实模型
- **WHEN** 用户未设置模型 provider
- **THEN** 系统使用本地演示模型启动，且不发起外部模型请求

#### Scenario: DeepSeek 缺少 API Key
- **WHEN** 用户选择 DeepSeek provider 但没有提供 API Key
- **THEN** Server 启动失败并返回不包含 Key 的配置错误

### Requirement: 真实模型输出必须经过结构化校验
系统 SHALL 为每个模型任务提供稳定的任务标识、Prompt 版本和输出 Schema。DeepSeek 返回内容只有在可解析且通过对应 Schema 校验后才能进入领域流程；空响应、截断 JSON 或非法字段 MUST 被拒绝。

#### Scenario: DeepSeek 返回合法 JD 结构
- **WHEN** DeepSeek 的 JD 抽取响应符合当前输出 Schema
- **THEN** 系统返回经过同一 Schema 再校验的结构化结果

#### Scenario: DeepSeek 返回非法 Claim
- **WHEN** DeepSeek 返回未知评测维度或缺少必填证据字段
- **THEN** 系统拒绝该响应，不生成正式 Claim 或报告

### Requirement: 模型错误具有稳定重试语义
系统 SHALL 将限流、超时和服务端故障映射为可重试错误，将鉴权、无效配置和确定性 Schema 错误映射为不可重试错误，并响应已有的取消信号。

#### Scenario: DeepSeek 返回限流
- **WHEN** DeepSeek 返回 429 或暂时性服务不可用错误
- **THEN** 系统产生不包含敏感正文的可重试模型错误，交由现有 Worker 重试机制处理

#### Scenario: 用户取消运行中的请求
- **WHEN** Worker 在 DeepSeek 请求执行期间收到取消信号
- **THEN** 系统中止请求并沿用现有 Run 取消状态转换

### Requirement: 模型凭据和外发内容最小暴露
系统 MUST 只从受支持的本地配置来源读取 API Key，不得将 API Key、完整简历、完整 JD 或完整 Prompt 写入普通日志、错误摘要或事件。发送给外部模型的内容 MUST 限于当前任务需要的数据。

#### Scenario: 外部模型请求失败
- **WHEN** 包含脱敏简历和 JD 的 DeepSeek 请求失败
- **THEN** 错误记录只包含 provider、模型、任务、错误码和重试性，不包含请求正文或凭据

### Requirement: Run 固化并展示模型来源
系统 SHALL 在创建分析 Run 时固化 provider、模型名和各任务 Prompt 版本，并在报告中展示相同来源。重试 child Run MUST 沿用父 Run 的模型配置，历史报告必须继续兼容原有本地演示模型标签。

#### Scenario: DeepSeek 初筛完成
- **WHEN** 使用 DeepSeek 的 Run 成功生成报告
- **THEN** 报告记录 DeepSeek provider、实际模型名和 Prompt 版本，且不再标记为本地演示模型

#### Scenario: 读取旧报告
- **WHEN** 数据库包含本 Change 之前生成的本地演示报告
- **THEN** 系统仍能读取并显示旧报告，不要求改写历史记录

### Requirement: 真实模型验证必须显式运行
系统 SHALL 保持默认测试和合成 Eval 完全离线，并提供只有在显式设置 DeepSeek 凭据和开关后才执行的 live smoke 或 Eval 入口。

#### Scenario: 运行默认测试
- **WHEN** 开发者执行项目默认测试命令
- **THEN** 测试只使用 FakeModel 或本地演示模型，不访问 DeepSeek 且不产生费用

#### Scenario: 显式运行 Live Eval
- **WHEN** 开发者提供有效 DeepSeek 配置并执行 live 验证命令
- **THEN** 系统发送最小测试样本并验证 JD 抽取、Claim 输出和模型来源
