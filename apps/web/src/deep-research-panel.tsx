import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DIMENSION_IDS, type DeepResearchReport, type EvidenceLink, type ResearchRun, type ResearchState } from "@job-research/contracts";
import { fetchDeepResearch, startDeepResearch, respondToCompany, fetchSourceDocument } from "./research-api";
import { cancelRun, fetchRun, retryRun, RunEventClient } from "./api";
import { formatSourceReadSummary, isActiveDeepRunStatus, projectDeepResearchFlow, type DeepFlowNodeState, deepRunRefetchInterval, deepViewRefetchInterval } from "./deep-research-flow";

const dimensions = { people_and_company_reliability: "靠谱的公司和人", life_radius: "合理生活半径", compensation_package: "薪资总包", workload_and_role_boundaries: "工作负荷与职责边界", work_content: "工作内容", career_growth: "职业成长" };
const statuses = { queued: "排队中", running: "研究中", waiting: "等待公司研究结果", needs_attention: "请确认公司", cancelling: "取消中", cancelled: "已取消", completed: "已完成", failed: "研究失败", superseded: "已被替代" };
const recommendations = { strong_match: "强匹配", worth_exploring: "值得深入", cautious: "需谨慎", not_recommended: "不推荐", insufficient_information: "信息不足" };
const reportStatus = { complete: "完整", partial: "部分", stale: "已过期", invalidated: "已失效" };
const claimStatus = { supported: "有证据支持", contested: "存在冲突", unsupported: "证据不足", unknown: "未知", rejected: "引用未通过核验" };
const verdicts = { positive: "匹配", negative: "不匹配", mixed: "一般 / 存在冲突", unknown: "未知" };
const stopReasons: Record<string, string> = { coverage_met: "研究问题已覆盖", no_new_evidence: "连续两轮未发现新证据", budget_exhausted: "达到本次研究上限", model_degraded: "模型未能完成全部结论，已输出部分报告" };
const flowNodeSymbols: Record<DeepFlowNodeState, string> = { complete: "✓", active: "•", waiting: "?", failed: "!", pending: "" };
const searchHitStatus = { ok: "已读取", blocked: "访问受限", failed: "未能读取", snippet: "搜索摘要" } as const;

function ErrorText({ error }: { error: unknown }) { return error ? <p className="notice error" role="alert">{error instanceof Error ? error.message : "操作失败"}</p> : null; }

export function SearchHitList({ hits }: { hits: NonNullable<ResearchState["searchHits"]> }) {
  if (!hits.length) return null;
  return <div className="search-hit-list"><h4>搜索到的公开链接</h4><p className="search-hit-intro">以下是联网搜索返回的页面；标记为「搜索摘要」的条目未能读取原网页，仅使用搜索引擎索引内容。</p><ul>{hits.map(hit => <li key={hit.url}><div className="search-hit-heading"><a href={hit.url} target="_blank" rel="noreferrer">{hit.title || hit.url}</a><span className={`search-hit-status ${hit.readStatus}`}>{searchHitStatus[hit.readStatus]}</span></div>{hit.snippet ? <p>{hit.snippet}</p> : null}<small>{hit.url}</small></li>)}</ul></div>;
}

export function SourceReadStats({ state }: { state: ResearchState }) {
  const summary = formatSourceReadSummary(state);
  if (!summary) return null;
  return <p className="research-source-stats">{summary}</p>;
}

export function DeepResearchFlow({ run, state }: { run: ResearchRun; state: ResearchState }) {
  const nodes = projectDeepResearchFlow(run, state);
  return <ol className="run-stage-list deep-research-flow" aria-label="深研流程">{nodes.map((node, index) => <li className={node.state} key={node.id} aria-current={node.state === "active" || node.state === "waiting" ? "step" : undefined}><span aria-hidden="true">{flowNodeSymbols[node.state] || index + 1}</span><small>{node.label}</small></li>)}</ol>;
}

export function ResearchDiagnosticPanel({ state }: { state: ResearchState }) {
  if (!state.diagnostic) return null;
  return <div className="research-diagnostic"><p>{state.diagnostic.message}</p><p className="research-diagnostic-action">{state.diagnostic.suggestedAction}</p><SourceReadStats state={state} /></div>;
}

export function EvidenceSource({ evidence }: { evidence: EvidenceLink }) {
  const source = useQuery({ queryKey: ["research-source", evidence.documentId], queryFn: () => fetchSourceDocument(evidence.documentId) });
  return <blockquote className="research-evidence"><p>{evidence.quote}</p><small>{evidence.relation === "refutes" ? "反驳依据" : "支持依据"} · {source.data?.title ?? "正在读取来源…"}</small>{source.data ? <p>{source.data.finalUrl ? <a href={source.data.finalUrl} target="_blank" rel="noreferrer">查看原网页</a> : <span>用户提供的资料</span>} · <time>{new Date(source.data.retrievedAt).toLocaleString()}</time></p> : null}<ErrorText error={source.error} /></blockquote>;
}

function CompanyAttention({ state, onChanged }: { state: ResearchState; onChanged(): void }) {
  const [hint, setHint] = useState("");
  const response = useMutation({ mutationFn: (input: Record<string, unknown>) => respondToCompany(state.runId, { ...input, expectedVersion: state.resolution.version }), onSuccess: onChanged });
  return <div className="company-attention"><h3>确认本次研究的公司</h3>{!state.diagnostic ? <p>请核对官网与主体；跳过后，公司相关判断将保持未知。</p> : null}{state.searchHits?.length ? <SearchHitList hits={state.searchHits} /> : null}{state.resolution.candidates.length ? state.resolution.candidates.map(candidate => <article className="card" key={candidate.id}><h4>{candidate.name}</h4><p>{candidate.legalName ?? "法律主体未确认"} · {candidate.location ?? "地点未知"}</p>{candidate.website ? <a href={candidate.website} target="_blank" rel="noreferrer">{candidate.website}</a> : null}{candidate.basis.map((basis, index) => <blockquote key={index}>{basis.quote}</blockquote>)}<button disabled={response.isPending} onClick={() => response.mutate({ action: "select", candidateId: candidate.id })}>选择此公司</button></article>) : !state.diagnostic && !state.searchHits?.length ? <p>尚未找到有足够依据的候选公司。</p> : null}<form className="company-attention-form" onSubmit={event => { event.preventDefault(); response.mutate({ action: "supplement", hint }); }}><label className="company-attention-field"><span className="company-attention-label">补充公司全名、官网或产品名称</span><input value={hint} maxLength={500} onChange={e => setHint(e.target.value)} /></label><div className="company-attention-actions"><button disabled={response.isPending || !hint.trim()}>补充并重新识别</button><button className="secondary" type="button" disabled={response.isPending} onClick={() => response.mutate({ action: "skip" })}>跳过公司确认</button></div></form><ErrorText error={response.error} /></div>;
}

function ResearchProgress({ state, onChanged }: { state: ResearchState; onChanged(): void }) {
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ["deep-run", state.runId],
    queryFn: () => fetchRun(state.runId),
    refetchInterval: (query) => deepRunRefetchInterval(query.state.data?.status),
  });
  useEffect(() => { const events = new RunEventClient(state.runId); events.connect(() => { void client.invalidateQueries({ queryKey: ["deep-run", state.runId] }); onChanged(); }, () => undefined); return () => events.disconnect(); }, [client, onChanged, state.runId]);
  const cancel = useMutation({ mutationFn: () => cancelRun(state.runId), onSuccess: onChanged });
  const retry = useMutation({ mutationFn: () => retryRun(state.runId), onSuccess: onChanged });
  const current = run.data;
  const cardClass = current ? `card run-progress-card deep-research-progress ${current.status}` : "card run-progress-card deep-research-progress";
  return <div className={cardClass} aria-live="polite">
    <div className="run-progress-head"><div><span className="run-status">{current ? statuses[current.status] : "读取研究进度…"}</span><h3>{current?.status === "failed" ? "深研未能完成" : current?.status === "needs_attention" ? "等待确认公司" : current?.status === "completed" ? "深研已完成" : "深研进行中"}</h3><p>{state.mode === "demo" ? "离线合成演示" : "真实联网研究"} · 已保存 {state.documentIds.length} 份资料{state.questions.length ? ` · 已覆盖 ${state.questions.filter(q => q.answered).length} / ${state.questions.length} 个研究问题` : ""}</p></div></div>
    {current ? <DeepResearchFlow run={current} state={state} /> : null}
    {(current?.status === "needs_attention" || current?.status === "failed" || (current?.status === "completed" && state.diagnostic)) ? <ResearchDiagnosticPanel state={state} /> : null}
    {current?.status === "failed" && !state.diagnostic && state.error ? <p className="notice error">{state.error}</p> : null}
    {state.questions.length ? <details><summary>查看研究问题</summary><ul>{state.questions.map(q => <li key={q.id}>{q.answered ? "已覆盖" : "待核实"}：{q.question}</li>)}</ul></details> : null}
    {current?.status === "needs_attention" ? <CompanyAttention state={state} onChanged={onChanged} /> : null}
    {current && isActiveDeepRunStatus(current.status) ? <button className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消深研</button> : null}
    {current?.status === "failed" ? <button disabled={retry.isPending} onClick={() => retry.mutate()}>重试深研</button> : null}
    <ErrorText error={run.error ?? cancel.error ?? retry.error} />
  </div>;
}

export function DeepReportCard({ report }: { report: DeepResearchReport }) {
  return <article className="report deep-report"><h3>{recommendations[report.recommendation]}</h3><p>{reportStatus[report.status]} · {report.mode === "demo" ? "离线合成演示，不代表目标公司的事实" : "真实联网研究"} · {stopReasons[report.stopReason] ?? report.stopReason}</p><div className="dimensions">{DIMENSION_IDS.map(id => <section className="dimension" key={id}><div className="dimension-heading"><strong>{dimensions[id]}</strong><span>{verdicts[report.dimensions[id].verdict]}</span></div>{report.dimensions[id].unknowns.map(item => <p key={item}>{item}</p>)}<details><summary>查看判断与证据 · {report.dimensions[id].claimIds.length} 条</summary>{report.claims.filter(c => report.dimensions[id].claimIds.includes(c.id)).map(claim => <div className="report-evidence" key={claim.id}><strong>{claim.statement}</strong><p>{claimStatus[claim.status]} · {claim.attribution}</p>{report.evidence.filter(e => e.claimId === claim.id).map(e => <EvidenceSource key={e.id} evidence={e} />)}</div>)}</details></section>)}</div>{report.risks.length ? <><h4>风险</h4><ul>{report.risks.map((item, i) => <li key={i}>{item}</li>)}</ul></> : null}{report.unknowns.length ? <details><summary>待向 HR / 面试核实</summary><ul>{report.unknowns.map((item, i) => <li key={i}>{item}</li>)}</ul></details> : null}{report.rules.length ? <ul>{report.rules.map((item, i) => <li key={i}>{item}</li>)}</ul> : null}</article>;
}

export function DeepResearchPanel({ opportunityId, canStart, runs }: { opportunityId: string; canStart: boolean; runs: ResearchRun[] }) {
  const client = useQueryClient(); const key = useRef(crypto.randomUUID());
  const activeDeepRun = runs.find(run => run.kind === "deep_research" && isActiveDeepRunStatus(run.status));
  const view = useQuery({
    queryKey: ["deep-research", opportunityId],
    queryFn: () => fetchDeepResearch(opportunityId),
    refetchInterval: deepViewRefetchInterval(Boolean(activeDeepRun)),
  });
  const refresh = () => { void client.invalidateQueries({ queryKey: ["deep-research", opportunityId] }); void client.invalidateQueries({ queryKey: ["opportunity", opportunityId] }); };
  const start = useMutation({ mutationFn: (refreshCompany: boolean) => startDeepResearch(opportunityId, key.current, { refreshCompany }), onSuccess: () => { key.current = crypto.randomUUID(); refresh(); } });
  const latest = view.data?.states[0];
  return <section className="deep-research-section"><div className="screening-heading"><h2>公司与岗位深研</h2><div className="run-actions"><button disabled={!canStart || Boolean(activeDeepRun) || start.isPending} onClick={() => start.mutate(false)}>开始深度研究</button>{view.data?.reports.length ? <button className="secondary" disabled={!canStart || Boolean(activeDeepRun) || start.isPending} onClick={() => start.mutate(true)}>刷新公司并重新研究</button> : null}</div></div>{!canStart ? <p>完成当前岗位的有效初筛后，可继续研究公司与公开信息。</p> : null}<ErrorText error={view.error ?? start.error} />{latest ? <ResearchProgress key={latest.runId} state={latest} onChanged={refresh} /> : <p>核实公司身份，查阅公开资料，并为关键结论保留原文依据。</p>}{view.data?.reports.map(report => <DeepReportCard key={report.id} report={report} />)}</section>;
}
