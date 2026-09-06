## REMOVED Requirements

### Requirement: 画像覆盖七个顶层评测维度
**Reason**: 顶层维度从七维改为六维；`ownership` 与 `product_interest` 合并为 `work_content`。
**Migration**: 使用新要求「画像覆盖六个顶层评测维度」。新写入不再接受旧维度标识；已存画像按该要求升到六维后展示。

## ADDED Requirements

### Requirement: 画像覆盖六个顶层评测维度
系统 SHALL 使用 people_and_company_reliability、life_radius、compensation_package、workload_and_role_boundaries、work_content、career_growth 六个稳定维度标识。`work_content`（工作内容）SHALL 评估日常做什么以及是否对味，并明确包含主导权与产品方向；系统 MUST NOT 再将 ownership 或 product_interest 作为顶层权重或稳定维度标识。用户未配置的维度 SHALL 使用产品默认权重，但不得伪造用户偏好。必须具备主导权或排斥特定工作形态的门槛 MUST 由 required/preferred 约束或 warning/blocking 红旗表达，不得恢复为独立维度滑杆。

#### Scenario: 用户只配置部分维度
- **WHEN** 用户仅调整薪资和职业成长权重
- **THEN** 系统保存这两个用户值，并为其余维度（含 work_content）使用可见的默认权重

#### Scenario: 用户调整工作内容权重
- **WHEN** 用户将 work_content 设为较高，且未单独配置主导权或产品兴趣
- **THEN** 系统只保存 work_content 的用户值，归一化结果包含且仅包含六个顶层维度

#### Scenario: 提交已删除的维度权重
- **WHEN** 用户提交包含 ownership 或 product_interest 键的画像权重
- **THEN** 系统拒绝保存并指出对应字段，不覆盖上一版本

### Requirement: 已存七维画像升为六维展示
系统 SHALL 在读取仍含 ownership 或 product_interest 的已存画像或 ProfileSnapshot 时，将其展示为六维权重，且 MUST NOT 把旧键当作当前用户可编辑的顶层维度。若用户曾显式配置 ownership 或 product_interest，升维后的 work_content 用户值 MUST 来自这些已存值，不得改写成产品默认值；二者皆显式时 MUST 取更重视的那一档，不得平均稀释。

#### Scenario: 读取只配置过 Ownership 的旧画像
- **WHEN** 已存画像显式将 ownership 设为较高，且未配置 product_interest
- **THEN** 系统向用户展示 work_content 为较高，并不再展示 Ownership 或产品兴趣滑杆

#### Scenario: 读取两个旧内容维都配置过的画像
- **WHEN** 已存画像显式将 ownership 设为较高、product_interest 设为较低
- **THEN** 系统将 work_content 展示为较高，并保留其余未改维度的原值或默认值
