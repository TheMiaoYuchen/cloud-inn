import { useRef, type KeyboardEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { projectCompendia } from "../application/contentQueries";
import { useGame } from "../state/GameProvider";

const TABS = [
  { id: "content", label: "内容目录" },
  { id: "design", label: "设计系列" },
  { id: "market", label: "市场洞察" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function ContentPanel({ projection }: { projection: ReturnType<typeof projectCompendia>["content"] }) {
  return <div className="compendium-sections">
    <section><h2>设施目录</h2>{projection.facilities.map((entry) => <article key={entry.id}>
      <h3>{entry.name}</h3><p>{entry.unlocked ? "已解锁" : `尚未解锁：${entry.lockedReasons.join("；")}`}</p>
      <ul>{entry.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>
    </article>)}</section>
    <section><h2>物件目录</h2>{projection.items.map((entry) => <article key={entry.id}><h3>{entry.name}</h3><p>{entry.unlocked ? "可用" : `尚未解锁：${entry.lockedReasons.join("；")}`}</p><p>{entry.effects.join("；")}</p></article>)}</section>
    <section><h2>菜单目录</h2>{projection.menus.map((entry) => <article key={entry.id}><h3>{entry.name}</h3><p>{entry.unlocked ? "可用" : `尚未解锁：${entry.lockedReasons.join("；")}`}</p><p>{entry.effects.join("；")}</p></article>)}</section>
  </div>;
}

function DesignPanel({ projection, floors }: {
  projection: ReturnType<typeof projectCompendia>["design"];
  floors: ReadonlyMap<string, number>;
}) {
  return <div className="compendium-sections">
    <section><h2>酒店设计基因</h2>{projection.hotelGene
      ? <p>{projection.hotelGene.palette} · {projection.hotelGene.materials.join("、")} · {projection.hotelGene.mood}</p>
      : <p>尚未保存酒店设计基因</p>}</section>
    <section><h2>已保存设计</h2>{projection.entries.map((entry) => <article key={entry.id}>
      <h3>{entry.name}</h3><p>{entry.kind === "room-series" ? "客房系列" : entry.kind === "room-variant" ? "客房变体" : entry.kind === "public-space" ? "公共空间蓝图" : "客房与公共空间设计"}</p>
      <div>{entry.usageFloorIds.map((floorId) => <Link key={floorId} to={`/building?floorId=${encodeURIComponent(floorId)}`}>查看{floors.get(floorId) ?? floorId}层</Link>)}</div>
      {(entry.kind === "public-space" || entry.kind === "mixed") && <Link to="/public-spaces/design">打开空间设计</Link>}
    </article>)}</section>
  </div>;
}

function MarketPanel({ projection }: { projection: ReturnType<typeof projectCompendia>["market"] }) {
  return <div className="compendium-sections">{projection.entries.map((entry) => <article key={entry.segmentId}>
    <h2>{entry.name}</h2>
    <p>{entry.discovered ? "已建立市场档案" : "市场档案尚未发现，以下仅显示基础客群信息"}</p>
    <h3>硬性需求</h3><p>{entry.hardNeeds.length ? entry.hardNeeds.join("；") : "暂无已知硬性门槛"}</p>
    <h3>偏好</h3><p>{entry.preferences.join("；")}</p>
    <h3>已发现需求</h3><p>{entry.discoveredNeeds.length ? entry.discoveredNeeds.map(({ kind, strengthBps }) => `${kind} ${strengthBps / 100}%`).join("；") : "尚无经营发现"}</p>
    <h3>设施兴趣</h3><p>{entry.facilityInterests.length ? entry.facilityInterests.map(({ name, appealBps }) => `${name} ${appealBps / 100}%`).join("；") : "尚无已建设施观察"}</p>
    <h3>经营证据</h3><ul>{entry.evidence.length ? entry.evidence.map((evidence, index) => <li key={`${evidence.day}:${evidence.kind}:${index}`}>{evidence.day}日 · {evidence.text}</li>) : <li>尚无日报证据</li>}</ul>
  </article>)}</div>;
}

export function ContentCompendiumPage() {
  const { state, loading } = useGame();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = TABS.some(({ id }) => id === requested) ? requested as TabId : "content";
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  if (loading) return <main className="page"><p role="status">正在加载酒店百科…</p></main>;
  if (!state?.phase4) return <Navigate to="/" replace />;
  const projection = projectCompendia(state);
  const floors = new Map(state.phase4.floors.map(({ id, floorNumber }) => [id, floorNumber]));
  const selectTab = (id: TabId, focus = false) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id === "content") next.delete("tab");
      else next.set("tab", id);
      return next;
    });
    if (focus) tabRefs.current[id]?.focus();
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, currentId: TabId) => {
    const currentIndex = TABS.findIndex(({ id }) => id === currentId);
    const targetIndex = event.key === "ArrowRight" ? (currentIndex + 1) % TABS.length
      : event.key === "ArrowLeft" ? (currentIndex - 1 + TABS.length) % TABS.length
        : event.key === "Home" ? 0
          : event.key === "End" ? TABS.length - 1
            : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    selectTab(TABS[targetIndex].id, true);
  };
  return <main className="page compendium-page">
    <header><p className="eyebrow">CLOUD INN · ARCHIVE</p><h1>酒店百科</h1><p>只读汇总已保存内容、设计使用与经营市场证据。</p></header>
    <div role="tablist" aria-label="酒店百科分类">{TABS.map(({ id, label: tabLabel }) => <button
      key={id} type="button" role="tab" aria-selected={tab === id}
      aria-controls={`compendium-panel-${id}`} id={`compendium-tab-${id}`}
      tabIndex={tab === id ? 0 : -1}
      ref={(element) => { tabRefs.current[id] = element; }}
      onClick={() => selectTab(id)} onKeyDown={(event) => handleTabKey(event, id)}
    >{tabLabel}</button>)}</div>
    {TABS.map(({ id, label }) => <section
      key={id} role="tabpanel" aria-label={label} id={`compendium-panel-${id}`}
      aria-labelledby={`compendium-tab-${id}`} hidden={tab !== id}
    >
      {id === "content" ? <ContentPanel projection={projection.content} />
        : id === "design" ? <DesignPanel projection={projection.design} floors={floors} />
          : <MarketPanel projection={projection.market} />}
    </section>)}
  </main>;
}
