import { createServer } from "node:http";

const port = Number(process.env.CLOUD_INN_PROXY_PORT ?? 8787);
const allowedOrigins = new Set((process.env.CLOUD_INN_ALLOWED_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((origin) => origin.trim()).filter(Boolean));
const providerOrigin = new URL(process.env.CLOUD_INN_IMAGE_API_ORIGIN ?? "https://img-api.apinebula.ai/");
const model = process.env.CLOUD_INN_IMAGE_MODEL ?? "gemini-3.1-flash-image";
const apiKey = process.env.CLOUD_INN_IMAGE_API_KEY;
const bodyLimit = 64 * 1024;
const callsByAddress = new Map();

const templates = new Map([
  ["garden-queen", "花园大床房：暖光、窗边休憩区、自然材质"],
  ["city-twin", "城市双床房：简洁利落、双人入住动线"],
  ["quiet-suite", "静谧套房：卧室与会客角相连、层次陈设"],
]);
const furniture = new Map([
  ["oak-bed", "橡木床架"], ["linen-chair", "亚麻单椅"], ["round-rug", "圆形地毯"],
  ["paper-lamp", "纸灯"], ["art-shelf", "画册置物架"], ["stone-table", "石面边几"],
]);

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(payload));
}

function problem(response, status, code, message) {
  send(response, status, { error: { code, message } });
}

function permit(request) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const calls = (callsByAddress.get(key) ?? []).filter((time) => now - time < 60_000);
  if (calls.length >= 8) return false;
  calls.push(now); callsByAddress.set(key, calls);
  return true;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0; let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > bodyLimit) { reject(new Error("too_large")); request.destroy(); return; }
      raw += chunk;
    });
    request.on("end", () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid_json")); } });
    request.on("error", reject);
  });
}

function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (!templates.has(input.templateId) || !Array.isArray(input.furnitureIds) || !input.furnitureIds.every((id) => furniture.has(id))) return null;
  if (typeof input.stylePrompt !== "string") return null;
  const stylePrompt = input.stylePrompt.trim();
  if (!stylePrompt || [...stylePrompt].length > 600) return null;
  return { templateId: input.templateId, furnitureIds: [...new Set(input.furnitureIds)], stylePrompt };
}

function buildPrompt(input) {
  const selectedFurniture = input.furnitureIds.map((id) => furniture.get(id)).join("、") || "保持留白";
  return [
    "Create one polished, photorealistic hotel room interior key visual. No people, no text, no logos, no collage, no exterior view.",
    `Room template: ${templates.get(input.templateId)}.`,
    `Furniture and arrangement cues: ${selectedFurniture}.`,
    `Creative direction supplied by the player: ${input.stylePrompt}`,
    "Compose a calm eye-level interior shot with believable architecture, soft natural light, and coherent furnishings. Landscape 4:3 aspect ratio.",
  ].join("\n");
}

function findImage(payload) {
  for (const candidate of payload?.candidates ?? []) {
    for (const part of candidate?.content?.parts ?? []) {
      const data = part?.inlineData;
      if (data && typeof data.data === "string" && ["image/png", "image/jpeg", "image/webp"].includes(data.mimeType)) return { base64: data.data, mimeType: data.mimeType };
    }
  }
  return null;
}

async function generate(input) {
  const endpoint = new URL(`v1beta/models/${encodeURIComponent(model)}:generateContent`, providerOrigin);
  if (endpoint.origin !== providerOrigin.origin) throw new Error("provider_origin");
  const providerResponse = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: "1K" } },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!providerResponse.ok) throw new Error("provider_failed");
  const image = findImage(await providerResponse.json());
  if (!image) throw new Error("invalid_provider_response");
  return image;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (request.method === "OPTIONS" && request.url === "/api/generate" && origin && allowedOrigins.has(origin)) {
    response.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" }); response.end(); return;
  }
  if (request.method !== "POST" || request.url !== "/api/generate") { problem(response, 404, "NOT_FOUND", "接口不存在。"); return; }
  if (!origin || !allowedOrigins.has(origin)) { problem(response, 403, "ORIGIN_DENIED", "请求来源不被允许。"); return; }
  if (!permit(request)) { problem(response, 429, "RATE_LIMITED", "请稍后再试。"); return; }
  if (!apiKey) { problem(response, 503, "GENERATION_NOT_CONFIGURED", "生成服务尚未配置。请由部署者在服务端设置图片模型密钥。"); return; }
  try {
    const input = validate(await readJson(request));
    if (!input) { problem(response, 400, "INVALID_REQUEST", "请检查客房、家具和风格描述。"); return; }
    const image = await generate(input);
    send(response, 200, { image, model });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "too_large" || code === "invalid_json") { problem(response, 400, "INVALID_REQUEST", "请求格式不正确。"); return; }
    problem(response, 502, "GENERATION_FAILED", "图片模型暂时无法生成，请稍后重试。");
  }
});

server.listen(port, () => console.log(`Cloud Inn image proxy listening on http://localhost:${port}`));
