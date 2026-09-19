import { useEffect, useMemo, useState } from "react";
import { furnitureCards, roomTemplates } from "./catalog";
import { loadProject, saveProject } from "./storage";
import type { ApiError, DesignProject, GenerateResponse } from "./types";

const initialProject: DesignProject = {
  id: "current",
  name: "未命名客房",
  templateId: "garden-queen",
  furnitureIds: ["oak-bed", "linen-chair", "paper-lamp"],
  stylePrompt: "日式侘寂与地中海午后相遇，低饱和暖白墙面，粗陶与旧木，阳光从窗边漫进房间。",
  updatedAt: new Date().toISOString(),
};

function updateTimestamp(project: DesignProject): DesignProject {
  return { ...project, updatedAt: new Date().toISOString() };
}

export function App() {
  const [project, setProject] = useState<DesignProject>(initialProject);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState("正在打开本地作品…");
  const [generationState, setGenerationState] = useState<"idle" | "loading" | "error">("idle");
  const [generationError, setGenerationError] = useState("");

  useEffect(() => {
    void loadProject().then((stored) => {
      if (stored) setProject(stored);
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

  const template = useMemo(() => roomTemplates.find((item) => item.id === project.templateId)!, [project.templateId]);
  const selectedFurniture = furnitureCards.filter((item) => project.furnitureIds.includes(item.id));

  function chooseTemplate(templateId: string) {
    setProject((current) => updateTimestamp({ ...current, templateId }));
  }

  function toggleFurniture(id: string) {
    setProject((current) => updateTimestamp({
      ...current,
      furnitureIds: current.furnitureIds.includes(id)
        ? current.furnitureIds.filter((item) => item !== id)
        : [...current.furnitureIds, id],
    }));
  }

  async function generate() {
    setGenerationError("");
    setGenerationState("loading");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: project.templateId, furnitureIds: project.furnitureIds, stylePrompt: project.stylePrompt }),
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Cloud Inn 首页">Cloud Inn <span>客房设计</span></a>
        <p aria-live="polite">{saveState}</p>
      </header>
      <section className="intro">
        <p className="eyebrow">一间房，一种情绪</p>
        <h1>把你想住进去的客房，变成一张图。</h1>
        <p>挑一间房，摆几件喜欢的家具，再写下氛围。生成结果会留在当前浏览器里。</p>
      </section>
      <div className="studio">
        <section className="controls" aria-label="设计工具">
          <fieldset>
            <legend>01 · 选择客房</legend>
            <div className="template-list">
              {roomTemplates.map((item) => <button key={item.id} type="button" className={`template ${item.id === project.templateId ? "selected" : ""}`} onClick={() => chooseTemplate(item.id)}>
                <span className="template-accent">{item.accent}</span><strong>{item.name}</strong><small>{item.description}</small>
              </button>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>02 · 添置家具 <span>{project.furnitureIds.length}/6</span></legend>
            <div className="furniture-grid">
              {furnitureCards.map((item) => <button key={item.id} type="button" aria-pressed={project.furnitureIds.includes(item.id)} className={`furniture ${project.furnitureIds.includes(item.id) ? "selected" : ""}`} onClick={() => toggleFurniture(item.id)}>
                <span aria-hidden="true">{item.icon}</span><strong>{item.name}</strong><small>{item.description}</small>
              </button>)}
            </div>
          </fieldset>
          <fieldset>
            <legend>03 · 写下想象</legend>
            <label className="sr-only" htmlFor="style-prompt">风格描述</label>
            <textarea id="style-prompt" maxLength={600} value={project.stylePrompt} onChange={(event) => setProject((current) => updateTimestamp({ ...current, stylePrompt: event.target.value }))} placeholder="例如：清晨的海边旅馆，亚麻、盐雾与柔软的蓝…" />
            <div className="prompt-footer"><span>{project.stylePrompt.length}/600</span><button type="button" className="generate" disabled={generationState === "loading" || !project.stylePrompt.trim()} onClick={() => void generate()}>{generationState === "loading" ? "正在绘制…" : project.imageDataUrl ? "重新生成" : "生成效果图"}</button></div>
            {generationError && <p className="error" role="alert">{generationError}</p>}
          </fieldset>
        </section>
        <section className="canvas" aria-label="客房主视觉">
          <div className={`visual ${project.imageDataUrl ? "has-image" : ""}`}>
            {project.imageDataUrl ? <img src={project.imageDataUrl} alt={`${template.name} 效果图`} /> : <div className="empty-visual"><span>✦</span><p>你的客房效果图将在这里出现</p></div>}
          </div>
          <div className="visual-caption"><div><p>{template.name}</p><span>{selectedFurniture.map((item) => item.name).join(" · ") || "尚未选择家具"}</span></div><span>{project.imageDataUrl ? "已保存" : "等待灵感"}</span></div>
        </section>
      </div>
    </main>
  );
}
