import { useEffect, useState, type FormEvent } from "react";
import { boundedCount, jobStatusLabel, reliabilityErrorCode } from "../application/reliabilityUi";
import type { ProviderHealth, ProviderPreferencesProjection, VisualJobProjection } from "../domain/reliability/reliabilityTypes";
import { useReliability } from "../state/ReliabilityProvider";

export function DiagnosticsPage() {
  const { port, saves, activeSaveId } = useReliability();
  const active = saves.find((save) => save.saveId === activeSaveId) ?? null;
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [preferences, setPreferences] = useState<ProviderPreferencesProjection | null>(null);
  const [jobs, setJobs] = useState<readonly VisualJobProjection[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = async () => {
    const [nextHealth, nextPreferences, nextJobs] = await Promise.all([
      port.checkProvider(),
      port.getProviderPreferences(),
      activeSaveId ? port.listVisualJobs(activeSaveId) : Promise.resolve([]),
    ]);
    setHealth(nextHealth);
    setPreferences(nextPreferences);
    setJobs(nextJobs.slice(-20).reverse());
    setErrorCode(null);
  };

  useEffect(() => { void load().catch((error) => setErrorCode(reliabilityErrorCode(error))); }, [activeSaveId, port]);

  const updatePreferences = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preferences) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    port.updateProviderPreferences(preferences.preferencesRevision, {
      dailyRequestCeiling: Number(form.get("dailyRequestCeiling")),
      requireSendConfirmation: form.get("requireSendConfirmation") === "on",
      allowAutomatic1kFallback: form.get("allowAutomatic1kFallback") === "on",
    }).then(setPreferences, (error) => setErrorCode(reliabilityErrorCode(error))).finally(() => setPending(false));
  };

  return (
    <main className="page reliability-page diagnostics-page">
      <p className="eyebrow">安全诊断</p>
      <h1>诊断与 AI 设置</h1>
      <p className="reliability-lead">这里只显示有限的健康状态、计数和稳定状态码；不会显示令牌、文件路径、提示词、图片内容或内部错误详情。</p>
      {errorCode && <p className="reliability-error" role="alert">诊断未完成：<code>{errorCode}</code></p>}
      <div className="diagnostics-grid">
        <section className="reliability-card" aria-labelledby="save-health-title">
          <h2 id="save-health-title">存档健康</h2>
          <dl className="fact-list">
            <div><dt>当前存档</dt><dd>{active ? "已选择" : "未选择"}</dd></div>
            <div><dt>结构检查</dt><dd>{active?.schemaHealthy ? "通过" : "不可用"}</dd></div>
            <div><dt>恢复能力</dt><dd>{active?.recoveryAvailable ? "可用" : "尚无恢复点"}</dd></div>
            <div><dt>存档数量</dt><dd>{boundedCount(saves.length, 100)}</dd></div>
          </dl>
        </section>
        <section className="reliability-card" aria-labelledby="provider-health-title">
          <div className="reliability-section-title"><h2 id="provider-health-title">AI 服务</h2><button disabled={pending} onClick={() => void load().catch((error) => setErrorCode(reliabilityErrorCode(error)))}>重新检查</button></div>
          <dl className="fact-list">
            <div><dt>凭据</dt><dd>{health?.credential.state ?? "unknown"}</dd></div>
            <div><dt>网络</dt><dd>{health?.reachability ?? "unknown"}</dd></div>
            <div><dt>主模型</dt><dd>{health?.primaryModelAvailable === true ? "可用" : health?.primaryModelAvailable === false ? "不可用" : "未知"}</dd></div>
            <div><dt>兼容模型</dt><dd>{health?.fallbackModelAvailable === true ? "可用" : health?.fallbackModelAvailable === false ? "不可用" : "未知"}</dd></div>
            {health?.errorCode && <div><dt>状态码</dt><dd><code>{health.errorCode}</code></dd></div>}
          </dl>
        </section>
        {preferences && <section className="reliability-card" aria-labelledby="provider-settings-title">
          <h2 id="provider-settings-title">请求保护</h2>
          <p className="muted">额度对所有存档共用，尝试次数不会因取消而退回。</p>
          <form className="preferences-form" onSubmit={updatePreferences}>
            <label>每日请求上限<input name="dailyRequestCeiling" type="number" min={0} max={100} defaultValue={preferences.dailyRequestCeiling} /></label>
            <label><input name="requireSendConfirmation" type="checkbox" defaultChecked={preferences.requireSendConfirmation} /> 每次发送前确认</label>
            <label><input name="allowAutomatic1kFallback" type="checkbox" defaultChecked={preferences.allowAutomatic1kFallback} /> 允许自动使用兼容 1K</label>
            <p>今日已用 {boundedCount(preferences.usedAttempts, 100)} / {preferences.dailyRequestCeiling}</p>
            <button disabled={pending}>保存设置</button>
          </form>
        </section>}
      </div>
      <section className="reliability-card bounded-diagnostics" aria-labelledby="recent-jobs-title">
        <h2 id="recent-jobs-title">最近任务（最多 20 条）</h2>
        {jobs.length === 0 ? <p className="empty-state">没有任务状态。</p> : <ol>
          {jobs.map((job) => <li key={job.jobId}><span>{jobStatusLabel(job.status)}</span><code>{job.errorCode ?? "ok"}</code></li>)}
        </ol>}
      </section>
    </main>
  );
}
