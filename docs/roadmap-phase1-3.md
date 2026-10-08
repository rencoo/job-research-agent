# Job Research Agent - Phase 1-3 深度优化路线图

> 生成时间: 2026-10-08
> 状态: 进行中
> 排除范围: Phase 4 商业化探索

## 总体目标

从"MVP工具"升级为"智能决策助手"，建立数据飞轮和技术护城河。

---

## Phase 1: 当前深化 (优先级: P0)

**目标**: 完善核心体验，建立数据基础

### 1.1 完成现有 OpenSpec 变更
- [ ] #issue-tbd `merge-screening-work-content-dimension` - 合并工作内容维度
- [ ] #issue-tbd `align-job-draft-preview-edit` - Draft 预览编辑对齐
- [ ] #issue-tbd `add-deep-research-diagnostics` - 深研诊断增强

### 1.2 对话式追问能力
- [ ] #issue-tbd 基础对话引擎 - 基于报告上下文的问答
- [ ] #issue-tbd 主动提问系统 - 识别未知项并生成追问
- [ ] #issue-tbd 面试准备助手 - 生成面试问题清单
- [ ] #issue-tbd 对话历史持久化 - 学习用户关注点

### 1.3 多模态输入支持
- [ ] #issue-tbd PDF 简历解析 - pdf-parse + 结构化抽取
- [ ] #issue-tbd 图片 OCR 支持 - Tesseract.js 集成
- [ ] #issue-tbd 截图导入优化 - 自动识别招聘平台格式
- [ ] #issue-tbd 多模态数据模型 - 扩展 SourceInput 类型

### 1.4 个人决策模型基础版
- [ ] #issue-tbd 用户反馈收集 - 标记系统(感兴趣/不考虑/已投递)
- [ ] #issue-tbd 隐式反馈学习 - 从标记行为调整权重
- [ ] #issue-tbd 偏好发现 - 分析用户决策模式
- [ ] #issue-tbd 权重自适应 - 基于历史数据优化推荐

---

## Phase 2: 数据闭环 (优先级: P1)

**目标**: 建立知识积累和质量保证体系

### 2.1 知识图谱基础架构
- [ ] #issue-tbd 图数据模型设计 - Entity/Relation/Attribute schema
- [ ] #issue-tbd 公司实体消歧 - 处理品牌/法人/子公司关系
- [ ] #issue-tbd 技能本体构建 - 技能分类和关联
- [ ] #issue-tbd 行业分类体系 - Industry taxonomy
- [ ] #issue-tbd 图查询接口 - 跨岗位关联分析

### 2.2 历史分析与趋势洞察
- [ ] #issue-tbd 市场定位分析 - 计算画像稀缺度和薪资分位数
- [ ] #issue-tbd 趋势识别引擎 - 发现技能/薪资/岗位趋势
- [ ] #issue-tbd 决策复盘 - 回顾历史决策的后续发展
- [ ] #issue-tbd 简历优化建议 - 基于投递岗位分析简历缺陷
- [ ] #issue-tbd 组合分析仪表盘 - Portfolio analytics UI

### 2.3 质量保证体系
- [ ] #issue-tbd 输入质量检测 - JD完整性/真实性验证
- [ ] #issue-tbd 输出质量评分 - 引用覆盖率/逻辑一致性
- [ ] #issue-tbd 幻觉检测器 - 模型输出与源文档对比
- [ ] #issue-tbd 自动修复机制 - 降级策略和人工审核触发
- [ ] #issue-tbd 质量门禁 - CI 集成质量检查

### 2.4 可观测性基建
- [ ] #issue-tbd 性能追踪 - 各阶段延迟监控
- [ ] #issue-tbd 成本监控 - 模型调用 token 和费用统计
- [ ] #issue-tbd 质量指标 - 证据覆盖度/用户满意度
- [ ] #issue-tbd 异常检测 - 错误率/成功率监控
- [ ] #issue-tbd 仪表盘 - Telemetry dashboard UI

---

## Phase 3: 智能升级 (优先级: P2)

**目标**: 差异化能力和极致体验

### 3.1 本地 RAG + 私有知识库
- [ ] #issue-tbd 本地向量数据库 - LanceDB 集成
- [ ] #issue-tbd 文档导入器 - Notion/Markdown/Evernote
- [ ] #issue-tbd 语义搜索 - 基于 embedding 的检索
- [ ] #issue-tbd 知识融合 - 私人笔记 + 公开数据
- [ ] #issue-tbd RAG 管道 - Context building with private knowledge

### 3.2 实时市场监控
- [ ] #issue-tbd 公司动态监控 - 融资/裁员/HC 变化
- [ ] #issue-tbd 岗位市场监控 - 定向岗位出现推送
- [ ] #issue-tbd 数据采集器 - RSS/招聘网站/社交媒体
- [ ] #issue-tbd 预警系统 - 关键事件推送
- [ ] #issue-tbd 监控仪表盘 - Watchlist UI

### 3.3 A/B 测试平台
- [ ] #issue-tbd 实验框架 - 定义实验/变体/指标
- [ ] #issue-tbd 自动分流 - User assignment
- [ ] #issue-tbd 指标收集 - Tracking infrastructure
- [ ] #issue-tbd 统计分析 - 显著性检验和结论
- [ ] #issue-tbd 实验管理 UI - 创建/监控/分析实验

### 3.4 时间线与对比工具
- [ ] #issue-tbd 时间线数据模型 - 事件流和状态转换
- [ ] #issue-tbd 手动事件标记 - 投递/面试/offer 记录
- [ ] #issue-tbd 时间线可视化 - Timeline UI component
- [ ] #issue-tbd 多维对比矩阵 - Offer comparison table
- [ ] #issue-tbd 敏感性分析 - What-if 场景模拟
- [ ] #issue-tbd 决策建议引擎 - 综合推荐

---

## 实施原则

### 技术债务管理
- 每个新特性必须有测试覆盖
- 保持架构清晰，领域层不依赖基础设施
- 新增依赖需评审，优先本地优先方案

### 数据隐私
- 所有新功能默认本地存储
- 外部调用需明确用户授权
- 敏感数据脱敏和加密

### 性能预算
- 单次分析不超过 60s
- UI 响应不超过 200ms
- 数据库查询不超过 100ms

### 质量门禁
- TypeScript strict mode
- 单元测试覆盖率 > 80%
- E2E 测试覆盖核心流程
- 无 ESLint 错误

---

## 里程碑

### Milestone 1: Phase 1 完成 (目标: 4-6周)
- 所有 OpenSpec 变更合并
- 对话功能可用
- PDF/图片输入支持
- 用户反馈系统上线

### Milestone 2: Phase 2 完成 (目标: 8-12周)
- 知识图谱基础可用
- 历史分析功能完整
- 质量保证体系建立
- 可观测性仪表盘上线

### Milestone 3: Phase 3 完成 (目标: 14-18周)
- 本地 RAG 可用
- 市场监控上线
- A/B 测试框架可用
- 时间线和对比工具完整

---

## 进度跟踪

- 使用 GitHub Issues 跟踪每个任务
- 使用 GitHub Projects 管理整体进度
- 每周回顾和调整优先级
- 每个 milestone 结束进行复盘

---

## 下一步行动

1. ✅ 创建 GitHub Milestones
2. ✅ 为每个任务创建 Issue
3. 🚀 开始实施 Phase 1.1 - 完成 OpenSpec 变更
4. 🚀 并行实施 Phase 1.2 - 对话引擎基础

---

## 附录：依赖清单

### Phase 1 新增依赖
```json
{
  "pdf-parse": "^1.1.1",
  "tesseract.js": "^5.0.0"
}
```

### Phase 2 新增依赖
```json
{
  "@opentelemetry/sdk-node": "^0.50.0",
  "@opentelemetry/auto-instrumentations-node": "^0.40.0"
}
```

### Phase 3 新增依赖
```json
{
  "lancedb": "^0.5.0",
  "feedparser": "^3.0.0",
  "cheerio": "^1.0.0"
}
```
