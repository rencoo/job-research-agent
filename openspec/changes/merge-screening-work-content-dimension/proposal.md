## Why

当前七维把 Ownership 和产品兴趣拆成两个顶层权重，用户很难独立权衡，也把「是否喜欢做这件事」拆得过窄。两者都是工作内容好不好的原因，应合并成一个可解释维度，并在定义里明确包含主导权和产品方向。

## What Changes

- **BREAKING**：顶层评测维度从 7 个减为 6 个；删除稳定标识 `ownership` 与 `product_interest`，新增 `work_content`（工作内容）。
- `work_content` 评估日常做什么、是否对味，**明确包含主导权和产品方向**；二者不再单独加权，只作为该维下的 Claim 透镜。
- 必须具备主导权或排斥纯执行岗等门槛，继续走 required/preferred 约束或 warning/blocking 红旗，不恢复为独立权重滑杆。
- 画像权重、初筛报告维度、Claim.dimension 与默认权重表一并切换到六维。
- 同步更新 `docs/architecture.md` 中的七维基线，避免实现与架构文档分叉。
- 本 Change **不**把岗位/能力匹配提升为顶层维度；匹配仍由语义匹配、硬约束和总体推荐表达。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `candidate-profile`: 画像稳定维度标识与默认权重改为六维，`work_content` 替换 `ownership` 与 `product_interest`。
- `opportunity-screening`: 初筛报告与 Claim 覆盖六维；工作内容维须能同时解释主导权与产品方向证据。

## Impact

- Domain `DIMENSIONS` / 默认权重、Contracts `DimensionIdSchema`、Profile/Report/Claim DTO。
- FakeModel 与 screening eval 样本中的维度标识。
- Web 画像权重编辑器与报告维度展示文案。
- 本地已存画像权重、快照 JSON 和历史报告中的旧维度键需要兼容或升级策略。
- 架构基线 `docs/architecture.md` 的七维列表。
