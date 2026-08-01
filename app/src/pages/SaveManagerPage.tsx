import { useEffect, useRef, useState, type FormEvent } from "react";
import { boundedCount, reliabilityErrorCode } from "../application/reliabilityUi";
import type { RecoveryPointSummary, ImportInspection } from "../domain/reliability/reliabilityTypes";
import { useReliability } from "../state/ReliabilityProvider";

function dateLabel(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function SaveManagerPage() {
  const { port, saves, activeSaveId, selectSave, registerSave, refreshSaves } = useReliability();
  const active = saves.find((save) => save.saveId === activeSaveId) ?? null;
  const createRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const [recoveries, setRecoveries] = useState<readonly RecoveryPointSummary[]>([]);
  const [inspection, setInspection] = useState<ImportInspection | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!activeSaveId) { setRecoveries([]); return; }
    port.listRecoveryPoints(activeSaveId).then(
      (items) => { if (alive) setRecoveries(items); },
      (error) => { if (alive) setNotice(`恢复点不可用（${reliabilityErrorCode(error)}）`); },
    );
    return () => { alive = false; };
  }, [activeSaveId, port]);

  const run = async (operation: () => Promise<void>) => {
    setPending(true);
    setNotice(null);
    try { await operation(); }
    catch (error) { setNotice(`操作未完成（${reliabilityErrorCode(error)}）`); }
    finally { setPending(false); }
  };

  const createSave = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const save = await port.createSave(createRef.current?.value ?? "");
      if (createRef.current) createRef.current.value = "";
      registerSave(save);
      setNotice("新存档已创建");
    });
  };

  const renameSave = (event: FormEvent) => {
    event.preventDefault();
    if (!active) return;
    void run(async () => {
      const save = await port.renameSave(active.saveId, renameRef.current?.value ?? "", active.metadataRevision);
      registerSave(save);
      setNotice("存档已改名");
    });
  };

  return (
    <main className="page reliability-page">
      <p className="eyebrow">本地存档</p>
      <h1>存档管理</h1>
      <p className="reliability-lead">创建、切换、归档或恢复存档。为避免误操作，这里不提供删除功能。</p>
      {notice && <p className="reliability-notice" role="status">{notice}</p>}
      <div className="save-manager-layout">
        <section className="reliability-card" aria-labelledby="save-list-title">
          <h2 id="save-list-title">我的存档</h2>
          <ul className="save-list">
            {saves.map((save) => (
              <li key={save.saveId}>
                <button
                  className="save-choice"
                  aria-pressed={save.saveId === activeSaveId}
                  onClick={() => selectSave(save.saveId)}
                >
                  <strong>{save.displayName}</strong>
                  <span>第 {save.currentDay} 天 · {save.roomCount} 间客房</span>
                  <small>{save.schemaHealthy ? "存档健康" : "需要诊断"}</small>
                </button>
              </li>
            ))}
          </ul>
          <form className="inline-form" onSubmit={createSave}>
            <label htmlFor="new-save-name">新存档名称</label>
            <input id="new-save-name" ref={createRef} required maxLength={40} />
            <button disabled={pending}>创建</button>
          </form>
        </section>

        <section className="reliability-card" aria-labelledby="save-actions-title">
          <h2 id="save-actions-title">当前存档</h2>
          {!active ? <p className="empty-state">请选择一个存档。</p> : <>
            <dl className="fact-list">
              <div><dt>名称</dt><dd>{active.displayName}</dd></div>
              <div><dt>最近游玩</dt><dd>{dateLabel(active.lastPlayedAtMs)}</dd></div>
              <div><dt>游戏版本</dt><dd>{active.gameRevision}</dd></div>
            </dl>
            <form className="inline-form" onSubmit={renameSave}>
              <label htmlFor="rename-save">新名称</label>
              <input id="rename-save" ref={renameRef} defaultValue={active.displayName} key={active.saveId} required maxLength={40} />
              <button disabled={pending}>改名</button>
            </form>
            <div className="reliability-actions">
              <button disabled={pending} onClick={() => void run(async () => {
                const result = await port.exportSave(active.saveId);
                setNotice(`归档已导出：${result.suggestedFileName}（${boundedCount(result.byteLength, 2_147_483_648)} 字节）`);
              })}>导出 .cloudinn</button>
              <button disabled={pending} onClick={() => void run(async () => setInspection(await port.inspectImport()))}>检查导入文件</button>
            </div>
          </>}

          {inspection && <aside className="import-inspection" aria-label="导入检查结果">
            <h3>可以导入</h3>
            <p>{inspection.displayName} · {boundedCount(inspection.assetCount)} 个资源</p>
            <button disabled={pending} onClick={() => void run(async () => {
              const save = await port.importSave(inspection.token);
              registerSave(save);
              setInspection(null);
              setNotice("归档已作为新存档导入");
            })}>确认导入为新存档</button>
          </aside>}
        </section>

        <section className="reliability-card recovery-card" aria-labelledby="recovery-title">
          <h2 id="recovery-title">恢复点</h2>
          <p className="muted">恢复前会自动保留当前状态；恢复不会覆盖其他存档。</p>
          {recoveries.length === 0 ? <p className="empty-state">当前没有可用恢复点。</p> : <ul className="recovery-list">
            {recoveries.map((point) => <li key={point.recoveryId}>
              <div><strong>{point.kind === "automatic" ? "自动恢复点" : point.kind === "pre-upgrade" ? "升级前" : "恢复前"}</strong><span>{dateLabel(point.createdAtMs)}</span><small>{point.reason}</small></div>
              <button disabled={pending || !active} onClick={() => void run(async () => {
                if (!active) return;
                await port.restoreRecoveryPoint(active.saveId, point.recoveryId);
                await refreshSaves();
                setNotice("恢复完成，存档已重新加载");
              })}>恢复到这里</button>
            </li>)}
          </ul>}
        </section>
      </div>
    </main>
  );
}

