import { useState } from 'react';
import { GUEST_SEGMENTS } from '../../domain/operations/segmentCatalog';
import type { RoomOffer } from '../../domain/operations/roomOffer';
import type { RoomOfferUpgradeRequest, RoomRenovationPreview } from '../../domain/operations/renovation';
import type { UpgradeKind } from '../../domain/operations/operationsTypes';
import { money } from './OperationsSummary';

const upgrades: Array<[UpgradeKind, string]> = [['workspace', '办公空间'], ['view', '景观体验'], ['familyCapacity', '家庭容量'], ['privacy', '私密性']];

export function RenovationPanel({ offer, pending, onPreview, onRenovate }: {
  offer?: RoomOffer;
  pending: boolean;
  onPreview: (request: RoomOfferUpgradeRequest) => RoomRenovationPreview;
  onRenovate: (request: RoomOfferUpgradeRequest) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<UpgradeKind>('workspace');
  const [preview, setPreview] = useState<RoomRenovationPreview | null>(null);
  const [localError, setLocalError] = useState('');
  const [notice, setNotice] = useState('');
  if (!offer) return <section role="region" aria-label="客房改造" className="action-card"><h3>客房改造</h3><p>暂无可改造的客房产品。</p></section>;
  const request = (): RoomOfferUpgradeRequest => ({ roomOfferId: offer.id, kind, level: 1 });
  const showPreview = () => {
    try { setLocalError(''); setNotice(''); setPreview(onPreview(request())); }
    catch (error) { setPreview(null); setLocalError(error instanceof Error ? error.message : '无法预览改造'); }
  };
  return <section role="region" aria-label="客房改造" className="action-card renovation-panel"><h3>客房改造</h3><p className="offer-label">{offer.id}</p><label>改造项目<select aria-label="改造项目" value={kind} onChange={event => { setKind(event.target.value as UpgradeKind); setPreview(null); }}><option value="workspace">办公空间</option>{upgrades.slice(1).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><button disabled={pending} onClick={showPreview}>预览改造</button>
    {preview && <div className="renovation-preview"><p><strong>{money(preview.costCents)}</strong> · 停业 {preview.closureDays} 天</p><p>改造前：办公 {preview.beforeOffer.workspaceBps / 100}% · 景观 {preview.beforeOffer.viewBps / 100}% · 私密性 {preview.beforeOffer.privacyBps / 100}% · 容量 {preview.beforeOffer.capacity} 人</p><p>改造后：办公 {preview.afterOffer.workspaceBps / 100}% · 景观 {preview.afterOffer.viewBps / 100}% · 私密性 {preview.afterOffer.privacyBps / 100}% · 容量 {preview.afterOffer.capacity} 人</p><h4>客群匹配变化</h4><ul>{preview.segments.filter(item => item.scoreDeltaBps !== 0).map(item => <li key={item.segmentId}>{GUEST_SEGMENTS.find(segment => segment.id === item.segmentId)?.displayName}：{item.scoreDeltaBps === null ? '解除硬性限制' : `${item.scoreDeltaBps >= 0 ? '+' : ''}${item.scoreDeltaBps / 100}%`} {item.topReasonChanges.join('、')}</li>)}</ul><button disabled={pending} onClick={async () => { if (await onRenovate(request())) { setPreview(null); setNotice('改造已安排，施工期间该产品暂停销售'); } }}>确认改造</button></div>}
    {notice && <p className="success-note" role="status">{notice}</p>}{localError && <p role="alert">{localError}</p>}
  </section>;
}
