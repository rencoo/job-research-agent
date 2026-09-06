# opportunity-screening Specification

## Purpose

定义已确认岗位如何与候选人快照进行可恢复、可解释的初筛分析，并形成可追溯的推荐、六维评测和历史报告。

## Requirements

### Requirement: 初筛启动具有明确前置条件和幂等性
系统 SHALL 只允许同时存在当前简历、有效画像和 confirmed JobDraft 的 Opportunity 启动初筛。启动命令 MUST 接受幂等键，并在同一事务中冻结 JobSnapshot/ProfileSnapshot、创建 ResearchRun 和持久化 ExecutionJob。

#### Scenario: 成功启动初筛
- **WHEN** 用户为满足前置条件的 Opportunity 提交新的幂等键
- **THEN** 系统返回同一个 Run receipt，并异步执行初筛

#### Scenario: 重复提交启动命令
- **WHEN** 用户使用同一幂等键重复启动同一 Opportunity 的初筛
- **THEN** 系统返回首次创建的 Run，不创建重复 Run 或 Job

#### Scenario: Draft 未确认
- **WHEN** 用户尝试对 draft 状态的 JobDraft 启动初筛
- **THEN** 系统返回 domain_precondition，不创建快照或 Run

### Requirement: 初筛按可恢复阶段执行
系统 SHALL 依次执行 constraint_check、semantic_match、claim_validation、recommendation_policy、screening_report。每个成功阶段 MUST 形成可恢复 Checkpoint；失败或重启后不得重复提交已完成阶段的正式结果。

#### Scenario: Server 在语义匹配后重启
- **WHEN** semantic_match Checkpoint 已持久化但后续阶段尚未完成
- **THEN** 恢复后的 Run 从下一个未完成阶段继续，并保持已有 Checkpoint 不变

### Requirement: 模型输出与确定性规则职责分离
系统 SHALL 使用模型端口归纳简历与 JD 的匹配证据，但 MUST 使用确定性规则处理 required 约束、blocking 红旗、薪资总包计算和最终推荐档位。无法通过结构及语义校验的模型输出不得生成正式报告。

#### Scenario: 命中 blocking 红旗
- **WHEN** 有效证据确认岗位命中用户配置的 blocking 红旗
- **THEN** 最终推荐不得高于 not_recommended，且报告列出触发规则和证据

#### Scenario: 薪资月数使用默认值
- **WHEN** JobSnapshot 的月薪明确但发薪月数来自 12 薪默认假设
- **THEN** 总包按 12 个月计算，同时降低该结论置信度并展示假设

### Requirement: 报告覆盖七个评测维度
系统 SHALL 为七个顶层维度输出 verdict、confidence、claimIds、risks 和 unknowns。verdict MUST 为 positive、mixed、negative 或 unknown；没有有效 Claim 支持的维度 MUST 为 unknown。

#### Scenario: 初筛缺少公司可靠性证据
- **WHEN** 输入只有简历和 JD 文本，没有可信公司研究来源
- **THEN** people_and_company_reliability 为 unknown，并提示需要深度研究

#### Scenario: 初筛无法计算实际通勤
- **WHEN** 系统只有用户通勤容忍度和 JD 地点但没有实际通勤时间
- **THEN** life_radius 为 unknown，并提示用户在深度分析时核对实际通勤

### Requirement: 报告提供可解释的总体结论
系统 SHALL 输出 strong_match、worth_exploring、cautious、not_recommended 或 insufficient_information 之一，并展示匹配点、风险、未知项、规则命中和引用 Claim。结论不得仅由模型自由文本决定。

#### Scenario: 证据不足
- **WHEN** 关键职责、要求或候选人经历无法形成足够有效 Claim
- **THEN** 报告使用 insufficient_information 或降低置信度，不补造事实

### Requirement: Report 与输入变化保持可追溯
系统 SHALL 保留每次 ScreeningReport。当前简历、画像或 JobDraft 在 Run 创建后变化时，旧报告 MUST 标记为 stale 且不得自动作为当前有效结论；partial 报告可以被采用，invalidated 报告不得被采用。

#### Scenario: 报告完成后修改 JD
- **WHEN** 用户修改并重新确认 JobDraft
- **THEN** 原报告保留在历史中并标记 stale，用户可以发起新的初筛

### Requirement: 用户可以观察和控制初筛 Run
系统 SHALL 提供 Run 快照和按 runId/sequence 补放的 SSE 事件，并允许用户取消运行中 Run。failed Run 的重试 MUST 创建引用原 Run 的 child Run，不能原地改写历史。

#### Scenario: 断线后恢复进度
- **WHEN** 客户端携带最后收到的 sequence 重新订阅
- **THEN** 系统补发后续 RunEvent，并通过重新查询返回正式 Run/Report 状态

#### Scenario: 重试失败 Run
- **WHEN** 用户对 failed Run 发起重试
- **THEN** 系统创建新的 child Run，原 Run 保持 failed 且记录 successorRunId

### Requirement: 用户可以筛选历史并查看详情
系统 SHALL 提供 Opportunity 历史列表，支持按关键词、导入/分析状态和推荐档位筛选；详情 SHALL 展示当前 Draft、有效报告、历史报告、Run 状态和证据引用。MVP 不提供看板视图。

#### Scenario: 按推荐档位筛选
- **WHEN** 用户选择 worth_exploring 筛选条件
- **THEN** 列表只返回当前有效报告为该档位的 Opportunity

### Requirement: 默认初筛不访问真实模型或网络
系统 SHALL 使用与正式 ModelPort 相同契约的 FakeModel 完成该切片，并提供至少 10 条脱敏或合成评测样本，覆盖正常、字段缺失、证据冲突、红旗和过载信号。

#### Scenario: 无 API Key 环境运行初筛
- **WHEN** 用户在没有模型或搜索服务密钥的本机启动初筛
- **THEN** 系统仍可完成确定性的演示报告，且测试过程不产生外部请求
