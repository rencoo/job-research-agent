## 1. 维度枚举与默认权重

- [x] 1.1 将 Domain `DIMENSIONS` 与默认权重改为六维（`work_content = 4`，删除 ownership / product_interest），并以 `packages/domain` 单测验证归一化总和为 1、只配置 career_growth 时 work_content 走默认、旧键不再被接受
- [x] 1.2 将 Contracts `DimensionIdSchema` 改为同一六维列表，并以契约测试验证长度为 6、包含 `work_content`、Profile 输入含 ownership 或 product_interest 时校验失败

## 2. 读取升维

- [x] 2.1 实现画像/快照权重升维纯函数：显式旧键写入 `work_content`（两者都有则取更高档），并以单测覆盖「仅 ownership=high」「ownership=high 且 product_interest=low」「已有 work_content 则忽略旧键」
- [x] 2.2 实现报告与 Claim 升维纯函数：ownership / product_interest 合并到 `work_content`（verdict 按 negative > mixed > positive，冲突为 mixed，risks/unknowns/claimIds 并集），并以单测验证冲突得到 mixed、未知侧不参与、statement 原文保留
- [x] 2.3 在 Profile 与 ScreeningReport 读路径接入升维且不回写历史行，并以 repository 或 Application 测试验证读出六维、磁盘 JSON 仍含旧键

## 3. 初筛产出与演示模型

- [x] 3.1 将 FakeModel / LocalDemoModel 的 Claim 维度改为 `work_content`，并以模型测试验证新报告 Claim 不含旧键
- [x] 3.2 更新 screening eval 样本与推荐策略断言，使内容侧 verdict 使用 `work_content`，并以 eval runner 验证至少 10 条样本仍通过且不访问网络
- [x] 3.3 更新报告组装，使新报告维度集合恰好为六维；并以 Server/Application 测试覆盖「产品对味但缺少主导权 → work_content=mixed 且两条 Claim 都在」以及「只有日常职责证据仍可判定」

## 4. 界面与架构基线

- [x] 4.1 将画像权重编辑器改为六维，文案为「工作内容」并说明包含主导权与产品方向，并以 Web 测试验证滑杆数量为 6、保存 body 含 `work_content`、不再提交旧键
- [x] 4.2 将报告卡片改为渲染六维标签，并以 Web 测试验证历史七维报告经 API 升维后只显示「工作内容」、不显示 Ownership / 产品兴趣
- [x] 4.3 更新 `docs/architecture.md` 七维基线为六维，并写明 `work_content` 包含主导权与产品方向；以文件内容可检索到新列表且不再列出 ownership / product_interest 作为顶层维来验证
