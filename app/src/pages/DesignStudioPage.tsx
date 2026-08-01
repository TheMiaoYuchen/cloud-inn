import { useEffect, useRef, useState, type FormEvent } from "react";
import { jobStatusLabel, reliabilityErrorCode } from "../application/reliabilityUi";
import type { AssetMetadata, VisualJobProjection } from "../domain/reliability/reliabilityTypes";
import { useGame } from "../state/GameProvider";
import { useReliability } from "../state/ReliabilityProvider";

const FINAL_STATUSES = new Set(["adopted", "superseded", "failed-terminal", "cancelled"]);

async function visualTargetFingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function JobAsset({ asset }: { asset: AssetMetadata | null }) {
  const [missing, setMissing] = useState(false);
  if (!asset || missing) return <div className="missing-asset" role="img" aria-label="效果图文件缺失"><strong>效果图不可用</strong><span>文件缺失或校验失败。请前往存档管理选择恢复点。</span></div>;
  return <img className="job-asset" src={asset.resolverUrl} alt="生成的酒店设计效果图" onError={() => setMissing(true)} />;
}

export function DesignStudioPage() {
  const { port, activeSaveId } = useReliability();
  const { state } = useGame();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [jobs, setJobs] = useState<readonly VisualJobProjection[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = async () => {
    if (!activeSaveId) return;
    setJobs(await port.listVisualJobs(activeSaveId));
  };

  useEffect(() => {
    let alive = true;
    if (!activeSaveId) return;
    port.listVisualJobs(activeSaveId).then(
      (next) => { if (alive) setJobs(next); },
      (error) => { if (alive) setNotice(`任务不可用（${reliabilityErrorCode(error)}）`); },
    );
    return () => { alive = false; };
  }, [activeSaveId, port]);

  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setNotice(null);
    try { await operation(); await reload(); }
    catch (error) { setNotice(`操作未完成（${reliabilityErrorCode(error)}）`); }
    finally { setPending(false); }
  };

  const enqueue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || !activeSaveId) return;
    const form = new FormData(event.currentTarget);
    const targetKind = form.get("targetKind") === "focus" ? "focus" : "master";
    const resolution = form.get("resolution") === "1k" ? "1k" : form.get("resolution") === "4k" ? "4k" : "2k";
    void run(async () => {
      const targetFingerprint = await visualTargetFingerprint({
        saveId: state.saveId,
        revision: state.revision,
        targetKind,
        roomBlueprint: state.roomBlueprint,
        phase4: state.phase4,
      });
      await port.enqueueVisualJob({
        saveId: activeSaveId,
        expectedRevision: state.revision,
        targetFingerprint,
        request: { targetKind, prompt: promptRef.current?.value ?? "", resolution, referenceAssetIds: [] },
      });
      if (promptRef.current) promptRef.current.value = "";
      setNotice("效果图任务已加入持久队列");
    });
  };

  return (
    <main className="page reliability-page design-studio-page">
      <p className="eyebrow">视觉工作室</p>
      <h1>设计效果图</h1>
      <p className="economic-safety">效果图只改变视觉资产，不会修改蓝图、价格、房间指标或任何经济数据。取消任务也不会影响经营进度。</p>
      {notice && <p className="reliability-notice" role="status">{notice}</p>}
      <form className="reliability-card generation-form" onSubmit={enqueue}>
        <label htmlFor="visual-prompt">描述想要的氛围与材质</label>
        <textarea id="visual-prompt" name="prompt" ref={promptRef} required maxLength={12_000} rows={4} />
        <div className="generation-options">
          <label>画面类型<select name="targetKind"><option value="master">主效果图</option><option value="focus">局部细节</option></select></label>
          <label>分辨率<select name="resolution" defaultValue="2k"><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option></select></label>
          <button disabled={pending || !state}>加入生成队列</button>
        </div>
      </form>

      <section aria-labelledby="visual-jobs-title">
        <div className="reliability-section-title"><h2 id="visual-jobs-title">生成任务</h2><button disabled={pending} onClick={() => void run(reload)}>刷新</button></div>
        {jobs.length === 0 ? <p className="empty-state">还没有效果图任务。</p> : <ul className="visual-job-grid">
          {jobs.map((job) => <li className="reliability-card visual-job-card" key={job.jobId}>
            <div className="job-heading"><strong>{job.targetKind === "master" ? "主效果图" : "局部细节"}</strong><span className={`job-status status-${job.status}`}>{jobStatusLabel(job.status)}</span></div>
            {(job.status === "ready-for-review" || job.status === "adopted") && <JobAsset asset={job.asset} />}
            <dl className="fact-list compact">
              <div><dt>生成线路</dt><dd>{job.selectedModel ? (job.status.includes("fallback") ? "兼容模型" : "已选择模型") : "尚未选择"}</dd></div>
              <div><dt>已用尝试</dt><dd>{job.attemptCount} / 3</dd></div>
              {job.errorCode && <div><dt>状态码</dt><dd><code>{job.errorCode}</code></dd></div>}
            </dl>
            <div className="reliability-actions">
              {job.status === "needs-player-confirmation" && <button disabled={pending} onClick={() => void run(() => port.confirmVisualSend({ saveId: job.saveId, jobId: job.jobId, expectedJobRevision: job.jobRevision }))}>确认发送请求</button>}
              {(job.status === "failed-retryable" || job.status === "waiting-network" || job.status === "needs-retry-confirmation") && <button disabled={pending} onClick={() => void run(() => port.retryVisualJob({ saveId: job.saveId, jobId: job.jobId, expectedJobRevision: job.jobRevision }))}>重试</button>}
              {job.status === "failed-retryable" && <button disabled={pending} onClick={() => void run(() => port.chooseVisualFallback({ saveId: job.saveId, jobId: job.jobId, expectedJobRevision: job.jobRevision, choice: "compatible-1k" }))}>改用兼容 1K</button>}
              {job.status === "ready-for-review" && state && <button disabled={pending} onClick={() => void run(() => port.confirmVisualAdoption({ saveId: job.saveId, jobId: job.jobId, expectedJobRevision: job.jobRevision, expectedRevision: state.revision, targetFingerprint: job.targetFingerprint }))}>采用效果图</button>}
              {!FINAL_STATUSES.has(job.status) && job.status !== "ready-for-review" && <button className="secondary-button" disabled={pending} onClick={() => void run(() => port.cancelVisualJob({ saveId: job.saveId, jobId: job.jobId, expectedJobRevision: job.jobRevision }))}>取消任务</button>}
            </div>
          </li>)}
        </ul>}
      </section>
    </main>
  );
}
