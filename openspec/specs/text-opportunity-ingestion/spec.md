# text-opportunity-ingestion Specification

## Purpose

定义单个或批量 JD 文本如何转化为独立工作机会和可确认的结构化岗位草稿，并确保异步抽取、用户修正与失败恢复互不覆盖。

## Requirements

### Requirement: 用户可以批量导入 JD 文本
系统 SHALL 接受 1 至 20 个非空 JD 文本项，并为每次提交创建 ImportBatch。每个输入项 MUST 独立创建新的 Opportunity，即使其文本与历史记录重复。

#### Scenario: 导入单个 JD
- **WHEN** 用户提交一个非空 JD 文本
- **THEN** 系统创建包含一个 ImportItem 和一个 Opportunity 的批次，并异步开始抽取

#### Scenario: 导入包含重复 JD 的批次
- **WHEN** 用户提交两个内容相同的 JD 文本
- **THEN** 系统创建两个不同的 Opportunity，不做自动去重或版本合并

#### Scenario: 超出批量上限
- **WHEN** 用户一次提交超过 20 个文本项
- **THEN** 系统拒绝整个请求，不创建部分批次

### Requirement: 批次中的每项独立完成
系统 SHALL 独立追踪每个 ImportItem 的 queued、extracting、needs_input、ready 或 failed 状态。单项失败不得阻止同批其他项完成，用户 SHALL 能单独重试失败项。

#### Scenario: 批次部分失败
- **WHEN** 一个批次中部分文本无法抽取但其他文本成功
- **THEN** 系统保留成功项的 Draft，并将失败项标记为 failed 且提供可重试错误

### Requirement: 抽取结果形成可编辑 JobDraft
系统 SHALL 从 JD 文本抽取岗位名称、公司名称、地点、薪资范围、发薪月数、职责、要求、福利和原始文本引用。每个字段 MUST 记录 value、source 与 revision；无法确认的字段保持空值或 unknown。

#### Scenario: JD 包含明确结构信息
- **WHEN** 抽取器识别到岗位、公司、薪资和职责
- **THEN** 系统创建 draft 状态的 JobDraft，并将相应字段标记为 extracted 来源

#### Scenario: JD 未注明发薪月数
- **WHEN** JD 给出月薪但没有明确发薪月数
- **THEN** 系统将发薪月数设为 12、source 标记为 default，并保留“按 12 薪估算”的可见假设

### Requirement: 用户修改优先于迟到抽取结果
系统 SHALL 使用 expectedVersion 保护 Draft 编辑，并记录字段级 revision。抽取开始后被用户修改的字段 MUST 保留用户值；迟到结果与用户值冲突时进入待确认列表，不得静默覆盖。

#### Scenario: 抽取期间用户修改公司名
- **WHEN** 用户保存公司名后旧 ExtractionAttempt 返回不同公司名
- **THEN** Draft 保留用户值并产生一个可见冲突项

#### Scenario: 使用过期版本保存 Draft
- **WHEN** 客户端提交的 expectedVersion 早于服务器当前版本
- **THEN** 系统返回 version_conflict，要求客户端重新加载且不自动合并

### Requirement: Draft 必须显式确认
系统 SHALL 以 draft 或 confirmed 表示 JobDraft 确认状态。只有 confirmed Draft 才能启动初筛；用户修改参与分析的字段后，Draft MUST 自动回到 draft。

#### Scenario: 确认完整 Draft
- **WHEN** 用户确认满足最低字段要求的 Draft
- **THEN** 系统记录确认时间和版本，并允许该 Opportunity 启动初筛

#### Scenario: 修改已确认 Draft
- **WHEN** 用户修改已确认 Draft 的岗位、公司、薪资、职责或要求
- **THEN** Draft 回到 draft，原确认失效

### Requirement: 本 Change 仅接受文本来源
系统 SHALL 明确拒绝岗位链接或截图作为本 Change 的导入内容，并提示该能力尚未启用，而不是尝试外部抓取。

#### Scenario: 用户提交岗位链接代替正文
- **WHEN** 输入项只包含 HTTP/HTTPS URL 且没有 JD 正文
- **THEN** 系统将该项标记为 needs_input，并提示粘贴 JD 文本
