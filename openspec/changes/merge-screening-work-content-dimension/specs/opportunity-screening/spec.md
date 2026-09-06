## REMOVED Requirements

### Requirement: 报告覆盖七个评测维度
**Reason**: 顶层评测维度改为六维，Ownership 与产品兴趣不再单独出 verdict。
**Migration**: 使用新要求「报告覆盖六个评测维度」。新报告只写六维；历史七维报告按该要求升维后展示。

## ADDED Requirements

### Requirement: 报告覆盖六个评测维度
系统 SHALL 为六个顶层维度输出 verdict、confidence、claimIds、risks 和 unknowns。六个标识 MUST 为 people_and_company_reliability、life_radius、compensation_package、workload_and_role_boundaries、work_content、career_growth。verdict MUST 为 positive、mixed、negative 或 unknown；没有有效 Claim 支持的维度 MUST 为 unknown。正式 Claim.dimension MUST 使用上述六维之一；ownership 与 product_interest MUST NOT 作为新报告的维度键。

#### Scenario: 初筛缺少公司可靠性证据
- **WHEN** 输入只有简历和 JD 文本，没有可信公司研究来源
- **THEN** people_and_company_reliability 为 unknown，并提示需要深度研究

#### Scenario: 初筛无法计算实际通勤
- **WHEN** 系统只有用户通勤容忍度和 JD 地点但没有实际通勤时间
- **THEN** life_radius 为 unknown，并提示用户在深度分析时核对实际通勤

#### Scenario: 新报告不再拆出 Ownership 或产品兴趣
- **WHEN** 初筛完成并生成正式报告
- **THEN** 报告维度集合恰好为六个顶层标识，且不含 ownership 或 product_interest

### Requirement: 工作内容维解释主导权与产品方向
系统 SHALL 将主导权、产品方向和日常职责的有效证据归入 work_content。当这些透镜的极性冲突时，work_content verdict MUST 为 mixed，并同时保留相互冲突的 Claim，不得只保留其中一侧。工作负荷与职责边界 MUST 继续只表达过载与范围摊派，不得把「缺少主导权」记入该维。岗位/能力是否匹配 MUST NOT 单独成为第七个顶层维度。

#### Scenario: 产品对味但缺少主导权
- **WHEN** 有效 Claim 表明产品或方向匹配，同时另有有效 Claim 表明角色只是执行切片、缺少主导权
- **THEN** work_content 为 mixed，报告同时列出这两条证据

#### Scenario: 只有日常职责证据
- **WHEN** 初筛只有日常职责匹配的有效 Claim，没有主导权或产品方向证据
- **THEN** work_content 仍可依据已有 Claim 给出 verdict，不必因为缺少某一透镜而标为 unknown

### Requirement: 历史七维报告按六维展示
系统 SHALL 使仍含 ownership 或 product_interest 的历史 ScreeningReport 可读。展示时 MUST 将这两维的结论合并到 work_content，不得丢弃其中已有风险或未知项；合并后的报告维度集合 MUST 为六个顶层标识。历史报告正文 MUST NOT 被原地改写成新 Run 的结论。

#### Scenario: 读取旧的七维报告
- **WHEN** 用户打开一份历史报告，其维度仍分别包含 ownership 与 product_interest
- **THEN** 界面与查询结果以 work_content 展示合并后的评测，并仍可追溯到原 Claim
