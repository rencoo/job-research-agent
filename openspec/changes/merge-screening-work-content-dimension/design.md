## Context

画像、初筛报告和 Claim 共用 `DimensionId` 七元枚举，定义在 Domain `DIMENSIONS` 与 Contracts `DimensionIdSchema`，Web 权重滑杆和报告卡片按该列表渲染。默认权重为 people 5、life_radius 4、compensation 3、workload 5、ownership 3、career_growth 4、product_interest 2。`docs/architecture.md` 将这七维列为基线；本 Change 必须同步改基线，不能只改代码。见 `proposal.md` 的动机与范围。

## Goals / Non-Goals

**Goals:**

- 让 Domain / Contracts / 报告 / 权重 UI 共用同一份六维标识，`work_content` 成为唯一内容维。
- 新写入拒绝旧键；读取旧画像、旧快照和旧报告时升到六维，且不把 immutable 历史行原地改写成新结论。
- FakeModel 与 screening eval 使用新标识，现有推荐规则（硬约束、unknown 不记负分）保持不变。

**Non-Goals:**

- 不新增岗位/能力匹配顶层维度，不新增 Claim.lens 枚举。
- 不改推荐阈值、约束/红旗模型和 Workflow 阶段。
- 不做公司深研或通勤计算，people / life_radius 在文本初筛仍可为 unknown。

## Decisions

### 1. 稳定标识只换一处语义，不保留别名

新六维为：

```text
people_and_company_reliability
life_radius
compensation_package
workload_and_role_boundaries
work_content
career_growth
```

`DimensionIdSchema` 删除 `ownership`、`product_interest`。新的 Profile / Report / Claim 写入走 Zod 枚举，旧键直接 400。备选是输入层把旧键静默映射为 `work_content`，会让已删除维度看起来仍然合法，拒绝写入更符合「稳定标识」被替换的语义。

### 2. 默认权重：`work_content = 4`

用 4 承接原 ownership(3) 与 product_interest(2) 的中间位置，与 life_radius、career_growth 同级，避免把内容维抬到与人和负荷（5）并列。未显式配置时仍走 `normalizeWeights` 的默认表后归一化。备选是相加为 5，会改变默认相对排序，超出「合并」本身。

### 3. 读取路径升维，不改写历史行

Repository / parser 在 Zod 校验前对画像 JSON、ProfileSnapshot 和 ScreeningReport 做纯函数升维：

- 权重：若 `work_content` 已存在则忽略旧键；否则取用户显式配置过的 ownership / product_interest，二者都有则取更高档（high > 数值更大 > medium > low），写入 `work_content` 并从显式列表中去掉旧键。
- 报告维度与 Claim：把 ownership / product_interest 的 assessment 与 claim 归到 `work_content`。verdict 合并顺序为 negative > mixed > positive；unknown 不参与；两侧已知且冲突则为 mixed。risks / unknowns / claimIds 做并集。Claim.dimension 改为 `work_content`，statement 保持原文以便追溯。

不把升维结果写回 `screening_reports` 或 snapshot 行，避免改写 immutable 历史。新 Run 只产生六维报告。备选是 SQL 迁移改写全部 JSON；对本地未发布数据更简单，但违反快照不可变约定。

### 4. 工作内容冲突用多条 Claim 表达，不加透镜字段

主导权、产品方向、日常职责都作为 `dimension = work_content` 的独立 Claim，由 statement 说明透镜。模型（含 FakeModel）以后打在 `work_content` 上。负荷维继续只处理过载与范围摊派。备选是加 `lens` 枚举，能让 UI 分组，但会扩大 Contracts 与 FakeModel 面，本 Change 不需要。

### 5. 架构基线与测试常数一起改

`docs/architecture.md` 的七维列表改为上述六维，并补一句：`work_content` 包含主导权与产品方向。测试中 `1/7`、长度 7、以及 eval 里的 `ownership` verdict 改为六维 / `work_content`。LocalDemoModel 的交替维度从 ownership 改为 work_content。

## Risks / Trade-offs

- [用户无法再把 Ownership 权重大于产品兴趣] → 用约束/红旗表达「必须有主导权」；报告 mixed 仍同时展示两侧 Claim。
- [旧报告升维后 verdict 可能从两个明确结论变成 mixed] → 这是期望行为；不回写原行，必要时仍可从 Claim 原文看到旧维度语义。
- [半旧本地 SQLite 若绕过 parser 会校验失败] → 所有读路径必须走同一 upcaster；开发环境仍允许删 `.data` 重建。

## Migration Plan

无需新表结构迁移。发布顺序：先落地 upcaster 与六维枚举，再改 FakeModel / UI / 架构文档。回滚即恢复七维枚举；未回写的历史 JSON 仍是旧键，可再被七维 schema 读取。本地开发若数据损坏，删除 `.data` 后迁移重建。
