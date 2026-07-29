import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { FloorWorkspace } from "../components/building/FloorWorkspace";
import { TowerOverview } from "../components/building/TowerOverview";
import "../components/building/building.css";
import { useGame } from "../state/GameProvider";
import type { StableId } from "../domain/building/buildingTypes";
import type { PublicSpaceBlueprint } from "../domain/facilities/facilityTypes";

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

const EXPANSION_REASON_LABELS: Record<string, string> = {
  "phase4-required": "酒店尚未进入塔楼阶段",
  "already-purchased": "该楼层已经纳入酒店",
  "not-offered": "该楼层当前未开放扩建",
  "capacity-limit": "继续扩建会超过客房容量上限",
  "no-guest-template": "请先准备一个客房标准楼层",
};

export function BuildingOverviewPage() {
  const { state, building, loading, commandPending, error, commands } = useGame();
  const saveId = state?.saveId;
  const [selectedFloorEvidence, setSelectedFloorEvidence] = useState<{ saveId: string; floorId: string }>();
  const [expansionEvidence, setExpansionEvidence] = useState<{ saveId: string; floorNumber: number }>();
  const [purchaseNotice, setPurchaseNotice] = useState<{ saveId: string; message: string }>();
  const [railCollapsed, setRailCollapsed] = useState(false);
  const purchaseInFlightRef = useRef<{ saveId: string; floorNumber: number } | null>(null);
  const currentSaveIdRef = useRef(saveId);
  currentSaveIdRef.current = saveId;

  const selectedFloorId = selectedFloorEvidence && selectedFloorEvidence.saveId === saveId
    ? selectedFloorEvidence.floorId
    : undefined;
  const previewFloorNumber = expansionEvidence && expansionEvidence.saveId === saveId
    ? expansionEvidence.floorNumber
    : undefined;

  useEffect(() => {
    if (!saveId || !building?.floors.length) {
      setSelectedFloorEvidence(undefined);
      return;
    }
    if (!selectedFloorId || !building.floorById.has(selectedFloorId)) {
      setSelectedFloorEvidence({ saveId, floorId: building.floors[0].floor.id });
    }
  }, [building, saveId, selectedFloorId]);

  useEffect(() => {
    setExpansionEvidence(undefined);
    setPurchaseNotice(undefined);
    setRailCollapsed(false);
    purchaseInFlightRef.current = null;
  }, [saveId]);

  const selectedFloor = selectedFloorId
    ? building?.floorById.get(selectedFloorId)
    : undefined;
  const expansionPreview = previewFloorNumber === undefined
    ? undefined
    : building?.expansionOfferByFloorNumber.get(previewFloorNumber);
  const publicSpaceBlueprints = useMemo(() => {
    const result = new Map<string, {
      blueprint: PublicSpaceBlueprint;
      localPlacementId: StableId;
    }>();
    if (!state?.phase4) return result;
    for (const instance of Object.values(state.phase4.publicSpaces)) {
      const blueprint = state.phase4.spaceBlueprints[instance.blueprintId];
      if (blueprint) result.set(instance.id, {
        blueprint,
        localPlacementId: instance.localPlacementId,
      });
    }
    return result;
  }, [state]);

  if (loading) return <main className="page building-page"><p role="status">正在加载塔楼…</p></main>;
  if (!state?.phase4 || !building) return <Navigate to="/" replace />;

  const purchaseFloor = async () => {
    if (!saveId || expansionEvidence?.saveId !== saveId || !expansionPreview || commandPending) return;
    if (purchaseInFlightRef.current) return;
    const purchaseIdentity = { saveId, floorNumber: expansionPreview.floorNumber };
    purchaseInFlightRef.current = purchaseIdentity;
    setPurchaseNotice(undefined);
    try {
      const purchased = await commands.purchaseFloor(
        expansionPreview.floorNumber,
        "dense-ring",
      );
      if (purchased && currentSaveIdRef.current === purchaseIdentity.saveId) {
        setPurchaseNotice({
          saveId: purchaseIdentity.saveId,
          message: `${purchaseIdentity.floorNumber}层已纳入酒店`,
        });
        setExpansionEvidence(undefined);
      }
    } finally {
      if (currentSaveIdRef.current === purchaseIdentity.saveId &&
        purchaseInFlightRef.current?.saveId === purchaseIdentity.saveId
        && purchaseInFlightRef.current.floorNumber === purchaseIdentity.floorNumber
      ) purchaseInFlightRef.current = null;
    }
  };
  const roomCount = building.floors.reduce(
    (total, projection) => total + projection.rooms.length,
    0,
  );
  const facilityCount = building.floors.reduce(
    (total, projection) => total + projection.facilities.length,
    0,
  );
  const insufficientCash = expansionPreview
    ? Math.max(0, expansionPreview.costCents - state.cashCents)
    : 0;

  return (
    <main className="page building-page">
      <header className="building-header">
        <div>
          <p className="eyebrow">云岫酒店 · 垂直旗舰</p>
          <h1>云端塔楼总览</h1>
          <p>从塔顶向下查看每一层，只加载当前选择的真实比例平面。</p>
        </div>
        <div className="building-summary" aria-label="酒店规模摘要">
          <span><small>已购楼层</small><strong>{building.floors.length} 层</strong></span>
          <span><small>真实客房</small><strong>{roomCount} 间</strong></span>
          <span><small>酒店设施</small><strong>{facilityCount} 项</strong></span>
          <span><small>可用现金</small><strong>¥{formatMoney(state.cashCents)}</strong></span>
        </div>
      </header>

      {building.floors.length === 0 ? (
        <div className="building-empty">
          <h2>酒店还没有可查看的楼层</h2>
          <p>楼层纳入酒店后会按实际高度显示在这里。</p>
        </div>
      ) : (
        <div className={`building-layout${railCollapsed ? " rail-collapsed" : ""}`}>
          <TowerOverview
            floors={building.floors}
            selectedFloorId={selectedFloorId}
            onSelectFloor={(floorId) => {
              if (saveId) setSelectedFloorEvidence({ saveId, floorId });
            }}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((value) => !value)}
          />
          {selectedFloor && (
            <FloorWorkspace
              key={selectedFloor.floor.id}
              projection={selectedFloor}
              publicSpaceBlueprints={publicSpaceBlueprints}
            />
          )}
        </div>
      )}

      {building.expansionOffers.length > 0 && (
        <section className="expansion-panel" aria-labelledby="expansion-title">
          <h2 id="expansion-title">塔楼扩建</h2>
          <p>先查看权威成本与条件，确认后再一次性写入存档。</p>
          <div className="expansion-actions">
            {building.expansionOffers.map((offer) => (
              <button
                key={offer.floorNumber}
                type="button"
                disabled={commandPending}
                onClick={() => {
                  setPurchaseNotice(undefined);
                  if (saveId) setExpansionEvidence({ saveId, floorNumber: offer.floorNumber });
                }}
              >
                查看{offer.floorNumber}层扩建
              </button>
            ))}
          </div>
          {expansionPreview && (
            <div
              className="expansion-preview"
              role="region"
              aria-label={`${expansionPreview.floorNumber}层扩建预览`}
            >
              <h3>{expansionPreview.floorNumber}层客房楼层</h3>
              <p>扩建成本 ¥{formatMoney(expansionPreview.costCents)}</p>
              {!expansionPreview.available && (
                <p>{EXPANSION_REASON_LABELS[expansionPreview.reason] ?? "该楼层当前不可扩建"}</p>
              )}
              {insufficientCash > 0 && <p>现金不足，还差 ¥{formatMoney(insufficientCash)}</p>}
              <button
                type="button"
                disabled={!expansionPreview.available || insufficientCash > 0 || commandPending}
                onClick={() => void purchaseFloor()}
              >
                {commandPending ? "正在购买…" : `确认购买${expansionPreview.floorNumber}层`}
              </button>
            </div>
          )}
        </section>
      )}
      {purchaseNotice && purchaseNotice.saveId === saveId && <p className="success-note" role="status">{purchaseNotice.message}</p>}
      {error && <p className="command-error" role="alert">{error}</p>}
    </main>
  );
}
