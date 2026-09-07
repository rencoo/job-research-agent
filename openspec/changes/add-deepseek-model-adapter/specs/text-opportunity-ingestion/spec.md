## ADDED Requirements

### Requirement: JD 抽取使用当前显式模型配置
系统 SHALL 使用当前显式选择的模型 provider 完成 JD 结构化抽取，并记录 provider、模型名和抽取 Prompt 版本。真实模型输出仍 MUST 经过结构化 Schema 校验，失败只影响当前 ImportItem。

#### Scenario: 使用 DeepSeek 抽取 JD
- **WHEN** 用户已配置 DeepSeek provider 并导入有效 JD 文本
- **THEN** 系统使用冻结的 DeepSeek 模型配置抽取字段，并在 JobDraft 中保存模型来源

#### Scenario: DeepSeek 抽取结果非法
- **WHEN** DeepSeek 返回无法解析或不符合字段 Schema 的抽取结果
- **THEN** 当前 ImportItem 标记为 failed 且可以单项重试，同批其他项目不受影响

#### Scenario: 使用本地模型抽取 JD
- **WHEN** 用户没有配置外部模型 provider
- **THEN** 系统保持当前本地演示抽取行为并标记本地模型来源
