## Why

本地运行时已经具备可靠的作业执行与恢复能力，但用户还不能录入自己的背景、提交岗位或得到匹配结论。需要交付第一个端到端业务切片，验证“简历与画像 → JD 文本 → 用户确认 → 可解释初筛报告”的核心价值闭环。

## What Changes

- 增加单用户画像和唯一当前简历的文本录入、编辑与版本化快照，保存求职约束、偏好和评测权重。
- 增加单个或批量 JD 文本导入；每批最多 20 项，每项独立创建 Opportunity 并异步抽取为可编辑 JobDraft。
- 增加 Draft 字段来源、revision、冲突提示和显式确认；只有 confirmed Draft 才能启动初筛。
- 增加初筛 Workflow，冻结 Job/Profile Snapshot，执行硬约束检查、语义匹配、证据校验和确定性推荐策略。
- 增加可解释 ScreeningReport，展示总体建议、匹配点、风险、未知项、证据引用和七个顶层维度的当前可判定结果。
- 增加 Run 进度订阅、失败/取消/重试、Opportunity 历史列表与详情查看，并验证 Server 重启后任务可以恢复。
- 本 Change 先使用确定性 FakeModel 跑通业务链路，不接入真实模型、岗位链接、截图、公司深研、地图通勤计算或导出。

## Capabilities

### New Capabilities

- `candidate-profile`: 定义唯一当前简历、用户求职画像、约束偏好及分析快照行为。
- `text-opportunity-ingestion`: 定义单个/批量 JD 文本导入、异步抽取、Draft 修正与确认行为。
- `opportunity-screening`: 定义初筛 Run、证据化匹配评测、确定性推荐、报告历史和详情行为。

### Modified Capabilities

无。

## Impact

- 扩展 Domain、Contracts、Database 与 Server，新增 Profile、Resume、ImportBatch、Opportunity、JobDraft、ResearchRun、Snapshot、Claim 和 ScreeningReport 数据与接口。
- 在现有持久化 Job/Worker/SSE 上注册抽取和初筛处理器，不改变通用作业生命周期。
- Web 从运行时健康页扩展为画像设置、JD 文本导入、Draft 确认、运行进度、历史列表和报告详情页面。
- 新增脱敏/合成初筛样本和 FakeModel 场景；默认测试仍不访问网络或真实模型。
