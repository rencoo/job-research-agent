## ADDED Requirements

### Requirement: 详情页按确认状态预览或编辑 JobDraft
系统 SHALL 在 Opportunity 详情以中文标签展示 JobDraft 的岗位名称、公司、地点、最低月薪、最高月薪、发薪月数、岗位职责、任职要求和福利。`confirmed` Draft MUST 默认只读预览；`draft` Draft MUST 默认进入整组编辑。预览空值 MUST 显示 `-`；岗位职责、任职要求和福利 MUST 保留换行，不得单行截断。用户进入编辑后，「完成」MUST 只退出编辑且不持久化；「保存草稿」与「确认草稿」仍负责写入和确认。

#### Scenario: 已确认草稿默认预览
- **WHEN** 用户打开 `confirmed` JobDraft 的 Opportunity 详情
- **THEN** 系统以中文标签展示字段预览，不展示这些字段的输入框，并提供进入编辑的入口

#### Scenario: 未确认草稿默认编辑
- **WHEN** 用户打开 `draft` JobDraft 的 Opportunity 详情
- **THEN** 系统直接展示可编辑输入框，用户可以核对并修改抽取结果

#### Scenario: 预览长文本保留换行
- **WHEN** 已确认草稿的岗位职责或任职要求包含多行文本
- **THEN** 预览展示完整换行内容，而不是单行省略

#### Scenario: 完成编辑不保存
- **WHEN** 用户在已确认草稿上进入编辑、修改字段后选择完成
- **THEN** 系统回到预览并显示修改后的本地值，但不发送保存请求

#### Scenario: 取消编辑恢复原值
- **WHEN** 用户在已确认草稿上进入编辑、修改字段后选择取消
- **THEN** 系统回到预览并恢复进入编辑前的值，不发送保存请求
