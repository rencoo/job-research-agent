# Job Research Agent

本地优先的求职研究工作台。当前垂直切片支持维护一份当前简历和求职画像、批量导入 JD 文本、确认结构化岗位草稿，并使用本地演示模型或显式启用的 DeepSeek 生成可解释初筛报告。

## 本地运行

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

- Web：Vite 默认地址（通常为 `http://localhost:5173`）
- Server：`http://127.0.0.1:4310`
- SQLite：默认保存在仓库 `.data/`；可通过 `JRA_DATA_DIR` 修改目录

默认使用离线且确定性的 `LocalDemoModel`。如需接入 DeepSeek，在项目根目录创建不提交到 Git 的 `.env`，或在启动进程中设置：

```bash
JRA_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的_API_Key
JRA_DEEPSEEK_MODEL=deepseek-v4-flash
```

启动时若 provider 非法或缺少 Key，服务会直接报错，不会静默退回本地模型。要回滚到完全离线模式，将 `JRA_MODEL_PROVIDER` 改回 `local` 并重启即可；无需删除历史数据。

主要入口：

- `/profile`：简历、目标岗位、地点、薪资、通勤容忍度、约束、红旗和六维权重
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

模型只负责 JD 字段抽取与候选匹配证据；硬约束、blocking 红旗、薪资总包和最终推荐始终由确定性规则处理。每次导入和分析都会冻结 provider、模型名与 Prompt 版本，报告也会保留相同来源，因此后续修改环境变量不会改写已有记录。

DeepSeek 模式会把当前 JD 和本次匹配所需的简历内容发送到 DeepSeek API。发送前会确定性移除简历中的手机号和邮箱；原始本地快照不变。API Key、完整简历、完整 JD 和完整 Prompt 不写入普通错误或任务事件。姓名、公司名及其他非手机号/邮箱信息目前不会自动脱敏，因此启用前请确认你接受这一边界。

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

真实模型 smoke/Eval 不在默认测试链路中，并有双重开关。只有你明确接受外部请求和费用时才运行：

```bash
JRA_RUN_LIVE_EVAL=1 \
JRA_MODEL_PROVIDER=deepseek \
DEEPSEEK_API_KEY=你的_API_Key \
pnpm test:deepseek-live
```

该入口只使用合成简历和 JD，发起一次抽取与一次匹配请求。未设置 `JRA_RUN_LIVE_EVAL=1` 时会直接拒绝执行。

## 当前不支持

- 不抓取 BOSS 或其他岗位网站，不读取登录态，也不绕过验证码或平台限制
- 不支持岗位链接抓取；仅提交 URL 时会提示用户粘贴 JD 正文
- 不支持截图或 PDF/DOCX 简历解析
- DeepSeek 仅用于 JD 抽取和简历匹配；不包含联网搜索、实时职位抓取或公司深度研究
- 不自动计算地图距离或实际通勤时间
- 不自动投递、开聊或联系招聘方
- 不支持 Markdown/ZIP 导出、浏览器插件、桌面安装包或云同步
