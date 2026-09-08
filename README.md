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

### 公司与岗位深研

先完成当前 JD/画像的初筛，再在岗位详情点击「开始深度研究」。身份不明确时可选择候选、补充公司全名/官网，或跳过并得到部分报告。报告可展开原文证据、来源网址与读取时间；「刷新公司并重新研究」忽略旧公司缓存。

默认 `JRA_RESEARCH_MODE=demo` 完全离线，使用明确标注的合成公司，不能据此判断真实雇主。真实研究设置 `JRA_RESEARCH_MODE=live`、`JRA_MODEL_PROVIDER=deepseek`、`DEEPSEEK_API_KEY` 和 `TAVILY_API_KEY`，重启服务。缺失配置直接报错。研究搜索只发送公司/岗位问题，模型仅接收当前阶段必要的脱敏资料。不要提交真实 Key。

公开 JS 页面后备需要 Chromium：首次运行 `pnpm --filter @job-research/research-tools exec playwright install chromium`。未安装浏览器或页面受限时，记录读取失败并生成部分报告，不绕过登录/验证码。

研究按主题复用 7 天内的公司快照；可取消、失败重试，重启复用已保存结果。每次研究预算为 100 次工具/模型调用、30 分钟执行时间，继承到失败重试；外部请求在异常中断时仍可能重复计费。网页抓取不保证完整；未知项应向 HR/面试核实。

显式网络工具 smoke（会产生 Tavily 调用，不调用真实模型）：`JRA_RUN_RESEARCH_LIVE=1 pnpm test:research-live`。它只检查搜索和单页读取；默认测试使用 FakeSearch/FakePageReader/合成模型，不能替代真实研究质量评估。真实模型评测需另行显式执行，不能把离线测试通过解释为线上事实可靠性已验证。

深研迁移新增独立表，旧初筛继续可读；已有数据库发生新迁移前保存 SQLite 备份至数据目录 `backups/`，保留最近 5 份。回滚旧代码前恢复对应备份。
