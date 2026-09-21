import { useState } from "react";
import type { Blueprint, LegendGiftResponse } from "./types";

const GIFT_CHANCE = 0.05;

type LegendGiftsProps = {
  blueprints: Blueprint[];
  onOpenBlueprint: (blueprint: Blueprint) => void;
  onAward: (gift: LegendGiftResponse) => Promise<Blueprint>;
};

export function LegendGifts({ blueprints, onOpenBlueprint, onAward }: LegendGiftsProps) {
  const [state, setState] = useState<"idle" | "quiet" | "writing" | "drawing" | "error">("idle");
  const [message, setMessage] = useState("");
  const [newGift, setNewGift] = useState<Blueprint>();
  const [pendingGift, setPendingGift] = useState<LegendGiftResponse>();
  const gifts = blueprints.filter((blueprint) => blueprint.isLimited && blueprint.legendGift);

  async function drawGift(gift: LegendGiftResponse) {
    setState("drawing");
    try {
      const blueprint = await onAward(gift);
      setNewGift(blueprint); setPendingGift(undefined); setState("idle"); setMessage("一份只能建造一处的限定蓝图，已收入蓝图库。");
    } catch (error) { setState("error"); setMessage(error instanceof Error ? `${error.message} 可重新绘制这份赠礼。` : "赠礼绘制失败，可重新尝试。 "); }
  }

  async function welcomeGuest() {
    setMessage(""); setNewGift(undefined);
    if (Math.random() >= GIFT_CHANCE) { setState("quiet"); setMessage("这一位客人静静离开，没有留下赠礼。下一位来客或许会带来故事。"); return; }
    setState("writing");
    try {
      const response = await fetch("/api/legend-gift", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprintCount: blueprints.length }) });
      const body = await response.json() as LegendGiftResponse | { error?: { message?: string } };
      if (!response.ok || !("gift" in body)) throw new Error("error" in body ? body.error?.message : "传说客人没有留下可读的信笺。");
      setPendingGift(body); await drawGift(body);
    } catch (error) {
      setState("error"); setMessage(error instanceof Error ? error.message : "云端赠礼暂时无法抵达。");
    }
  }

  return <section className="legend-workspace" aria-label="云端赠礼">
    <header className="legend-heading"><div><p className="eyebrow">稀有来访 · 5% 相遇概率</p><h2>云端赠礼</h2><p>少数客人会把一段旅程凝结成限定空间。每张赠礼蓝图只能在整座酒店部署一次。</p></div><button type="button" className="legend-arrival" disabled={state === "writing" || state === "drawing"} onClick={() => void (pendingGift && state === "error" ? drawGift(pendingGift) : welcomeGuest())}>{state === "writing" ? "客人正在写信…" : state === "drawing" ? "正在绘制赠礼…" : pendingGift && state === "error" ? "重新绘制这份赠礼" : "迎接下一位来客"}</button></header>
    <div className={`legend-message ${state}`} role="status"><span>{state === "quiet" ? "○" : state === "writing" || state === "drawing" ? "✦" : "◇"}</span><p>{message || "赠礼只在极少数来访中出现。它不带来任务压力，只为你的酒店留下独一无二的故事。"}</p></div>
    {newGift?.legendGift && <article className="legend-reveal"><img src={newGift.imageDataUrl} alt={`${newGift.name} 限定蓝图`} /><div><p className="eyebrow">限定赠礼 · 已入藏</p><h3>{newGift.name}</h3><span>{newGift.legendGift.guestName} · {newGift.legendGift.guestTitle}</span><p>{newGift.legendGift.stayStory}</p><blockquote>{newGift.legendGift.note}</blockquote><button type="button" onClick={() => onOpenBlueprint(newGift)}>查看限定蓝图</button></div></article>}
    <section className="legend-collection"><div><p className="eyebrow">酒店藏品</p><h3>已获得 {gifts.length} 份赠礼</h3></div>{gifts.length ? <div className="legend-grid">{gifts.map((gift) => <button type="button" key={gift.id} onClick={() => onOpenBlueprint(gift)}><img src={gift.imageDataUrl} alt="" /><span>限定 · 仅可部署一处</span><strong>{gift.name}</strong><small>{gift.legendGift?.guestName} 留下</small></button>)}</div> : <p className="legend-empty">第一份赠礼还在云层上方，等待与你的酒店相遇。</p>}</section>
  </section>;
}
