import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { bedTypes, furnitureCards, roomTypes, zoneChoices, zoneGroups } from "./catalog";
import { FloorPlanner } from "./FloorPlanner";
import { listBlueprints, loadProject, saveBlueprint, saveBlueprints, saveProject } from "./storage";
import type { ApiError, Blueprint, DesignProject, FurnitureSelection, GenerateResponse } from "./types";

type StoredProject = Partial<DesignProject> & { templateId?: string; furnitureIds?: string[] };
type BlueprintArchive = { format: "cloud-inn-blueprint-library"; version: 1; exportedAt: string; blueprints: Blueprint[] };

const furnitureIds = new Set(furnitureCards.map((item) => item.id));
const legacyFurniture: Record<string, string> = {
  "linen-chair": "lounge-chair", "round-rug": "floor-rug", "paper-lamp": "reading-lamp",
  "art-shelf": "console", "stone-table": "side-table",
};

function newProject(): DesignProject {
  return {
    id: "current",
    name: "未命名客房",
    designKind: "room",
    roomTypeId: "single",
    bedTypeId: "queen",
    furniture: ["lounge-chair", "side-table", "reading-lamp"].map((id) => ({ id, material: "", style: "" })),
    areaSqm: 36,
    stylePrompt: "设计风格：安静温暖的海边旅馆。光照：午后自然光。特殊元素：窗外可见海面与低饱和植物。",
    updatedAt: new Date().toISOString(),
  };
}

function newZoneProject(): DesignProject {
  return {
    id: "current",
    name: "未命名功能区域",
    designKind: "zone",
    roomTypeId: "single",
    bedTypeId: "queen",
    furniture: [],
    areaSqm: 120,
    zoneTypeId: "lobby",
    stylePrompt: "设计风格：自然克制的度假酒店。光照：温暖柔和的间接光。陈设与特殊元素：当地植物、手作器物与舒适的停留角落。",
    updatedAt: new Date().toISOString(),
  };
}

function normaliseProject(stored: StoredProject): DesignProject {
  const designKind = stored.designKind === "zone" ? "zone" : "room";
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
    designKind,
    roomTypeId: roomTypes.some((item) => item.id === stored.roomTypeId) ? stored.roomTypeId! : legacyRoom,
    bedTypeId: bedTypes.some((item) => item.id === stored.bedTypeId) ? stored.bedTypeId! : legacyBed,
    furniture,
    areaSqm: typeof stored.areaSqm === "number" && Number.isFinite(stored.areaSqm) && stored.areaSqm >= 8 && stored.areaSqm <= 600 ? stored.areaSqm : designKind === "zone" ? 120 : 36,
    zoneTypeId: zoneChoices.some((item) => item.id === stored.zoneTypeId) ? stored.zoneTypeId : "lobby",
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

function readArchive(value: unknown): Blueprint[] {
  if (!value || typeof value !== "object") throw new Error("这不是 Cloud Inn 蓝图库存档。");
  const archive = value as Partial<BlueprintArchive>;
  if (archive.format !== "cloud-inn-blueprint-library" || archive.version !== 1 || !Array.isArray(archive.blueprints)) throw new Error("存档格式不受支持。");
  return archive.blueprints.map((item) => {
    if (!item || typeof item !== "object") throw new Error("存档中包含无效蓝图。");
    const raw = item as Blueprint & StoredProject;
    const blueprint = normaliseProject(raw);
    if (!blueprint.imageDataUrl?.startsWith("data:image/")) throw new Error("存档中有蓝图缺少图片。");
    const id = typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID();
    return { ...blueprint, id, blueprintId: id, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : blueprint.updatedAt };
  });
}

export function App() {
  const [project, setProject] = useState<DesignProject>(newProject);
  const [workspace, setWorkspace] = useState<"room" | "zone" | "floor">("room");
  const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState("正在打开本地作品…");
  const [generationState, setGenerationState] = useState<"idle" | "loading" | "error">("idle");
  const [generationError, setGenerationError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [archiveState, setArchiveState] = useState("");
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void Promise.all([loadProject(), listBlueprints()]).then(([stored, library]) => {
      if (stored) { const restored = normaliseProject(stored); setProject(restored); setWorkspace(restored.designKind); }
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
  const zoneType = useMemo(() => zoneChoices.find((item) => item.id === project.zoneTypeId)!, [project.zoneTypeId]);
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

  function beginDesign(kind: "room" | "zone") {
    if (project.designKind === kind) { setWorkspace(kind); return; }
    setProject(kind === "room" ? newProject() : newZoneProject());
    setWorkspace(kind);
    setGenerationError("");
  }

  function openBlueprint(blueprint: Blueprint) {
    setProject(updateTimestamp({ ...normaliseProject(blueprint), id: "current", blueprintId: blueprint.id }));
    setWorkspace(blueprint.designKind);
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
        body: JSON.stringify(project.designKind === "zone"
          ? { designKind: "zone", zoneTypeId: project.zoneTypeId, areaSqm: project.areaSqm, stylePrompt: project.stylePrompt }
          : { designKind: "room", roomTypeId: project.roomTypeId, bedTypeId: project.bedTypeId, furniture: project.furniture, areaSqm: project.areaSqm, stylePrompt: project.stylePrompt }),
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

  function exportArchive() {
    const archive: BlueprintArchive = { format: "cloud-inn-blueprint-library", version: 1, exportedAt: new Date().toISOString(), blueprints };
    const url = URL.createObjectURL(new Blob([JSON.stringify(archive)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cloud-inn-blueprints-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setArchiveState(`已导出 ${blueprints.length} 张蓝图`);
  }

  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 80 * 1024 * 1024) { setArchiveState("存档超过 80 MB，无法导入。"); return; }
    try {
      const imported = readArchive(JSON.parse(await file.text()));
      await saveBlueprints(imported);
      setBlueprints((current) => [...imported, ...current.filter((item) => !imported.some((blueprint) => blueprint.id === item.id))].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      setArchiveState(`已导入 ${imported.length} 张蓝图`);
    } catch (error) {
      setArchiveState(error instanceof Error ? error.message : "无法读取该存档。");
    }
  }

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Cloud Inn 首页">Cloud Inn <span>客房设计</span></a>
      <div className="topbar-actions"><p aria-live="polite">{saveState}</p><button className="library-trigger" type="button" onClick={() => setLibraryOpen(true)}>蓝图库 <span>{blueprints.length}</span></button></div>
    </header>
    <section className="intro">
      <div className="design-switcher" role="tablist" aria-label="酒店设计与经营"><button type="button" role="tab" aria-selected={workspace === "room"} className={workspace === "room" ? "selected" : ""} onClick={() => beginDesign("room")}>设计客房</button><button type="button" role="tab" aria-selected={workspace === "zone"} className={workspace === "zone" ? "selected" : ""} onClick={() => beginDesign("zone")}>设计功能区域</button><button type="button" role="tab" aria-selected={workspace === "floor"} className={workspace === "floor" ? "selected" : ""} onClick={() => setWorkspace("floor")}>楼层平面图</button></div>
      <p className="eyebrow">{workspace === "floor" ? "酒店经营，从空间开始" : project.designKind === "room" ? "一间房，一种情绪" : "一处区域，一种体验"}</p>
      <h1>{workspace === "floor" ? "把空间排布成一层正在运转的酒店。" : project.designKind === "room" ? "把你想住进去的客房，变成一张图。" : "把酒店里的功能区域，变成一张图。"}</h1>
      <p>{workspace === "floor" ? "这一层共 1200㎡。选择蓝图库中已设计的空间，用矩形或自由轮廓在地图上圈地；不够时可叠加多个区域，达到蓝图面积后再确认部署。" : project.designKind === "room" ? "从客房类型和床型开始，再添置家具。每件家具都能单独决定材质和风格；留空时由模型为整间房随机搭配。" : "选择一处酒店功能区域，再写下它的风格、光照、陈设和特殊元素。模型会将它组织为可用于后续建设的空间蓝图。"}</p>
    </section>
    {workspace === "floor" ? <FloorPlanner blueprints={blueprints} onOpenBlueprint={openBlueprint} /> : <div className="studio">
      <section className="controls" aria-label="设计工具">
        <fieldset><legend>01 · 命名蓝图</legend><label className="sr-only" htmlFor="room-name">客房蓝图名称</label><input id="room-name" className="room-name" maxLength={40} value={project.name} onChange={(event) => setProject((current) => updateTimestamp({ ...current, name: event.target.value }))} placeholder="例如：海岸午后房" /></fieldset>
        <fieldset><legend>02 · 使用面积</legend><div className="area-input"><input id="area-sqm" type="number" min="8" max="600" step="1" value={project.areaSqm} onChange={(event) => setProject((current) => updateTimestamp({ ...current, areaSqm: Math.max(8, Math.min(600, Number(event.target.value) || 8)) }))} /><span>m²</span><small>{project.designKind === "zone" ? "决定该区域在楼层中的占地面积。" : "决定该客房在楼层中的占地面积。"}</small></div></fieldset>
        {project.designKind === "room" && <>
        <fieldset>
          <legend>03 · 选择客房类型</legend>
          <div className="choice-list">{roomTypes.map((item) => <button key={item.id} type="button" className={`template ${item.id === project.roomTypeId ? "selected" : ""}`} onClick={() => setProject((current) => updateTimestamp({ ...current, roomTypeId: item.id }))}><span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div>
        </fieldset>
        <fieldset>
          <legend>04 · 选择床型</legend>
          <div className="choice-list">{bedTypes.map((item) => <button key={item.id} type="button" className={`template ${item.id === project.bedTypeId ? "selected" : ""}`} onClick={() => setProject((current) => updateTimestamp({ ...current, bedTypeId: item.id }))}><span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div>
        </fieldset>
        <fieldset>
          <legend>05 · 添置家具 <span>{project.furniture.length}/10</span></legend>
          <p className="field-hint">选中后可单独填写材质和风格；留空就交给模型随机搭配。</p>
          <div className="furniture-grid">{furnitureCards.map((item) => {
            const selection = project.furniture.find((choice) => choice.id === item.id);
            return <div className={`furniture-config ${selection ? "selected" : ""}`} key={item.id}>
              <button type="button" aria-pressed={Boolean(selection)} className={`furniture ${selection ? "selected" : ""}`} onClick={() => toggleFurniture(item.id)}><span aria-hidden="true">{item.icon}</span><strong>{item.name}</strong><small>{item.description}</small></button>
              {selection && <div className="furniture-details"><label>材质<input maxLength={80} value={selection.material} onChange={(event) => updateFurniture(item.id, "material", event.target.value)} placeholder="留空随机" /></label><label>风格<input maxLength={80} value={selection.style} onChange={(event) => updateFurniture(item.id, "style", event.target.value)} placeholder="留空随机" /></label></div>}
            </div>;
          })}</div>
        </fieldset>
        </>}
        {project.designKind === "zone" && <fieldset>
          <legend>03 · 选择功能区域</legend>
          <p className="field-hint">选择你准备建设的酒店区域。</p>
          <div className="zone-groups">{zoneGroups.map((group) => <section className="zone-group" key={group.name}><h3>{group.name}</h3><div className="zone-list">{group.choices.map((item) => <button type="button" key={item.id} className={`template ${item.id === project.zoneTypeId ? "selected" : ""}`} onClick={() => setProject((current) => updateTimestamp({ ...current, zoneTypeId: item.id }))}><span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small></button>)}</div></section>)}</div>
        </fieldset>}
        <fieldset>
          <legend>{project.designKind === "room" ? "06 · 写下想象" : "04 · 写下想象"}</legend>
          <p className="field-hint">{project.designKind === "room" ? "在这里控制整间房的设计风格、光照和特殊元素；已填写的家具设定会优先保留。" : "在这里控制该区域的设计风格、光照、陈设和特殊元素。"}</p>
          <label className="sr-only" htmlFor="style-prompt">总体风格、光照与特殊元素</label><textarea id="style-prompt" maxLength={600} value={project.stylePrompt} onChange={(event) => setProject((current) => updateTimestamp({ ...current, stylePrompt: event.target.value }))} placeholder="设计风格：…&#10;光照：…&#10;特殊元素：…" />
          <div className="prompt-footer"><span>{project.stylePrompt.length}/600</span><button type="button" className="generate" disabled={generationState === "loading" || !project.stylePrompt.trim()} onClick={() => void generate()}>{generationState === "loading" ? "正在绘制…" : project.imageDataUrl ? "重新生成" : "生成效果图"}</button></div>
          {generationError && <p className="error" role="alert">{generationError}</p>}
        </fieldset>
      </section>
      <section className="canvas" aria-label="设计主视觉">
        <div className={`visual ${project.imageDataUrl ? "has-image" : ""}`}>{project.imageDataUrl ? <img src={project.imageDataUrl} alt={`${project.name || (project.designKind === "zone" ? zoneType.name : roomType.name)} 效果图`} /> : <div className="empty-visual"><span>✦</span><p>{project.designKind === "zone" ? "你的功能区域效果图将在这里出现" : "你的客房效果图将在这里出现"}</p></div>}</div>
        <div className="visual-caption"><div><p>{project.name || (project.designKind === "zone" ? zoneType.name : roomType.name)}</p><span>{project.designKind === "zone" ? `${zoneType.name} · 功能区域` : `${roomType.name} · ${bedType.name} · ${selectedFurniture.map((item) => item.name).join(" · ") || "尚未选择家具"}`}</span></div><span>{project.imageDataUrl ? "已生成" : "等待灵感"}</span></div>
        <div className="blueprint-actions"><button type="button" className="secondary" onClick={() => setProject(project.designKind === "zone" ? newZoneProject() : newProject())}>开始新的{project.designKind === "zone" ? "功能区域" : "客房"}</button><button type="button" className="save-blueprint" disabled={!project.imageDataUrl} onClick={() => void saveToLibrary()}>{currentBlueprint ? "更新蓝图" : "保存至蓝图库"}</button></div>
      </section>
    </div>}
    {libraryOpen && <div className="library-backdrop" role="presentation" onMouseDown={() => setLibraryOpen(false)}><section className="blueprint-library" role="dialog" aria-modal="true" aria-label="蓝图库" onMouseDown={(event) => event.stopPropagation()}><div className="library-heading"><div><p className="eyebrow">可重复使用的酒店方案</p><h2>蓝图库</h2><span>打开一张蓝图，继续修改细节或重新生成效果图。</span>{archiveState && <p className="archive-state" role="status">{archiveState}</p>}</div><div className="library-actions"><input ref={importInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => void importArchive(event)} /><button type="button" className="archive-button" onClick={() => importInput.current?.click()}>导入存档</button><button type="button" className="archive-button" disabled={!blueprints.length} onClick={exportArchive}>导出存档</button><button type="button" className="close-library" aria-label="关闭蓝图库" onClick={() => setLibraryOpen(false)}>×</button></div></div>{blueprints.length ? <div className="blueprint-grid">{blueprints.map((blueprint) => { const isZone = blueprint.designKind === "zone"; const blueprintType = isZone ? zoneChoices.find((item) => item.id === blueprint.zoneTypeId)! : roomTypes.find((item) => item.id === blueprint.roomTypeId)!; return <button className="blueprint-card" type="button" key={blueprint.id} onClick={() => openBlueprint(blueprint)}><img src={blueprint.imageDataUrl} alt={`${blueprint.name} 蓝图预览`} /><div><strong>{blueprint.name || blueprintType.name}</strong><span>{blueprintType.name} · {isZone ? "功能区域" : `${blueprint.furniture.length} 件家具`}</span><small>最近编辑于 {formatDate(blueprint.updatedAt)}</small></div></button>; })}</div> : <div className="library-empty"><span>◇</span><h3>还没有蓝图</h3><p>导入已有存档，或生成一张喜欢的效果图后保存至蓝图库。</p></div>}</section></div>}
  </main>;
}
