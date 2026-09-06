## Purpose

定义单用户求职画像、唯一当前简历及其分析快照行为，使每次岗位初筛都有明确、可追溯且不会被后续编辑污染的候选人输入。

## ADDED Requirements

### Requirement: 用户维护唯一当前简历
系统 SHALL 允许用户以文本形式创建或替换一份当前简历，并记录内容版本和更新时间。替换后无需在多个简历版本间选择，但已经生成的分析快照 MUST 保持不变。

#### Scenario: 首次保存简历文本
- **WHEN** 用户提交非空的简历文本
- **THEN** 系统保存为当前简历并分配初始版本

#### Scenario: 替换当前简历
- **WHEN** 用户修改并保存已有简历文本
- **THEN** 系统递增当前简历版本，后续分析使用新版本，已有报告继续引用原快照

### Requirement: 用户维护结构化求职画像
系统 SHALL 允许用户维护目标岗位、期望地点、薪资期望、通勤容忍度、技能与经历重点、required/preferred 约束、warning/blocking 红旗以及评测维度权重。权重 SHALL 支持用户填写数值或选择预设档位，并在保存时归一化为可比较值。

#### Scenario: 保存有效画像
- **WHEN** 用户提交字段合法且至少包含目标岗位的画像
- **THEN** 系统保存画像、递增版本并返回归一化权重

#### Scenario: 保存非法权重或薪资范围
- **WHEN** 用户提交负权重、无法识别的档位或最低薪资高于最高薪资
- **THEN** 系统拒绝保存并指出对应字段，不覆盖上一版本

### Requirement: 画像覆盖七个顶层评测维度
系统 SHALL 使用 people_and_company_reliability、life_radius、compensation_package、workload_and_role_boundaries、ownership、career_growth、product_interest 七个稳定维度标识。用户未配置的维度 SHALL 使用产品默认权重，但不得伪造用户偏好。

#### Scenario: 用户只配置部分维度
- **WHEN** 用户仅调整薪资和职业成长权重
- **THEN** 系统保存这两个用户值，并为其余维度使用可见的默认权重

### Requirement: 初筛冻结候选人输入
系统 SHALL 在启动初筛时原子创建包含简历文本、简历版本、画像字段和画像版本的不可变 ProfileSnapshot。初筛执行期间的画像或简历修改不得改变该 Run 的输入。

#### Scenario: Run 期间修改画像
- **WHEN** 用户在初筛运行中修改当前画像
- **THEN** 运行中的 Run 继续使用原 ProfileSnapshot，完成后报告标记为 stale 且保留历史

### Requirement: 候选人资料保持本地与最小暴露
系统 MUST 不在普通日志、错误摘要或作业事件中记录完整简历文本。当前 FakeModel 初筛 MUST 在本机完成且不产生外部网络请求。

#### Scenario: 初筛处理失败
- **WHEN** 包含简历输入的初筛作业失败
- **THEN** 错误记录只包含脱敏错误码和摘要，不包含简历正文或联系方式
