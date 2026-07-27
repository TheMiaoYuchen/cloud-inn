import { useEffect, useMemo, useState } from 'react';
import type { PricingContext, PricePolicy } from '../../domain/operations/pricing';
import { suggestRate } from '../../domain/operations/pricing';
import type { RoomOffer } from '../../domain/operations/roomOffer';
import { money } from './OperationsSummary';

const seasons = { spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季' } as const;
export function PricingPanel({ offer, policies, context, pending, onSave, onAuto }: {
  offer?: RoomOffer; policies: Record<string, unknown>; context: PricingContext; pending: boolean;
  onSave: (policy: PricePolicy) => Promise<boolean>; onAuto: (offerId: string, enabled: boolean) => Promise<boolean>;
}) {
  const policy = offer ? policies[offer.id] as PricePolicy | undefined : undefined;
  const [form, setForm] = useState({ base: policy ? String(policy.baseRateCents / 100) : '', min: policy ? String(policy.minRateCents / 100) : '', max: policy ? String(policy.maxRateCents / 100) : '' });
  useEffect(() => { if (policy) setForm({ base: String(policy.baseRateCents / 100), min: String(policy.minRateCents / 100), max: String(policy.maxRateCents / 100) }); }, [policy?.roomOfferId, policy?.baseRateCents, policy?.minRateCents, policy?.maxRateCents]);
  const suggestion = useMemo(() => policy ? suggestRate(policy, context) : null, [policy, context]);
  if (!offer || !policy) return <section aria-label="房价策略" className="action-card"><h3>房价与改造</h3><p>暂无可经营的客房产品。</p></section>;
  const save = async () => {
    const next = { ...policy, baseRateCents: Math.round(Number(form.base) * 100), minRateCents: Math.round(Number(form.min) * 100), maxRateCents: Math.round(Number(form.max) * 100) };
    await onSave(next);
  };
  return <section aria-label="房价策略" className="action-card pricing-panel">
    <h3>房价策略</h3><div className="context-strip"><span>{seasons[context.season]}</span><span>近 7 日入住率 {context.trailingSevenDayOccupancyBps / 100}%</span><span>当前价 {money(policy.nightlyRateCents)}</span><span>建议价 {money(suggestion?.rateCents ?? policy.nightlyRateCents)}</span></div>
    <p className="muted">{suggestion?.reasons.slice(0, 2).join('；')}</p>
    <div className="form-grid"><label>基础价（元）<input aria-label="基础价（元）" type="number" value={form.base} onChange={e => setForm({ ...form, base: e.target.value })} /></label><label>最低价（元）<input aria-label="最低价（元）" type="number" value={form.min} onChange={e => setForm({ ...form, min: e.target.value })} /></label><label>最高价（元）<input aria-label="最高价（元）" type="number" value={form.max} onChange={e => setForm({ ...form, max: e.target.value })} /></label></div>
    <label className="switch-row"><input aria-label="自动定价" type="checkbox" checked={policy.automaticPricing} disabled={pending} onChange={e => void onAuto(offer.id, e.target.checked)} />自动定价</label><button disabled={pending} onClick={() => void save()}>保存房价策略</button>
  </section>;
}
