import { useEffect, useMemo, useState } from "react";
import {
  operationGroupFor,
  projectFacilityOfferings,
  projectOperatingChoices,
  type FacilityPolicyInput,
} from "../../domain/facilities/facilityOperations";
import type { FacilityState } from "../../domain/facilities/facilityTypes";
import { FACILITY_CATALOG } from "../../domain/content/contentCatalog";

const suffix = (value: string) => value.split(":").slice(-1)[0] ?? value;
const money = (cents: number) => new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
}).format(cents / 100);

const reasonLabels: Record<string, string> = {
  "facility:capacity-full": "容量已经满载，可提高容量或优化开放时段",
  "facility:service-limited": "服务能力限制了接待量，可提高服务预算",
  "facility:no-demand": "本日没有形成到访需求，可调整定位与价格",
  "facility:no-design-capacity": "空间设计尚未形成有效接待容量",
  "facility:unconfigured": "设施尚未完成运营策略",
  "facility:invalid-policy": "运营策略已失效，请重新配置",
  "facility-reason:capacity": "容量接近上限，可提高容量或优化开放时段",
  "facility-reason:demand": "宾客需求旺盛，可适度提高服务预算",
};
const reasonRank: Record<string, number> = {
  "facility:invalid-policy": 0,
  "facility:unconfigured": 1,
  "facility:no-design-capacity": 2,
  "facility:service-limited": 3,
  "facility:capacity-full": 4,
  "facility:no-demand": 5,
};

type Props = {
  facilities: readonly FacilityState[];
  pending: boolean;
  onConfigure: (facilityId: string, policy: FacilityPolicyInput) => Promise<boolean>;
  onDevelop: (facilityId: string, offeringId: string) => Promise<boolean>;
  onSelectOffering: (facilityId: string, offeringId: string) => Promise<boolean>;
  onSetEnabled: (facilityId: string, enabled: boolean) => Promise<boolean>;
};

function FacilityActionForm({ facility, pending, onConfigure, onDevelop, onSelectOffering, onSetEnabled }: Props & { facility: FacilityState }) {
  const group = operationGroupFor(facility.type);
  const definition = FACILITY_CATALOG.find(({ type }) => type === facility.type)!;
  const choices = group ? projectOperatingChoices(group) : [];
  const initialChoice = choices.find(({ positioningId }) =>
    positioningId === facility.policy?.positioningId) ?? choices[0];
  const [positioningId, setPositioningId] = useState<string>(initialChoice?.positioningId ?? "");
  const compatible = choices.filter((choice) => choice.positioningId === positioningId);
  const [priceBandId, setPriceBandId] = useState<string>(
    compatible.some(({ priceBandId }) => priceBandId === facility.policy?.priceBandId)
      ? facility.policy!.priceBandId
      : compatible[0]?.priceBandId ?? "",
  );
  const [openingPolicyId, setOpeningPolicyId] = useState<string>(
    compatible.some(({ openingPolicyId }) => openingPolicyId === facility.policy?.openingPolicyId)
      ? facility.policy!.openingPolicyId
      : compatible[0]?.openingPolicyId ?? "",
  );
  const [capacity, setCapacity] = useState(facility.policy?.capacity ?? definition.defaultCapacity.minimum);
  const [serviceBudgetYuan, setServiceBudgetYuan] = useState(
    (facility.policy?.serviceBudgetCents ?? facility.dailyOperatingCostCents) / 100,
  );
  const [offeringId, setOfferingId] = useState<string>("");
  const [notice, setNotice] = useState("");
  const offerings = projectFacilityOfferings(facility.type);

  useEffect(() => {
    const nextChoices = group ? projectOperatingChoices(group) : [];
    const nextChoice = nextChoices.find(({ positioningId: id }) =>
      id === facility.policy?.positioningId) ?? choices[0];
    setPositioningId(nextChoice?.positioningId ?? "");
    setPriceBandId(facility.policy?.priceBandId ?? nextChoice?.priceBandId ?? "");
    setOpeningPolicyId(facility.policy?.openingPolicyId ?? nextChoice?.openingPolicyId ?? "");
    setCapacity(facility.policy?.capacity ?? definition.defaultCapacity.minimum);
    setServiceBudgetYuan((facility.policy?.serviceBudgetCents ?? facility.dailyOperatingCostCents) / 100);
    setOfferingId("");
  }, [facility.id, facility.policy, facility.dailyOperatingCostCents, facility.developedOfferingIds, group, definition.defaultCapacity.minimum]);

  if (!group) return <div className="facility-boost-action">
    <p>增益设施无需设置价格策略，其空间品质直接支持品牌吸引力与服务体验。</p>
    <button type="button" disabled={pending} onClick={() => void onSetEnabled(facility.id, !facility.enabled)}>
      {facility.enabled ? "暂停设施" : "启用设施"}
    </button>
  </div>;

  const selectPositioning = (next: string) => {
    setPositioningId(next);
    const nextChoice = choices.find(({ positioningId: id }) => id === next);
    setPriceBandId(nextChoice?.priceBandId ?? "");
    setOpeningPolicyId(nextChoice?.openingPolicyId ?? "");
    setNotice("");
  };
  const save = async () => {
    setNotice("");
    const saved = await onConfigure(facility.id, {
      positioningId,
      priceBandId,
      openingPolicyId,
      capacity,
      serviceBudgetCents: Math.round(serviceBudgetYuan * 100),
      ...(facility.policy?.signatureOfferingId
        ? { signatureOfferingId: facility.policy.signatureOfferingId }
        : {}),
    });
    if (saved) setNotice("已保存");
  };
  const develop = async () => {
    if (!offeringId) return;
    setNotice("");
    if (await onDevelop(facility.id, offeringId)) setNotice("招牌产品已开发");
  };
  const selectOffering = async () => {
    if (!offeringId) return;
    setNotice("");
    if (await onSelectOffering(facility.id, offeringId)) setNotice("招牌产品已选用");
  };

  return <div className="facility-form form-grid">
    <label>设施定位<select aria-label="设施定位" value={positioningId} disabled={pending} onChange={(event) => selectPositioning(event.target.value)}>
      {choices.map((choice) => <option key={choice.id} value={choice.positioningId}>{suffix(choice.positioningId)}</option>)}
    </select></label>
    <label>价格定位<select aria-label="价格定位" value={suffix(priceBandId)} disabled={pending} onChange={(event) => setPriceBandId(`price-band:${event.target.value}`)}>
      {[...new Set(compatible.map(({ priceBandId: id }) => suffix(id)))].map((id) => <option key={id} value={id}>{id}</option>)}
    </select></label>
    <label>接待容量<input aria-label="接待容量" type="number" min={definition.defaultCapacity.minimum} max={definition.defaultCapacity.maximum} value={capacity} disabled={pending} onChange={(event) => setCapacity(Number(event.target.value))} /></label>
    <label>开放时段<select aria-label="开放时段" value={openingPolicyId} disabled={pending} onChange={(event) => setOpeningPolicyId(event.target.value)}>
      {compatible.map((choice) => <option key={choice.id} value={choice.openingPolicyId}>{suffix(choice.openingPolicyId)}</option>)}
    </select></label>
    <label>每日服务预算（元）<input aria-label="每日服务预算（元）" type="number" min="0" value={serviceBudgetYuan} disabled={pending} onChange={(event) => setServiceBudgetYuan(Number(event.target.value))} /></label>
    {offerings.length > 0 && <label>招牌产品<select aria-label="招牌产品" value={offeringId} disabled={pending} onChange={(event) => { setOfferingId(event.target.value); setNotice(""); }}>
      <option value="">选择待预览产品</option>
      {offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.name}{facility.developedOfferingIds.includes(offering.id) ? " · 已开发" : " · 待开发"}</option>)}
    </select></label>}
    <div className="facility-form-actions">
      <button type="button" disabled={pending} onClick={() => void save()}>保存设施策略</button>
      <button type="button" disabled={pending} onClick={() => void onSetEnabled(facility.id, !facility.enabled)}>{facility.enabled ? "暂停营业" : "启用营业"}</button>
      {offeringId && !facility.developedOfferingIds.some((id) => id === offeringId) && <button type="button" disabled={pending} onClick={() => void develop()}>开发招牌产品</button>}
      {offeringId && facility.developedOfferingIds.some((id) => id === offeringId) && <button type="button" disabled={pending || !facility.policy} onClick={() => void selectOffering()}>选用招牌产品</button>}
    </div>
    {notice && <p className="success-note" role="status">{notice}</p>}
  </div>;
}

export function FacilityOperationsPanel(props: Props) {
  const facilities = useMemo(() => [...props.facilities].sort((left, right) => left.id.localeCompare(right.id)), [props.facilities]);
  const [selectedId, setSelectedId] = useState<string>(facilities[0]?.id ?? "");
  const facility = facilities.find(({ id }) => id === selectedId) ?? facilities[0];
  if (!facility) return <section className="facility-operations" role="region" aria-label="设施经营"><h2>设施经营</h2><p>尚无可经营设施</p></section>;
  const latest = facility.dailyResults[facility.dailyResults.length - 1];
  const totals = facility.dailyResults.reduce((sum, result) => ({
    revenueCents: sum.revenueCents + result.revenueCents,
    operatingCostCents: sum.operatingCostCents + result.operatingCostCents,
  }), { revenueCents: 0, operatingCostCents: 0 });
  const definition = FACILITY_CATALOG.find(({ type }) => type === facility.type);
  const reasons = [...(latest?.reasonCodes ?? [])].sort((left, right) =>
    (reasonRank[left] ?? 99) - (reasonRank[right] ?? 99) || left.localeCompare(right));

  return <section className="facility-operations operations-section" role="region" aria-label="设施经营">
    <div className="section-heading"><span>F</span><div><h2>设施经营</h2><p>逐项查看结果、原因与可执行策略</p></div></div>
    <label className="facility-picker">经营设施<select aria-label="经营设施" value={facility.id} onChange={(event) => setSelectedId(event.target.value)}>
      {facilities.map((entry) => <option key={entry.id} value={entry.id}>{FACILITY_CATALOG.find(({ type }) => type === entry.type)?.name ?? entry.type}</option>)}
    </select></label>
    <div className="facility-journey">
      <section className="action-card"><h3>经营结果</h3>{latest ? <div className="facility-metrics">
        <p>昨日收入 <strong>¥{money(latest.revenueCents)}</strong></p>
        <p>昨日成本 <strong>¥{money(latest.operatingCostCents)}</strong></p>
        <p>月累计收入 <strong>¥{money(totals.revenueCents)}</strong></p>
        <p>月累计成本 <strong>¥{money(totals.operatingCostCents)}</strong></p>
        <p>容量利用 <strong>{latest.utilizationBps / 100}%</strong></p>
        <p>宾客影响 <strong>{latest.satisfactionDeltaBps >= 0 ? "+" : ""}{latest.satisfactionDeltaBps / 100}% 满意度</strong></p>
      </div> : <p>尚无设施经营结果</p>}</section>
      <section className="action-card"><h3>原因诊断</h3>{reasons.length ? <ol>{reasons.map((code) => <li key={code}>{reasonLabels[code] ?? code}</li>)}</ol> : <p>{latest ? "本日没有显著瓶颈" : "营业后将在这里解释容量、需求与服务瓶颈"}</p>}</section>
      <section className="action-card"><h3>经营行动</h3><p className="muted">{definition?.name} · {facility.enabled ? "营业中" : "未营业"}</p>
        <FacilityActionForm key={facility.id} {...props} facility={facility} />
      </section>
    </div>
  </section>;
}
