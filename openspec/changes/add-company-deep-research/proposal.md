## Why

现有初筛只分析简历与 JD，无法核验公司身份和公开信息。需要从岗位详情启动可恢复的深研，将公司事实和岗位判断连接到可追溯原文。

## What Changes

- 增加公司识别、候选确认与跳过，以及跨岗位公司研究快照复用。
- 接入 Tavily Search、HTTP/Readability 和无登录态 Playwright 网页读取。
- 增加规范化 SourceDocument、Claim、EvidenceLink 与六维深研报告。
- 扩展持久化 Worker 的分组并发、等待恢复、研究预算、取消和类型化重试。
- 岗位详情增加深研入口、公司确认、研究进度和证据展示；保持旧初筛兼容。

## Capabilities

### New Capabilities
- `company-research`: 公司识别、确认、快照与共享刷新。
- `research-sources`: 搜索、页面读取、访问约束及证据校验。
- `opportunity-deep-research`: 深研流程、恢复、报告及用户交互。

### Modified Capabilities
无。现有初筛保留原契约，新增独立深研契约。

## Impact

涉及 contracts、database、application、domain、model-gateway、server、web，新增 research-tools 包。新增 SQLite 迁移与研究 REST 接口，复用 SSE。默认测试离线，真实联网验证独立显式运行。不实现通勤计算、登录态抓取、投递、Chat 或导出。
