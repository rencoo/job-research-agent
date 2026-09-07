import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import { DIMENSION_IDS, type DimensionId, type Profile, type ScreeningReport } from "@job-research/contracts";
import { ApiError, RunEventClient, cancelRun, confirmDraft, fetchImportBatch, fetchOpportunities, fetchOpportunity, fetchProfile, fetchRun, importJobTexts, patchDraft, retryImportItem, retryRun, saveProfile, startScreening } from "./api";
import { detailRoute } from "./App";

const labels: Record<DimensionId, string> = { people_and_company_reliability: "靠谱的公司和人", life_radius: "合理生活半径", compensation_package: "薪资总包", workload_and_role_boundaries: "工作负荷与职责边界", work_content: "工作内容", career_growth: "职业成长" };
const recommendationLabels: Record<ScreeningReport["recommendation"], string> = { strong_match: "强匹配", worth_exploring: "值得深入", cautious: "需谨慎", not_recommended: "不推荐", insufficient_information: "信息不足" };
const historyImportLabels: Record<string, string> = { queued: "排队中", extracting: "识别中", ready: "已抽取", failed: "失败", needs_input: "待补充" };
const historyDraftLabels: Record<string, string> = { draft: "草稿", confirmed: "已确认" };
const reportStatusLabels: Record<ScreeningReport["status"], string> = { complete: "完整", partial: "部分", stale: "已过期", invalidated: "已失效" };
const confidenceLabels = { high: "高", medium: "中", low: "低" } as const;
const verdictLabels = { positive: "匹配", mixed: "一般", negative: "不匹配", unknown: "未知" } as const;
const claimStatusLabels = { supported: "已支持", contested: "有争议", unsupported: "无依据", unknown: "未知", rejected: "已驳回" } as const;
const screeningStages = [
  { id: "constraint_check", label: "条件检查", title: "正在检查硬性条件", description: "核对必选条件、排除项和风险信号。" },
  { id: "semantic_match", label: "匹配分析", title: "正在分析简历与岗位", description: "AI 正在提取简历和 JD 中可核验的匹配证据，这一步通常耗时最长。" },
  { id: "claim_validation", label: "证据核验", title: "正在核验分析证据", description: "确认每条判断都能在简历和 JD 原文中找到依据。" },
  { id: "recommendation_policy", label: "结论计算", title: "正在计算匹配结论", description: "结合六个评测维度、薪资和硬性规则计算推荐档位。" },
  { id: "screening_report", label: "生成报告", title: "正在生成分析报告", description: "整理匹配点、风险、未知项和后续建议。" },
] as const;
const splitLines = (value: string) => value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
const profilePlaceholders = {
  resumeText: "粘贴完整简历文本，建议包含工作经历、项目经历、技能与教育背景",
  targetRoles: "例如：AI 应用工程师, AI Product Engineer",
  targetLocations: "例如：杭州, 上海, 远程；多个地点用逗号分隔",
  salaryMin: "例如：25000",
  salaryMax: "例如：35000",
  commute: "例如：45",
  highlights: "例如：Agent Runtime、工作流编排、编辑器、AI 视频",
  required: "必须满足，例如：双休、不接受外包",
  preferred: "优先考虑，例如：AI 原生产品、允许远程",
  warnings: "需要谨慎评估，例如：长期高频加班",
  blocking: "直接排除，例如：薪资低于底线",
} as const;

const weightLevelLabels = ["较低", "一般", "较高"] as const;
const weightTiers = ["low", "medium", "high"] as const;
const tierLevels = { low: 1, medium: 2, high: 3 } as const;
const legacyWeightLevel = (share: number) => share <= 0.1 ? 1 : share <= 0.2 ? 2 : 3;
const editableWeightLevel = (input: number | "low" | "medium" | "high" | undefined, normalized: number) => typeof input === "string" ? tierLevels[input] : typeof input === "number" ? Math.max(1, Math.min(3, Math.round((input + 1) / 2))) : legacyWeightLevel(normalized);

function PencilIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M15.2 5.2 18.8 8.8M4 20l4.4-1 10.9-10.9a2.5 2.5 0 0 0-3.5-3.5L4.9 15.5 4 20Z" /></svg>;
}

function ChevronIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>;
}

function submitOnShortcut(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function EditableResume({ value, onChange, defaultEditing, ariaLabel, hintId }: { value: string; onChange(value: string): void; defaultEditing: boolean; ariaLabel: string; hintId?: string }) {
  const [editing, setEditing] = useState(defaultEditing);
  const [original, setOriginal] = useState(value);
  const beginEditing = () => { setOriginal(value); setEditing(true); };
  const cancelEditing = () => { onChange(original); setEditing(!original.trim()); };
  if (editing) return <div className="editable-field editing"><textarea autoFocus aria-label={ariaLabel} aria-describedby={hintId} rows={12} placeholder={profilePlaceholders.resumeText} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelEditing(); } else submitOnShortcut(event); }} required /><div className="inline-edit-actions"><button type="button" className="text-button" onClick={cancelEditing}>取消</button><button type="button" className="secondary compact-button" disabled={!value.trim()} onClick={() => setEditing(false)}>完成</button></div></div>;
  return <div className="editable-preview resume-preview" role="button" tabIndex={0} aria-label="编辑当前简历" onClick={beginEditing} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); beginEditing(); } }}><span className="edit-affordance"><PencilIcon /><span>编辑</span></span><div className="preview-scroll"><div className="markdown-body"><ReactMarkdown components={{ a: ({ children }) => <span className="markdown-link">{children}</span>, img: ({ alt }) => <span>{alt ?? ""}</span> }}>{value}</ReactMarkdown></div></div></div>;
}

function EditableRoles({ value, onChange, defaultEditing, ariaLabel }: { value: string; onChange(value: string): void; defaultEditing: boolean; ariaLabel: string }) {
  const [editing, setEditing] = useState(defaultEditing);
  const [original, setOriginal] = useState(value);
  const beginEditing = () => { setOriginal(value); setEditing(true); };
  const cancelEditing = () => { onChange(original); setEditing(!original.trim()); };
  if (editing) return <div className="editable-field editing"><input autoFocus aria-label={ariaLabel} placeholder={profilePlaceholders.targetRoles} value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelEditing(); } else submitOnShortcut(event); }} required /><div className="inline-edit-actions"><button type="button" className="text-button" onClick={cancelEditing}>取消</button><button type="button" className="secondary compact-button" disabled={!splitLines(value).length} onClick={() => setEditing(false)}>完成</button></div></div>;
  return <div className="editable-preview roles-preview" role="button" tabIndex={0} aria-label="编辑目标岗位" onClick={beginEditing} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); beginEditing(); } }}><span className="edit-affordance"><PencilIcon /><span>编辑</span></span><div className="role-tags">{splitLines(value).map((role) => <span key={role}>{role}</span>)}</div></div>;
}

const preferenceFields = [
  { key: "targetRoles", label: "目标岗位", placeholder: profilePlaceholders.targetRoles, control: "input" },
  { key: "targetLocations", label: "期望地点", placeholder: profilePlaceholders.targetLocations, control: "input" },
  { key: "salaryMin", label: "最低月薪", placeholder: profilePlaceholders.salaryMin, control: "number" },
  { key: "salaryMax", label: "最高月薪", placeholder: profilePlaceholders.salaryMax, control: "number" },
  { key: "commute", label: "通勤容忍（分钟）", placeholder: profilePlaceholders.commute, control: "number" },
  { key: "highlights", label: "技能与经历重点", placeholder: profilePlaceholders.highlights, control: "textarea" },
  { key: "required", label: "必须满足", placeholder: profilePlaceholders.required, control: "textarea" },
  { key: "preferred", label: "优先考虑", placeholder: profilePlaceholders.preferred, control: "textarea" },
  { key: "warnings", label: "谨慎评估", placeholder: profilePlaceholders.warnings, control: "textarea" },
  { key: "blocking", label: "直接排除", placeholder: profilePlaceholders.blocking, control: "textarea" },
] as const;
type PreferenceKey = (typeof preferenceFields)[number]["key"];
type PreferenceValues = Record<PreferenceKey, string>;
const previewText = (value: string) => { const items = splitLines(value); return items.length ? items.join("、") : "-"; };

function EditablePreferences({ values, onChange }: { values: PreferenceValues; onChange(patch: Partial<PreferenceValues>): void }) {
  const [editing, setEditing] = useState(false);
  const [original, setOriginal] = useState(values);
  const beginEditing = () => { setOriginal(values); setEditing(true); };
  const cancelEditing = () => { onChange(original); setEditing(false); };
  const bindField = (field: (typeof preferenceFields)[number]) => ({
    "aria-label": field.label,
    placeholder: field.placeholder,
    value: values[field.key],
    onChange: (event: { target: { value: string } }) => onChange({ [field.key]: event.target.value }),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (event.key === "Escape") { event.preventDefault(); cancelEditing(); } else submitOnShortcut(event); },
    required: field.key === "targetRoles",
  });
  if (editing) return <div className="editable-field editing"><div className="grid">{preferenceFields.map((field) => <label key={field.key}>{field.label}{field.control === "textarea" ? <textarea {...bindField(field)} /> : <input type={field.control === "number" ? "number" : "text"} {...bindField(field)} />}</label>)}</div><div className="inline-edit-actions"><button type="button" className="text-button" onClick={cancelEditing}>取消</button><button type="button" className="secondary compact-button" onClick={() => setEditing(false)}>完成</button></div></div>;
  return <div className="editable-preview preferences-preview"><button type="button" className="edit-affordance" aria-label="编辑分析偏好" onClick={beginEditing}><PencilIcon /><span>编辑</span></button><div className="grid">{preferenceFields.map((field) => { const items = splitLines(values[field.key]); const text = previewText(values[field.key]); return <div className="form-field" key={field.key}><span className="field-label">{field.label}</span>{field.key === "targetRoles" && items.length ? <div className="role-tags">{items.map((role) => <span key={role}>{role}</span>)}</div> : <span className={items.length ? "preview-value" : "preview-value empty"} title={items.length ? text : undefined}>{text}</span>}</div>; })}</div></div>;
}

export function ProfilePage() {
  const queryClient = useQueryClient(); const profile = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile(), retry: false });
  const [form, setForm] = useState({ resumeText: "", targetRoles: "", targetLocations: "", salaryMin: "", salaryMax: "", commute: "", highlights: "", required: "", preferred: "", warnings: "", blocking: "", weights: Object.fromEntries(DIMENSION_IDS.map((id) => [id, "2"])) as Record<DimensionId, string> });
  useEffect(() => { if (!profile.data) return; setForm({ resumeText: profile.data.resumeText, targetRoles: profile.data.targetRoles.join(", "), targetLocations: profile.data.targetLocations.join(", "), salaryMin: profile.data.salary?.minMonthly.toString() ?? "", salaryMax: profile.data.salary?.maxMonthly.toString() ?? "", commute: profile.data.commuteToleranceMinutes?.toString() ?? "", highlights: profile.data.highlights.join("\n"), required: profile.data.constraints.filter((x) => x.level === "required").map((x) => x.text).join("\n"), preferred: profile.data.constraints.filter((x) => x.level === "preferred").map((x) => x.text).join("\n"), warnings: profile.data.redFlags.filter((x) => x.level === "warning").map((x) => x.text).join("\n"), blocking: profile.data.redFlags.filter((x) => x.level === "blocking").map((x) => x.text).join("\n"), weights: Object.fromEntries(DIMENSION_IDS.map((id) => [id, editableWeightLevel(profile.data!.weightInputs?.[id], profile.data!.weights[id]).toString()])) as Record<DimensionId, string> }); }, [profile.data]);
  const mutation = useMutation({ mutationFn: () => saveProfile({ resumeText: form.resumeText, targetRoles: splitLines(form.targetRoles), targetLocations: splitLines(form.targetLocations), salary: form.salaryMin && form.salaryMax ? { minMonthly: Number(form.salaryMin), maxMonthly: Number(form.salaryMax) } : null, commuteToleranceMinutes: form.commute ? Number(form.commute) : null, highlights: splitLines(form.highlights), constraints: [...splitLines(form.required).map((text) => ({ text, level: "required" })), ...splitLines(form.preferred).map((text) => ({ text, level: "preferred" }))], redFlags: [...splitLines(form.warnings).map((text) => ({ text, level: "warning" })), ...splitLines(form.blocking).map((text) => ({ text, level: "blocking" }))], weights: Object.fromEntries(DIMENSION_IDS.map((id) => [id, weightTiers[Number(form.weights[id]) - 1]])), expectedVersion: profile.data?.version ?? null }), onSuccess: (value) => queryClient.setQueryData(["profile"], value) });
  const update = (key: Exclude<keyof typeof form, "weights">, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <main className="shell"><h1>我的简历与画像</h1><p className="subtitle">只维护一份当前简历；每次分析会冻结独立快照。</p>{profile.isError ? <ErrorNotice error={profile.error} /> : null}<form className="form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-field"><span className="field-label">当前简历</span><EditableResume key={`resume-${profile.data?.version ?? "new"}`} ariaLabel="当前简历" hintId="resume-hint" value={form.resumeText} onChange={(value) => update("resumeText", value)} defaultEditing={!profile.data} /><small className="field-hint" id="resume-hint">支持 Markdown；将用于岗位匹配分析，每次分析都会保存当时的独立快照。</small></div><EditablePreferences key={`prefs-${profile.data?.version ?? "new"}`} values={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} /><fieldset className="weight-editor"><legend>评测维度权重</legend><p className="field-hint">选择每个维度对你的重要程度；工作内容包含主导权和产品方向。系统评分时会自动换算为相对权重，无需关心数值或总和。</p><div className="weight-controls">{DIMENSION_IDS.map((id) => { const level = Number(form.weights[id]); const levelLabel = weightLevelLabels[level - 1]; return <label className="weight-control" key={id}><span className="weight-control-head"><span>{labels[id]}</span><strong>{levelLabel}</strong></span><input aria-label={`${labels[id]}重要程度`} aria-valuetext={levelLabel} type="range" min="1" max="3" step="1" value={level} onChange={(e) => setForm((current) => ({ ...current, weights: { ...current.weights, [id]: e.target.value } }))} /><span className="weight-scale" aria-hidden="true"><span>较低</span><span>一般</span><span>较高</span></span></label>; })}</div></fieldset>{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<button disabled={mutation.isPending || !form.resumeText.trim() || !splitLines(form.targetRoles).length}>{mutation.isPending ? "保存中…" : "保存画像"}</button>{mutation.isSuccess ? <span role="status">已保存</span> : null}</form></main>;
}

export function ImportPage() {
  const [items, setItems] = useState([""]); const [batchId, setBatchId] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile(), retry: false });
  const recent = useQuery({ queryKey: ["opportunities", "recent"], queryFn: () => fetchOpportunities() });
  const mutation = useMutation({ mutationFn: () => importJobTexts(items.map((text) => ({ text }))), onSuccess: (receipt) => setBatchId(receipt.resourceId) });
  const batch = useQuery({ queryKey: ["import-batch", batchId], queryFn: () => fetchImportBatch(batchId!), enabled: Boolean(batchId), refetchInterval: (query) => query.state.data?.items.every((item) => ["ready", "failed", "needs_input"].includes(item.status)) ? false : 600 });
  return <main className="shell analysis-shell">
    <header className="page-intro"><p className="eyebrow">FIRST-PASS SCREENING</p><h1>判断这个岗位值不值得跟</h1><p className="subtitle">对照你的简历和求职底线，标出匹配点、风险和还看不清的地方，帮你决定要不要继续花时间。</p></header>
    <section className={`profile-context ${profile.data ? "ready" : "missing"}`} aria-label="本次分析使用的简历">
      <div><small>本次分析使用</small>{profile.isPending ? <strong>正在读取简历…</strong> : profile.data ? <><strong>{profile.data.targetRoles.join(" / ") || "当前简历"}</strong><span>简历版本 {profile.data.resumeVersion} · 分析时会保存独立快照</span></> : <><strong>还没有可用简历</strong><span>可以先粘贴 JD，识别完成后再补充简历。</span></>}</div>
      <button type="button" className="secondary" onClick={() => setProfileOpen(true)}>{profile.data ? "预览与修改" : "录入简历"}</button>
    </section>
    <section className="analysis-panel">
      <div className="section-heading"><div><span className="step-label">第一步</span><h2>粘贴岗位描述</h2></div><span className="field-hint">支持同时处理 1–20 个 JD 文本</span></div>
      <form className="form" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>{items.map((text, index) => <label key={index}>JD {index + 1}<textarea aria-label={`JD ${index + 1}`} rows={items.length === 1 ? 10 : 7} placeholder="粘贴岗位职责、任职要求、薪资地点等完整正文…" value={text} onChange={(e) => setItems((current) => current.map((item, i) => i === index ? e.target.value : item))} required />{items.length > 1 ? <button type="button" className="text-button" onClick={() => setItems((current) => current.filter((_, i) => i !== index))}>移除此项</button> : null}</label>)}<div className="actions split-actions"><button type="button" className="secondary" disabled={items.length >= 20} onClick={() => setItems((current) => [...current, ""])}>+ 添加另一个 JD</button><button disabled={mutation.isPending}>{mutation.isPending ? "正在识别…" : `识别岗位（${items.length}）`}</button></div>{mutation.error ? <ErrorNotice error={mutation.error} /> : null}</form>
    </section>
    {batch.data ? <section className="result-section"><div className="section-heading"><div><span className="step-label">第二步</span><h2>确认岗位信息</h2></div></div>{batch.data.items.map((item) => <article className="card import-result" key={item.id}><div><strong>{importStatusLabel(item.status)}</strong><span>岗位 {item.opportunityId.slice(0, 8)}</span></div>{item.error ? <span>{item.error.message}</span> : null}{item.status === "failed" ? <button onClick={() => void retryImportItem(item.id).then(() => batch.refetch())}>重试</button> : null}{item.status === "needs_input" ? <p>该输入只有链接，请重新粘贴 JD 文本。</p> : null}{item.status === "ready" ? <Link className="primary-link" to="/opportunities/$opportunityId" params={{ opportunityId: item.opportunityId }}>确认信息并继续分析</Link> : null}</article>)}</section> : null}
    <section className="recent-section"><div className="section-heading"><div><span className="step-label">最近</span><h2>分析记录</h2></div><Link to="/opportunities">查看全部</Link></div>{recent.data?.length ? <ul className="recent-list">{recent.data.slice(0, 3).map((item) => <li key={item.id}><Link className="recent-item" to="/opportunities/$opportunityId" params={{ opportunityId: item.id }}><strong>{item.title ?? "待补充岗位名称"}</strong><span>{item.company ?? "公司未知"} · {item.location ?? "地点未知"}</span></Link></li>)}</ul> : <p className="empty-copy">完成第一次岗位分析后，结果会出现在这里。</p>}</section>
    {profileOpen ? <ResumeDialog profile={profile.data ?? null} onClose={() => setProfileOpen(false)} /> : null}
  </main>;
}

function importStatusLabel(status: string) {
  if (status === "queued" || status === "extracting") return "正在识别岗位信息";
  if (status === "ready") return "岗位信息已识别";
  if (status === "needs_input") return "需要补充正文";
  return "识别失败";
}

function ResumeDialog({ profile, onClose }: { profile: Profile | null; onClose(): void }) {
  const client = useQueryClient();
  const [resumeText, setResumeText] = useState(profile?.resumeText ?? "");
  const [targetRoles, setTargetRoles] = useState(profile?.targetRoles.join(", ") ?? "");
  const mutation = useMutation({
    mutationFn: () => saveProfile({
      resumeText,
      targetRoles: splitLines(targetRoles),
      targetLocations: profile?.targetLocations ?? [],
      salary: profile?.salary ?? null,
      commuteToleranceMinutes: profile?.commuteToleranceMinutes ?? null,
      highlights: profile?.highlights ?? [],
      constraints: profile?.constraints ?? [],
      redFlags: profile?.redFlags ?? [],
      weights: Object.fromEntries(DIMENSION_IDS.map((id) => [id, profile?.weightInputs?.[id] ?? profile?.weights[id] ?? "medium"])),
      expectedVersion: profile?.version ?? null,
    }),
    onSuccess: (value) => { client.setQueryData(["profile"], value); onClose(); },
  });
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-title"><div className="dialog-head"><div><span className="step-label">分析前置资料</span><h2 id="resume-dialog-title">{profile ? "预览与修改简历" : "录入你的简历"}</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div><p className="field-hint">这里只需完成分析必需的信息；地点、薪资和评测偏好可以稍后完善。</p><form className="form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-field"><span className="field-label">当前简历</span><EditableResume ariaLabel="弹窗当前简历" value={resumeText} onChange={setResumeText} defaultEditing={!profile} /><small className="field-hint">支持 Markdown 预览</small></div><div className="form-field"><span className="field-label">目标岗位</span><EditableRoles ariaLabel="弹窗目标岗位" value={targetRoles} onChange={setTargetRoles} defaultEditing={!profile} /></div>{mutation.error ? <ErrorNotice error={mutation.error} /> : null}<div className="actions dialog-actions"><Link to="/profile" onClick={onClose}>完善分析偏好</Link><button disabled={mutation.isPending || !resumeText.trim() || !splitLines(targetRoles).length}>{mutation.isPending ? "保存中…" : "保存并用于分析"}</button></div></form></section></div>;
}

export function OpportunitiesPage() {
  const [filters, setFilters] = useState({ keyword: "", status: "", recommendation: "" }); const query = useQuery({ queryKey: ["opportunities", filters], queryFn: () => fetchOpportunities(filters) });
  return <main className="shell history-shell">
    <header className="page-intro"><h1>历史岗位</h1><p className="subtitle">通过搜索和筛选回看历史数据，不使用看板。</p></header>
    <div className="filters">
      <input aria-label="关键词" placeholder="岗位、公司或地点" value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} />
      <select aria-label="状态" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option><option value="ready">已抽取</option><option value="confirmed">已确认</option><option value="failed">失败</option></select>
      <select aria-label="推荐" value={filters.recommendation} onChange={(e) => setFilters({ ...filters, recommendation: e.target.value })}><option value="">全部推荐</option>{(Object.keys(recommendationLabels) as Array<ScreeningReport["recommendation"]>).map((value) => <option key={value} value={value}>{recommendationLabels[value]}</option>)}</select>
    </div>
    {query.isPending ? <p role="status">加载中…</p> : null}{query.error ? <ErrorNotice error={query.error} /> : null}{query.data?.length === 0 ? <p className="empty-copy">暂无匹配岗位。</p> : null}
    {query.data?.length ? <div className="history-list">{query.data.map((item) => <Link className="history-item" key={item.id} to="/opportunities/$opportunityId" params={{ opportunityId: item.id }}><div><strong>{item.title ?? "待补充岗位名称"}</strong><span>{item.company ?? "公司未知"} · {item.location ?? "地点未知"}</span></div><small><strong>{item.recommendation ? recommendationLabels[item.recommendation] : "未分析"}</strong><span>{historyImportLabels[item.importStatus] ?? item.importStatus} · {historyDraftLabels[item.draftStatus] ?? item.draftStatus}</span></small></Link>)}</div> : null}
  </main>;
}

const draftFields = [
  { key: "title", label: "岗位名称", multiline: false },
  { key: "company", label: "公司", multiline: false },
  { key: "location", label: "地点", multiline: false },
  { key: "salaryMinMonthly", label: "最低月薪", multiline: false },
  { key: "salaryMaxMonthly", label: "最高月薪", multiline: false },
  { key: "payMonths", label: "发薪月数", multiline: false },
  { key: "responsibilities", label: "岗位职责", multiline: true },
  { key: "requirements", label: "任职要求", multiline: true },
  { key: "benefits", label: "福利", multiline: true },
] as const;
type DraftKey = (typeof draftFields)[number]["key"];
type DraftValues = Record<DraftKey, string>;
const numericDraftKeys: readonly DraftKey[] = ["salaryMinMonthly", "salaryMaxMonthly", "payMonths"];
const emptyDraftValues = Object.fromEntries(draftFields.map((field) => [field.key, ""])) as DraftValues;

function EditableDraft({ values, onChange, defaultEditing, onComplete, pending, onEditingChange }: { values: DraftValues; onChange(patch: Partial<DraftValues>): void; defaultEditing: boolean; onComplete(): Promise<unknown>; pending: boolean; onEditingChange(editing: boolean): void }) {
  const [editing, setEditing] = useState(defaultEditing);
  const [original, setOriginal] = useState(values);
  useEffect(() => { onEditingChange(defaultEditing); }, []);
  const beginEditing = () => { setOriginal(values); setEditing(true); onEditingChange(true); };
  const cancelEditing = () => { if (pending) return; onChange(original); setEditing(false); onEditingChange(false); };
  const completeEditing = async () => { try { await onComplete(); setEditing(false); onEditingChange(false); } catch { /* Keep inputs available for correction and retry. */ } };
  const bindField = (field: (typeof draftFields)[number]) => ({
    "aria-label": field.label,
    disabled: pending,
    value: values[field.key],
    onChange: (event: { target: { value: string } }) => onChange({ [field.key]: event.target.value }),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Escape") { event.preventDefault(); cancelEditing(); } },
  });
  if (editing) return <div className="editable-field editing draft-editor"><div className="inline-edit-actions draft-edit-actions"><button type="button" className="text-button" disabled={pending} onClick={cancelEditing}>取消</button><button type="button" className="compact-button" disabled={pending} onClick={() => void completeEditing()}>{pending ? "保存中…" : "保存"}</button></div><div className="grid">{draftFields.map((field) => <label key={field.key}>{field.label}<textarea rows={field.multiline ? 5 : 2} {...bindField(field)} /></label>)}</div></div>;
  return <div className="editable-preview preferences-preview"><button type="button" className="edit-affordance" aria-label="编辑岗位草稿" onClick={beginEditing}><PencilIcon /><span>编辑</span></button><div className="grid">{draftFields.map((field) => { const empty = !values[field.key].trim(); const text = empty ? "-" : values[field.key]; return <div className="form-field" key={field.key}><span className="field-label">{field.label}</span><span className={`${empty ? "preview-value empty" : "preview-value"}${field.multiline ? " multiline" : ""}`} title={!empty && !field.multiline ? text : undefined}>{text}</span></div>; })}</div></div>;
}

export function OpportunityPage() {
  const { opportunityId } = detailRoute.useParams(); const client = useQueryClient(); const detail = useQuery({ queryKey: ["opportunity", opportunityId], queryFn: () => fetchOpportunity(opportunityId) });
  const [edits, setEdits] = useState<DraftValues>(emptyDraftValues); const [hydratedFor, setHydratedFor] = useState<string | null>(null); const [runId, setRunId] = useState<string | null>(null);
  const [draftEditing, setDraftEditing] = useState(false);
  const savedDraft = useRef<NonNullable<typeof detail.data>["draft"] | null>(null);
  useEffect(() => {
    if (!detail.data || (draftEditing && hydratedFor === opportunityId)) return;
    savedDraft.current = detail.data.draft;
    setEdits(Object.fromEntries(draftFields.map((field) => [field.key, detail.data!.draft.fields[field.key].value?.toString() ?? ""])) as DraftValues);
    setHydratedFor(opportunityId);
  }, [detail.data, opportunityId, draftEditing, hydratedFor]);
  const save = useMutation({ mutationFn: async () => {
    const current = savedDraft.current ?? detail.data!.draft;
    const saved = await patchDraft(opportunityId, { expectedVersion: current.version, fields: Object.fromEntries(draftFields.map((field) => [field.key, { value: numericDraftKeys.includes(field.key) ? (edits[field.key] ? Number(edits[field.key]) : null) : edits[field.key], source: "user", revision: current.fields[field.key].revision }])) });
    savedDraft.current = saved;
    client.setQueryData(["opportunity", opportunityId], { ...detail.data!, draft: saved });
    const confirmed = await confirmDraft(opportunityId, saved.version);
    savedDraft.current = confirmed;
    client.setQueryData(["opportunity", opportunityId], { ...detail.data!, draft: confirmed });
    void client.invalidateQueries({ queryKey: ["opportunity", opportunityId] });
  } }); const start = useMutation({ mutationFn: () => startScreening(opportunityId), onSuccess: (receipt) => { setRunId(receipt.resourceId); void client.invalidateQueries({ queryKey: ["opportunity", opportunityId] }); } });
  useRunUpdates(runId, opportunityId);
  if (detail.isPending) return <main className="shell"><p role="status">加载中…</p></main>; if (detail.error || !detail.data) return <main className="shell"><ErrorNotice error={detail.error ?? new Error("岗位不存在")} /></main>;
  const data = detail.data; const selectedRun = data.runs.find((run) => run.id === runId) ?? data.runs[0];
  const activeRun = selectedRun?.successorRunId ? data.runs.find((run) => run.id === selectedRun.successorRunId) ?? selectedRun : selectedRun;
  const draftKey = opportunityId;
  const reportNotes = [...new Set(data.reports.flatMap((report) => report.assumptions))];
  return <main className="shell"><h1>{data.title ?? "岗位详情"}</h1><p className="subtitle">{data.company ?? "公司未知"} · {data.location ?? "地点未知"}</p><section className="draft-section"><h2>岗位草稿</h2><p>状态：{data.draft.status} · 版本 {data.draft.version}</p>{hydratedFor === draftKey ? <EditableDraft key={draftKey} values={edits} onChange={(patch) => setEdits((current) => ({ ...current, ...patch }))} defaultEditing={data.draft.status !== "confirmed"} onComplete={() => save.mutateAsync()} pending={save.isPending} onEditingChange={setDraftEditing} /> : null}{data.draft.assumptions.map((item) => <p className="notice" key={item}>{item}</p>)}{data.draft.conflicts.map((item) => <p className="notice error" key={item.id}>字段 {item.field} 存在冲突：保留了用户值</p>)}{save.error ? <ErrorNotice error={save.error} /> : null}</section><section><h2>匹配初筛</h2><button onClick={() => start.mutate()} disabled={draftEditing || save.isPending || data.draft.status !== "confirmed" || start.isPending}>开始初筛</button>{data.draft.status !== "confirmed" ? <p>确认草稿后才能开始。</p> : null}{activeRun ? <RunControls key={activeRun.id} run={activeRun} onChanged={(nextRunId) => { if (nextRunId) setRunId(nextRunId); void detail.refetch(); }} /> : null}</section><section><h2>分析报告</h2>{reportNotes.length ? <div className="report-notes"><h3>补充说明</h3><blockquote>{reportNotes.map((item) => <p key={item}>{item}</p>)}</blockquote></div> : null}{data.reports.length === 0 ? <p>暂无报告。</p> : data.reports.map((report) => <ReportCard report={report} key={report.id} />)}</section></main>;
}

function useRunUpdates(runId: string | null, opportunityId: string) { const client = useQueryClient(); useEffect(() => { if (!runId) return; const events = new RunEventClient(runId); events.connect(() => { void client.invalidateQueries({ queryKey: ["run", runId] }); void client.invalidateQueries({ queryKey: ["opportunity", opportunityId] }); }, () => undefined); return () => events.disconnect(); }, [client, opportunityId, runId]); }
export function RunControls({ run, onChanged }: { run: Awaited<ReturnType<typeof fetchRun>>; onChanged(nextRunId?: string): void }) {
  const retry = useMutation({ mutationFn: () => retryRun(run.id), onSuccess: (receipt) => onChanged(receipt.resourceId) });
  const cancel = useMutation({ mutationFn: () => cancelRun(run.id), onSuccess: () => onChanged() });
  const query = useQuery({ queryKey: ["run", run.id], queryFn: () => fetchRun(run.id), initialData: run, refetchInterval: (state) => state.state.data && ["queued", "running", "cancelling"].includes(state.state.data.status) ? 800 : false });
  const current = query.data;
  const currentIndex = Math.max(0, screeningStages.findIndex((stage) => stage.id === current.currentStage));
  const completed = current.status === "completed";
  const activeStage = screeningStages[currentIndex]!;
  const stepNumber = completed ? screeningStages.length : currentIndex + 1;
  const progress = completed ? 100 : current.status === "queued" && !current.currentStage ? 0 : Math.round((stepNumber / screeningStages.length) * 100);
  const statusLabel = ({ queued: "等待开始", running: "分析中", waiting: "等待中", needs_attention: "需要处理", cancelling: "正在取消", cancelled: "已取消", completed: "已完成", failed: "执行失败", superseded: "已被新分析替代" } as const)[current.status];
  const title = completed ? "匹配分析已完成" : current.status === "failed" ? `分析在「${activeStage.label}」阶段失败` : current.status === "cancelled" ? "匹配分析已取消" : current.status === "queued" && !current.currentStage ? "正在准备匹配分析" : activeStage.title;
  const description = completed ? "分析报告已经生成，可以在下方查看完整结果。" : current.status === "failed" ? "你可以创建一个新分析，并保留本次失败记录。" : current.status === "cancelled" ? "本次分析没有生成报告，可以重新开始。" : current.status === "queued" && !current.currentStage ? "任务已经进入队列，即将开始检查岗位条件。" : activeStage.description;
  const modelLabel = current.modelConfig?.provider === "deepseek" ? `DeepSeek · ${current.modelConfig.model}` : "本地演示模型";

  return <div className={`card run-progress-card ${current.status}`} aria-live="polite">
    <div className="run-progress-head">
      <div>
        <span className="run-status"><i aria-hidden="true" />{statusLabel}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <span className="run-step-count">第 {stepNumber} / {screeningStages.length} 步</span>
    </div>
    <div className="run-progress-track" role="progressbar" aria-label="初筛进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
      <span style={{ width: `${progress}%` }} />
    </div>
    <ol className="run-stage-list" aria-label="初筛阶段">
      {screeningStages.map((stage, index) => {
        const state = completed || index < currentIndex ? "complete" : index === currentIndex ? current.status === "failed" ? "failed" : "active" : "pending";
        return <li className={state} key={stage.id} aria-current={state === "active" ? "step" : undefined}><span aria-hidden="true">{state === "complete" ? "✓" : index + 1}</span><small>{stage.label}</small></li>;
      })}
    </ol>
    <div className="run-progress-meta"><span>模型：{modelLabel}</span><span>分析编号：{current.id.slice(0, 8)}</span></div>
    {retry.error || cancel.error ? <ErrorNotice error={retry.error ?? cancel.error!} /> : null}
    {["queued", "running"].includes(current.status) ? <div className="run-actions"><button className="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消分析</button></div> : null}
    {current.status === "failed" ? <div className="run-actions"><button disabled={retry.isPending} onClick={() => retry.mutate()}>重新分析</button></div> : null}
  </div>;
}
export function ReportCard({ report }: { report: ScreeningReport }) { return <details className={`report ${report.status}`}><summary className="report-head"><h3>{recommendationLabels[report.recommendation]}</h3><span>{reportStatusLabels[report.status]} · {confidenceLabels[report.confidence]} · {report.modelLabel}</span><i className="report-chevron" aria-hidden="true"><ChevronIcon /></i></summary>{report.matches.length ? <section><h4>匹配点</h4><ul>{report.matches.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}{report.risks.length ? <section><h4>总体风险</h4><ul>{report.risks.map((item) => <li key={item}>{item}</li>)}</ul></section> : null}<div className="dimensions">{DIMENSION_IDS.map((id) => { const item = report.dimensions[id]; return <section className="dimension" key={id}><strong>{labels[id]}</strong><span>{verdictLabels[item.verdict]} / {confidenceLabels[item.confidence]}</span>{item.risks.map((risk) => <small key={risk}>风险：{risk}</small>)}{item.unknowns.map((unknown) => <small key={unknown}>待核验：{unknown}</small>)}{item.claimIds.length ? <small>证据：{item.claimIds.join(", ")}</small> : null}</section>; })}</div>{report.rules.length ? <p>规则命中：{report.rules.join("；")}</p> : null}{report.claims.length ? <details className="claims"><summary>证据</summary>{report.claims.map((claim) => <article className="dimension" key={claim.id}><strong>{claim.statement}</strong><small>{claimStatusLabels[claim.status]} · {confidenceLabels[claim.confidence]}</small><small>简历证据：{claim.resumeEvidence}</small><small>JD 证据：{claim.jobEvidence}</small></article>)}</details> : null}</details>; }
function ErrorNotice({ error }: { error: unknown }) { return <div className="notice error" role="alert">{error instanceof ApiError ? `${error.code}：${error.message}` : error instanceof Error ? error.message : "操作失败"}</div>; }
