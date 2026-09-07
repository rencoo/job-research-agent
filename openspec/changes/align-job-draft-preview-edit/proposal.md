## Why

Opportunity 详情里的岗位草稿仍是垂直切片形态：英文 key 当标签、每个字段永远是 textarea。画像页的分析偏好已经是「先预览、再整组编辑」。已确认草稿继续铺满输入框，会把核对结果重新当成未完成表单，也让两处结构化资料的交互不一致。

## What Changes

- Opportunity 详情的岗位草稿改为与分析偏好同一套预览 / 整组编辑交互。
- `confirmed` 草稿默认只读预览；`draft` 草稿默认进入编辑，方便核对抽取结果。
- 预览使用中文标签；空值显示 `-`；职责、要求、福利允许换行预览，不套用偏好页的单行省略。
- 「保存」依次保存并确认，成功后退出编辑，失败保留输入；移除独立的保存草稿 / 确认草稿按钮，沿用服务端版本与确认校验。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `text-opportunity-ingestion`: 补充 JobDraft 在详情页的预览与整组编辑呈现，以及已确认 / 未确认的默认态。

## Impact

- 仅 Web：`apps/web` 的 Opportunity 详情草稿区、相关样式与页面测试。
- 不改 Contracts、Domain、API、确认门槛或已确认字段修改后回退 `draft` 的规则。
- 不更新 `docs/architecture.md`：基线仍是「用户确认 Draft」，不规定详情页控件形态。
