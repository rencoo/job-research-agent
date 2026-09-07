## ADDED Requirements

### Requirement: 报告记录实际模型来源
系统 SHALL 在每份 ScreeningReport 中记录实际 provider、模型名和 Prompt 版本，并保证这些值与创建 Run 时冻结的模型配置一致。模型来源只描述证据生成方式，不改变确定性推荐规则的职责。

#### Scenario: DeepSeek 报告来源
- **WHEN** DeepSeek Run 完成初筛
- **THEN** 报告展示 DeepSeek 及实际模型名，并保留所用 Prompt 版本

#### Scenario: 本地演示报告来源
- **WHEN** 本地演示 Run 完成初筛
- **THEN** 报告继续明确标记为本地演示结果

## MODIFIED Requirements

### Requirement: 默认初筛不访问真实模型或网络
系统 SHALL 默认使用与正式 ModelPort 相同契约的本地演示模型，并提供至少 10 条脱敏或合成评测样本，覆盖正常、字段缺失、证据冲突、红旗和过载信号。只有用户显式启用 DeepSeek provider 时，JD 抽取和语义匹配阶段才能访问 DeepSeek；默认测试与 Eval MUST 始终保持离线。

#### Scenario: 无 API Key 环境运行初筛
- **WHEN** 用户未选择 DeepSeek provider 且本机没有模型或搜索服务密钥
- **THEN** 系统仍可完成确定性的演示报告，且不产生外部请求

#### Scenario: 显式启用 DeepSeek 初筛
- **WHEN** 用户提供有效 DeepSeek 配置并启动满足前置条件的初筛
- **THEN** 语义匹配使用 DeepSeek 生成候选 Claim，但 Claim 仍需通过原文引用校验，最终推荐仍由确定性规则产生

#### Scenario: 默认测试保持离线
- **WHEN** 开发者执行默认测试或合成 Eval
- **THEN** 系统不读取真实 API Key、不访问 DeepSeek 且不产生费用
