## 1. 数据与契约
- [x] 1.1 增加公司/来源/证据/深研契约及 Run 类型，使用契约与 typecheck 验证旧初筛兼容
- [x] 1.2 增加迁移与研究 Repository，以数据库测试验证不可变来源、快照复用、刷新锁与报告有效性
## 2. 研究工具
- [x] 2.1 新增 SearchPort/PageReaderPort、Tavily 与离线替身，以离线适配器测试验证结果/失败映射
- [x] 2.2 实现安全 HTTP、Readability、Playwright 后备，以聚焦测试验证公网限制、重定向、体积与 blocked
## 3. 研究闭环
- [x] 3.1 实现公司识别、确认/补充/跳过及共享快照，以集成测试覆盖歧义、复用和等待唤醒
- [x] 3.2 实现研究问题、取证、语义复核、六维报告，以合成案例验证引用、冲突、未知与推荐规则
- [x] 3.3 实现研究预算、checkpoint、取消、child/continuation 与分组 Worker，以测试验证恢复及类型分派
## 4. 接口与页面
- [x] 4.1 接入 REST/SSE 与运行配置，以 API 测试验证前置条件、幂等、错误及查询
- [x] 4.2 集成岗位深研入口、公司确认、过程与证据，以 Web 测试及浏览器检查验证
## 5. 交付验证
- [x] 5.1 更新架构、配置及操作文档，提供独立显式联网 smoke；通过文档/入口测试验证
- [x] 5.2 运行聚焦测试、workspace typecheck、OpenSpec strict 与 diff check，记录结果，不运行 build/全量 lint
