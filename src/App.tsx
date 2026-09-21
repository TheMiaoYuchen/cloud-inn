import { useEffect, useMemo, useState } from "react";
import { bedTypes, furnitureCards, roomTypes } from "./catalog";
import { listBlueprints, loadProject, saveBlueprint, saveProject } from "./storage";
import type { ApiError, Blueprint, DesignProject, FurnitureSelection, GenerateResponse } from "./types";

type StoredProject = Partial<DesignProject> & { templateId?: string; furnitureIds?: string[] };

const furnitureIds = new Set(furnitureCards.map((item) => item.id));
const legacyFurniture: Record<string, string> = {
  "linen-chair": "lounge-chair", "round-rug": "floor-rug", "paper-lamp": "reading-lamp",
  "art-shelf": "console", "stone-table": "side-table",
};

function newProject(): DesignProject {
  return {
    id: "current",
    name: "未命名客房",
    roomTypeId: "single",
    bedTypeId: "queen",
    furniture: ["lounge-chair", "side-table", "reading-lamp"].map((id) => ({ id, material: "", style: "" })),
    stylePrompt: "设计风格：安静温暖的海边旅馆。光照：午后自然光。特殊元素：窗外可见海面与低饱和植物。",
    updatedAt: new Date().toISOString(),
  };
}

function normaliseProject(stored: StoredProject): DesignProject {
  const legacyRoom = stored.templateId === "quiet-suite" ? "suite" : "single";
  const legacyBed = stored.templateId === "city-twin" ? "twin" : "queen";
  const sourceFurniture = Array.isArray(stored.furniture)
    ? stored.furniture
    : (stored.furnitureIds ?? []).map((id) => ({ id: legacyFurniture[id] ?? id, material: "", style: "" }));
  const furniture = sourceFurniture.filter((item): item is FurnitureSelection => Boolean(item && furnitureIds.has(item.id))).map((item) => ({
    id: item.id,
    material: typeof item.material === "string" ? item.material : "",
    style: typeof item.style === "string" ? item.style : "",
  }));
  return {
    id: stored.id ?? "current",
    name: stored.name ?? "未命名客房",
    blueprintId: stored.blueprintId,
    roomTypeId: roomTypes.some((item) => item.id === stored.roomTypeId) ? stored.roomTypeId! : legacyRoom,
    bedTypeId: bedTypes.some((item) => item.id === stored.bedTypeId) ? stored.bedTypeId! : legacyBed,
    furniture,
    stylePrompt: stored.stylePrompt ?? "",
    imageDataUrl: stored.imageDataUrl,
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
  };
}

function updateTimestamp(project: DesignProject): DesignProject {
  return { ...project, updatedAt: new Date().toISOString() };
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(date));
}

export function App() {
  const [project, setProject] = useState<DesignProject>(newProject);
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState("正在打开本地作品…");
  const [generationState, setGenerationState] = useState<"idle" | "loading" | "error">("idle");
  const [generationError, setGenerationError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);

  useEffect(() => {
    void Promise.all([loadProject(), listBlueprints()]).then(([stored, library]) => {
      if (stored) setProject(normaliseProject(stored));
      setBlueprints(library.map((item) => normaliseProject(item) as Blueprint));
      setReady(true);
      setSaveState(stored ? "已恢复本地作品" : "新作品已准备好");
    }).catch(() => { setReady(true); setSaveState("浏览器存储不可用"); });
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void saveProject(project).then(() => setSaveState("已自动保存在此浏览器")).catch(() => setSaveState("自动保存失败"));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [project, ready]);

  const roomType = useMemo(() => roomTypes.find((item) => item.id === project.roomTypeId)!, [project.roomTypeId]);
  const bedType = useMemo(() => bedTypes.find((item) => item.id === project.bedTypeId)!, [project.bedTypeId]);
  const selectedFurniture = furnitureCards.filter((item) => project.furniture.some((selection) => selection.id === item.id));
  const currentBlueprint = blueprints.find((blueprint) => blueprint.id === project.blueprintId);

  function toggleFurniture(id: string) {
    setProject((current) => {
      const selected = current.furniture.some((item) => item.id === id);
      if (!selected && current.furniture.length >= 10) return current;
      return updateTimestamp({ ...current, furniture: selected ? current.furniture.filter((item) => item.id !== id) : [...current.furniture, { id, material: "", style: "" }] });
    });
  }

  function updateFurniture(id: string, field: "material" | "style", value: string) {
    setProject((current) => updateTimestamp({ ...current, furniture: current.furniture.map((item) => item.id === id ? { ...item, [field]: value } : item) }));
  }

  function openBlueprint(blueprint: Blueprint) {
    setProject(updateTimestamp({ ...normaliseProject(blueprint), id: "current", blueprintId: blueprint.id }));
    setLibraryOpen(false);
    setGenerationError("");
    setSaveState(`已打开蓝图「${blueprint.name}」`);
  }

  async function saveToLibrary() {
    if (!project.imageDataUrl) return;
    const now = new Date().toISOString();
    const id = project.blueprintId ?? crypto.randomUUID();
    const blueprint: Blueprint = { ...project, id, blueprintId: id, createdAt: currentBlueprint?.createdAt ?? now, updatedAt: now };
    try {
      await saveBlueprint(blueprint);
      setProject({ ...project, blueprintId: id, updatedAt: now });
      setBlueprints((current) => [blueprint, ...current.filter((item) => item.id !== id)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setSaveState(currentBlueprint ? "蓝图已更新" : "已保存到蓝图库");
    } catch { setSaveState("保存蓝图失败"); }
  }

  async function generate() {
    setGenerationError("");
    setGenerationState("loading");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomTypeId: project.roomTypeId, bedTypeId: project.bedTypeId, furniture: project.furniture, stylePrompt: project.stylePrompt }),
      });
      const body = await response.json() as GenerateResponse | ApiError;
      if (!response.ok || !("image" in body)) throw new Error("error" in body ? body.error.message : "生成服务暂时不可用");
      setProject((current) => updateTimestamp({ ...current, imageDataUrl: `data:${body.image.mimeType};base64,${body.image.base64}` }));
      setGenerationState("idle");
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成服务暂时不可用");
      setGenerationState("error");
    }
  }

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Cloud Inn 首页">Cloud Inn <span>客房设计</span></a>
      <div className="topbar-actions"><p aria-live="polite">{saveState}</p><button className="library-trigger" type="button" onClick={() => setLibraryOpen(true)}>蓝图库 <span>{blueprints.length}</span></button></div>
    </header>
    <section className="intro">
      <p className="eyebrow">一间房，一种情绪</p>
      <h1>把你想住进去的客房，变成一张图。</h1>
      <p>从客房类型和床型开始，再添置家具。每件家具都能单独决定材质和风格；留空时由模型为整间房随机搭配。</p>
    </section>
    <div className="studio">
      <section className="controls" aria-label="设计工具">
        <fieldset><legend>01 · 命名蓝图</legend><label className="sr-only" htmlFor="room-name">客房蓝图名称</label><input id="room-name" className="room-name" maxLength={40} value={project.name} onChange={(event) => setProject((current) => updateTimestamp({ ...current, name: event.target.value }))} placeholder="例如：海岸午后房" /></fieldset>
        <fieldset>
          <legend>02 · 选择客房类型</legend>
          <div className="choice-list">{roomTypes.map((item) => <button key={item.id} type="button" className={`template ${item.id === project.roomTypeId ? "selected" : ""}`} onClick={() => setProject((current) => updateTimestamp({ ...current, roomTypeId: item.id }))}><span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div>
        </fieldset>
        <fieldset>
          <legend>03 · 选择床型</legend>
          <div className="choice-list">{bedTypes.map((item) => <button key={item.id} type="button" className={`template ${item.id === project.bedTypeId ? "selected" : ""}`} onClick={() => setProject((current) => updateTimestamp({ ...current, bedTypeId: item.id }))}><span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div>
        </fieldset>
        <fieldset>
          <legend>04 · 添置家具 <span>{project.furniture.length}/10</span></legend>
          <p className="field-hint">选中后可单独填写材质和风格；留空就交给模型随机搭配。</p>
          <div className="furniture-grid">{furnitureCards.map((item) => {
            const selection = project.furniture.find((choice) => choice.id === item.id);
            return <div className={`furniture-config ${selection ? "selected" : ""}`} key={item.id}>
              <button type="button" aria-pressed={Boolean(selection)} className={`furniture ${selection ? "selected" : ""}`} onClick={() => toggleFurniture(item.id)}><span aria-hidden="true">{item.icon}</span><strong>{item.name}</strong><small>{item.description}</small></button>
              {selection && <div className="furniture-details"><label>材质<input maxLength={80} value={selection.material} onChange={(event) => updateFurniture(item.id, "material", event.target.value)} placeholder="留空随机" /></label><label>风格<input maxLength={80} value={selection.style} onChange={(event) => updateFurniture(item.id, "style", event.target.value)} placeholder="留空随机" /></label></div>}
            </div>;
          })}</div>
        </fieldset>
        <fieldset>
          <legend>05 · 写下想象</legend>
          <p className="field-hint">在这里控制整间房的设计风格、光照和特殊元素；已填写的家具设定会优先保留。</p>
          <label className="sr-only" htmlFor="style-prompt">总体风格、光照与特殊元素</label><textarea id="style-prompt" maxLength={600} value={project.stylePrompt} onChange={(event) => setProject((current) => updateTimestamp({ ...current, stylePrompt: event.target.value }))} placeholder="设计风格：…&#10;光照：…&#10;特殊元素：…" />
          <div className="prompt-footer"><span>{project.stylePrompt.length}/600</span><button type="button" className="generate" disabled={generationState === "loading" || !project.stylePrompt.trim()} onClick={() => void generate()}>{generationState === "loading" ? "正在绘制…" : project.imageDataUrl ? "重新生成" : "生成效果图"}</button></div>
          {generationError && <p className="error" role="alert">{generationError}</p>}
        </fieldset>
      </section>
      <section className="canvas" aria-label="客房主视觉">
        <div className={`visual ${project.imageDataUrl ? "has-image" : ""}`}>{project.imageDataUrl ? <img src={project.imageDataUrl} alt={`${project.name || roomType.name} 效果图`} /> : <div className="empty-visual"><span>✦</span><p>你的客房效果图将在这里出现</p></div>}</div>
        <div className="visual-caption"><div><p>{project.name || roomType.name}</p><span>{roomType.name} · {bedType.name} · {selectedFurniture.map((item) => item.name).join(" · ") || "尚未选择家具"}</span></div><span>{project.imageDataUrl ? "已生成" : "等待灵感"}</span></div>
        <div className="blueprint-actions"><button type="button" className="secondary" onClick={() => setProject(newProject())}>开始新客房</button><button type="button" className="save-blueprint" disabled={!project.imageDataUrl} onClick={() => void saveToLibrary()}>{currentBlueprint ? "更新蓝图" : "保存至蓝图库"}</button></div>
      </section>
    </div>
    {libraryOpen && <div className="library-backdrop" role="presentation" onMouseDown={() => setLibraryOpen(false)}><section className="blueprint-library" role="dialog" aria-modal="true" aria-label="蓝图库" onMouseDown={(event) => event.stopPropagation()}><div className="library-heading"><div><p className="eyebrow">可重复使用的客房方案</p><h2>蓝图库</h2><span>打开一张蓝图，继续修改细节或重新生成效果图。</span></div><button type="button" className="close-library" aria-label="关闭蓝图库" onClick={() => setLibraryOpen(false)}>×</button></div>{blueprints.length ? <div className="blueprint-grid">{blueprints.map((blueprint) => { const blueprintRoomType = roomTypes.find((item) => item.id === blueprint.roomTypeId)!; return <button className="blueprint-card" type="button" key={blueprint.id} onClick={() => openBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt={`${blueprint.name} 蓝图预览`} /><div><strong>{blueprint.name || blueprintRoomType.name}</strong><span>{blueprintRoomType.name} · {blueprint.furniture.length} 件家具</span><small>最近编辑于 {formatDate(blueprint.updatedAt)}</small></div></button>; })}</div> : <div className="library-empty"><span>◇</span><h3>还没有蓝图</h3><p>生成一张喜欢的客房效果图后，点击“保存至蓝图库”。</p></div>}</section></div>}
  </main>;
}
