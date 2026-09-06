## Context

Opportunity 详情的草稿区在 `OpportunityPage` 里把 9 个字段一律渲染成 `textarea`，标签用英文 key。画像页的 `EditablePreferences` 已经实现「预览卡片 + 右上角编辑 + 取消/完成」；相关样式在 `.editable-preview`、`.preferences-preview`、`.preview-value`。Draft 的保存、确认、版本冲突和回退 `draft` 已由现有 API 覆盖。见 `proposal.md` 的动机与范围。

## Goals / Non-Goals

**Goals:**

- 用与分析偏好相同的交互骨架呈现 JobDraft，并按 `confirmed` / `draft` 选择默认态。
- 长文本预览可读；现有保存、确认、并发冲突测试仍能通过（先进入编辑再改字段）。

**Non-Goals:**

- 不抽取跨页面的通用表单组件，也不改简历 Markdown 预览。
- 不改 PATCH/confirm API、字段 revision 或确认门槛。
- 不把地点做成 pill，不在预览里展示 source / revision。

## Decisions

### 1. 新增 `EditableDraft`，复用偏好交互而不是抽公共组件

在 `pages.tsx` 增加与 `EditablePreferences` 同构的 `EditableDraft`：字段表、预览网格、整组编辑、取消/完成。`OpportunityPage` 只传入当前值和 `defaultEditing`。备选是抽 `EditableRecord`；两个网格的字段元数据和长文本预览已经分叉，先复制模式比过早抽象更小。

### 2. 默认态由 Draft 状态决定，不由「是否有值」决定

`defaultEditing = data.draft.status !== "confirmed"`。刚抽完的 `draft` 需要核对，默认编辑；已确认默认预览。备选是始终预览，会多一次点击才能改抽取错误；备选是始终编辑，则无法对齐已确认画像的阅读态。

### 3. 长文本用独立预览样式，不复用 `.preview-value` 的 nowrap

岗位职责、任职要求、福利使用可换行的预览 class（例如 `.preview-value.multiline`），去掉 `white-space: nowrap` 和 `text-overflow: ellipsis`。短字段（名称、公司、地点、薪资、月数）保持单行省略。地点保持纯文本，不做 pill。

### 4. 完成 / 取消与保存 / 确认分层

完成只 `setEditing(false)`；取消回滚本地 `edits`。`保存草稿` / `确认草稿` 留在区块外，语义不变。未保存就点确认，仍提交当前本地值（与现网一致）。版本冲突测试无需先进入编辑：确认态预览下仍可点保存。

### 5. 中文标签写死在字段表，测试改走可见文案

| key | 标签 |
| --- | --- |
| title | 岗位名称 |
| company | 公司 |
| location | 地点 |
| salaryMinMonthly | 最低月薪 |
| salaryMaxMonthly | 最高月薪 |
| payMonths | 发薪月数 |
| responsibilities | 岗位职责 |
| requirements | 任职要求 |
| benefits | 福利 |

现有「按 label `company` 改值」的测试改为先点「编辑岗位草稿」，再按「公司」改值。

## Risks / Trade-offs

- [未保存修改后点确认会带上本地改动] → 保持现网行为；完成不落库，确认仍用当前表单值。
- [职责/要求很长会撑高预览] → 可接受；阅读核对优先于卡片等高。
- [复制 `EditablePreferences` 造成两套相似代码] → 本 Change 范围只改草稿；若第三处再出现再抽。

## Migration Plan

无需数据迁移或 API 发布顺序。回滚即恢复详情页恒定 textarea。本地页面测试覆盖预览默认态、未确认默认编辑、完成不请求、取消回滚。
