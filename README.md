# Job Research Agent

本地优先的求职研究工作台。当前垂直切片支持维护一份当前简历和求职画像、批量导入 JD 文本、确认结构化岗位草稿，并使用确定性的本地演示模型生成可解释初筛报告。

## 本地运行

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

- Web：Vite 默认地址（通常为 `http://localhost:5173`）
- Server：`http://127.0.0.1:4310`
- SQLite：默认保存在仓库 `.data/`；可通过 `JRA_DATA_DIR` 修改目录

主要入口：

- `/profile`：简历、目标岗位、地点、薪资、通勤容忍度、约束、红旗和七维权重
- `/import`：单个或批量导入 1–20 个 JD 文本
- `/opportunities`：搜索、筛选和查看历史岗位
- `/opportunities/:id`：修正并确认 Draft、启动初筛、观察 Run 和查看报告

## 当前分析流程

```text
保存简历与画像
→ 导入 JD 文本
→ 异步抽取 JobDraft
→ 用户修正并确认
→ 冻结 ProfileSnapshot / JobSnapshot
→ constraint_check
→ semantic_match
→ claim_validation
→ recommendation_policy
→ ScreeningReport
```

初筛由 `LocalDemoModel` 产生可校验的匹配证据，硬约束、blocking 红旗、薪资总包和最终推荐由确定性规则处理。报告会明确标注“本地演示模型”；它用于验证产品和工程链路，不代表真实联网调研结果。

未注明发薪月数时按 12 薪估算，并在 Draft 和报告中显示假设。公司可靠性与实际通勤时间在纯文本初筛中通常保持 `unknown`，供后续深度研究或用户核对。

## 聚焦验证

```bash
pnpm --filter @job-research/contracts test
pnpm --filter @job-research/domain test
pnpm --filter @job-research/database test
pnpm --filter @job-research/server test
pnpm --filter @job-research/web test
pnpm typecheck
pnpm exec openspec validate add-text-screening-vertical-slice --strict
git diff --check
```

默认测试和合成 Eval 不访问网络。项目约定不自动执行全量 build 或全量 lint。

## 当前不支持

- 不抓取 BOSS 或其他岗位网站，不读取登录态，也不绕过验证码或平台限制
- 不支持岗位链接抓取；仅提交 URL 时会提示用户粘贴 JD 正文
- 不支持截图或 PDF/DOCX 简历解析
- 不接入真实模型、联网搜索或公司深度研究
- 不自动计算地图距离或实际通勤时间
- 不自动投递、开聊或联系招聘方
- 不支持 Markdown/ZIP 导出、浏览器插件、桌面安装包或云同步
