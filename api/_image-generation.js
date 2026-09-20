const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_PRODUCTION_ORIGIN = "https://cloud-inn-test.zhong2.xyz";
const BODY_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 3 * 1024 * 1024;
const MODEL_RESPONSE_LIMIT = 4 * 1024 * 1024 + 128 * 1024;
const REQUEST_TIMEOUT_MS = 50_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
const supportedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

const templates = new Map([
  ["garden-queen", "花园大床房：暖光、窗边休憩区、自然材质"],
  ["city-twin", "城市双床房：简洁利落、双人入住动线"],
  ["quiet-suite", "静谧套房：卧室与会客角相连、层次陈设"],
]);

const furniture = new Map([
  ["oak-bed", "橡木床架"], ["linen-chair", "亚麻单椅"], ["round-rug", "圆形地毯"],
  ["paper-lamp", "纸灯"], ["art-shelf", "画册置物架"], ["stone-table", "石面边几"],
]);

function allowedOrigins(environment) {
  const configured = environment.CLOUD_INN_ALLOWED_ORIGIN;
  return new Set((configured ? configured.split(",") : [...LOCAL_ORIGINS, DEFAULT_PRODUCTION_ORIGIN]).map((origin) => origin.trim()).filter(Boolean));
}

function send(response, status, payload, origin) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
  if (typeof response.status === "function" && typeof response.json === "function") { response.status(status).json(payload); return; }
  response.statusCode = status;
  response.end(JSON.stringify(payload));
}

function problem(response, status, code, message, origin) {
  send(response, status, { error: { code, message } }, origin);
}

function readBody(request) {
  if (request.body && typeof request.body === "object") return Promise.resolve(request.body);
  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body) > BODY_LIMIT) return Promise.reject(new Error("too_large"));
    try { return Promise.resolve(JSON.parse(request.body)); } catch { return Promise.reject(new Error("invalid_json")); }
  }
  return new Promise((resolve, reject) => {
    let byteLength = 0; let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      byteLength += Buffer.byteLength(chunk);
      if (byteLength > BODY_LIMIT) { reject(new Error("too_large")); request.destroy(); return; }
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
      if (data && typeof data.data === "string" && supportedMimeTypes.has(data.mimeType)) return { base64: data.data, mimeType: data.mimeType };
    }
  }
  return null;
}

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return request.socket?.remoteAddress ?? "unknown";
}

function allowRequest(request, callsByAddress, now) {
  const address = clientAddress(request);
  const calls = (callsByAddress.get(address) ?? []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (calls.length >= RATE_LIMIT_MAX) return false;
  calls.push(now); callsByAddress.set(address, calls);
  return true;
}

async function callImageModel(input, { apiKey, model, providerOrigin, fetchImplementation }) {
  const origin = new URL(providerOrigin);
  const endpoint = new URL(`v1beta/models/${encodeURIComponent(model)}:generateContent`, origin);
  if (endpoint.origin !== origin.origin) throw new Error("provider_origin");
  const upstream = await fetchImplementation(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: "1K" } },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error("provider_failed");
  const contentLength = Number(upstream.headers.get("content-length") ?? 0);
  if (contentLength > MODEL_RESPONSE_LIMIT) throw new Error("image_too_large");
  const payload = await readModelPayload(upstream);
  const image = findImage(payload);
  if (!image) throw new Error("invalid_provider_response");
  if (Buffer.byteLength(image.base64, "base64") > IMAGE_LIMIT) throw new Error("image_too_large");
  return image;
}

async function readModelPayload(upstream) {
  if (!upstream.body) return upstream.json();
  const reader = upstream.body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MODEL_RESPONSE_LIMIT) { await reader.cancel(); throw new Error("image_too_large"); }
    chunks.push(value);
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(result)); } catch { throw new Error("invalid_provider_response"); }
}

export function createGenerateHandler({ environment = process.env, fetchImplementation = fetch, now = () => Date.now() } = {}) {
  const callsByAddress = new Map();
  const permittedOrigins = allowedOrigins(environment);
  const model = environment.CLOUD_INN_IMAGE_MODEL ?? "gemini-3.1-flash-image";
  const providerOrigin = environment.CLOUD_INN_IMAGE_API_ORIGIN ?? "https://img-api.apinebula.ai/";
  const apiKey = environment.CLOUD_INN_IMAGE_API_KEY;

  return async function generateHandler(request, response) {
    const origin = request.headers.origin;
    const corsOrigin = origin && permittedOrigins.has(origin) ? origin : undefined;
    if (request.method === "OPTIONS" && request.url?.startsWith("/api/generate") && corsOrigin) {
      response.setHeader("access-control-allow-origin", corsOrigin);
      response.setHeader("access-control-allow-methods", "POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "Origin");
      if (typeof response.status === "function") response.status(204).end();
      else { response.statusCode = 204; response.end(); }
      return;
    }
    if (!request.url?.startsWith("/api/generate")) { problem(response, 404, "NOT_FOUND", "接口不存在。", corsOrigin); return; }
    if (request.method !== "POST") { problem(response, 405, "METHOD_NOT_ALLOWED", "只支持 POST 请求。", corsOrigin); return; }
    if (!corsOrigin) { problem(response, 403, "ORIGIN_DENIED", "请求来源不被允许。"); return; }
    if (!allowRequest(request, callsByAddress, now())) { problem(response, 429, "RATE_LIMITED", "请稍后再试。", corsOrigin); return; }
    if (!apiKey) { problem(response, 503, "GENERATION_NOT_CONFIGURED", "生成服务尚未配置。请由部署者在服务端设置图片模型密钥。", corsOrigin); return; }
    try {
      const input = validate(await readBody(request));
      if (!input) { problem(response, 400, "INVALID_REQUEST", "请检查客房、家具和风格描述。", corsOrigin); return; }
      const image = await callImageModel(input, { apiKey, model, providerOrigin, fetchImplementation });
      send(response, 200, { image, model }, corsOrigin);
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code === "too_large" || code === "invalid_json") { problem(response, 400, "INVALID_REQUEST", "请求格式不正确。", corsOrigin); return; }
      if (code === "image_too_large") { problem(response, 502, "IMAGE_TOO_LARGE", "图片返回过大，请重新生成。", corsOrigin); return; }
      problem(response, 502, "GENERATION_FAILED", "图片模型暂时无法生成，请稍后重试。", corsOrigin);
    }
  };
}

export const internal = { buildPrompt, validate, findImage };
