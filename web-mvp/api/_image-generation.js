const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_PRODUCTION_ORIGIN = "https://cloud-inn-test.zhong2.xyz";
const BODY_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 3 * 1024 * 1024;
const MODEL_RESPONSE_LIMIT = 4 * 1024 * 1024 + 128 * 1024;
const REQUEST_TIMEOUT_MS = 50_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;

const roomTypes = new Map([
  ["single", "single guest room with one complete sleeping area and a compact living flow"],
  ["suite", "hotel suite with a connected sleeping zone and a distinct living area"],
]);

const bedTypes = new Map([
  ["queen", "one large queen bed"],
  ["twin", "two separate twin beds"],
]);

const zones = new Map([
  ["lobby", "hotel reception lobby for arrival, waiting and welcome"],
  ["dining", "hotel dining area for breakfast, meals and lingering"],
  ["meeting-room", "hotel meeting room for discussion and presentations"],
  ["gift-shop", "hotel gift shop for local objects and travel keepsakes"],
  ["pool", "hotel swimming pool area with water and lounging"],
  ["fitness", "hotel fitness center for training and recovery"],
  ["spa", "hotel spa for treatments, sensory calm and restoration"],
]);

const furniture = new Map([
  ["lounge-chair", "lounge chair"], ["side-table", "side table"], ["reading-lamp", "reading lamp"],
  ["floor-rug", "area rug"], ["work-desk", "work desk"], ["mini-bar", "mini bar"],
  ["lounge-sofa", "two-seat sofa"], ["coffee-table", "coffee table"], ["wardrobe", "wardrobe"],
  ["console", "entry console"], ["floor-lamp", "floor lamp"], ["indoor-plant", "indoor plant"],
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
  const areaSqm = Number(input.areaSqm);
  if (!Number.isInteger(areaSqm) || areaSqm < 8 || areaSqm > 600) return null;
  if (input.designKind === "zone") {
    if (!zones.has(input.zoneTypeId) || typeof input.stylePrompt !== "string") return null;
    const stylePrompt = input.stylePrompt.trim();
    if (!stylePrompt || [...stylePrompt].length > 600) return null;
    return { designKind: "zone", zoneTypeId: input.zoneTypeId, areaSqm, stylePrompt };
  }
  if (!roomTypes.has(input.roomTypeId) || !bedTypes.has(input.bedTypeId) || !Array.isArray(input.furniture) || input.furniture.length > 10) return null;
  const selectedFurniture = [];
  for (const item of input.furniture) {
    if (!item || typeof item !== "object" || !furniture.has(item.id) || typeof item.material !== "string" || typeof item.style !== "string") return null;
    const material = item.material.trim();
    const style = item.style.trim();
    if ([...material].length > 80 || [...style].length > 80 || selectedFurniture.some((choice) => choice.id === item.id)) return null;
    selectedFurniture.push({ id: item.id, material, style });
  }
  if (typeof input.stylePrompt !== "string") return null;
  const stylePrompt = input.stylePrompt.trim();
  if (!stylePrompt || [...stylePrompt].length > 600) return null;
  return { designKind: "room", roomTypeId: input.roomTypeId, bedTypeId: input.bedTypeId, furniture: selectedFurniture, areaSqm, stylePrompt };
}

function buildPrompt(input) {
  if (input.designKind === "zone") {
    return [
      "Create one polished, photorealistic hotel functional-area blueprint contact sheet. Show exactly four equal panels arranged in 2 columns by 2 rows with thin quiet gutters. Keep each panel composed safely for a wide landscape crop.",
      `Functional area: ${zones.get(input.zoneTypeId)}. Usable area: exactly ${input.areaSqm} square metres.`,
      `Creative direction supplied by the player (controls style, lighting, furnishings and special elements): ${input.stylePrompt}`,
      "All four panels depict the same physically consistent functional area: preserve architecture, layout, furnishing selection, materials, lighting and styling across the sheet. Show four complementary eye-level views that clearly communicate the area and how guests use it. No people, no text and no logos.",
    ].join("\n");
  }
  const selectedFurniture = input.furniture.map((item) => {
    const details = [item.material && `material: ${item.material}`, item.style && `style: ${item.style}`].filter(Boolean).join(", ");
    return `${furniture.get(item.id)}${details ? ` (${details})` : " (choose material and style randomly, while keeping the room coherent)"}`;
  }).join("; ") || "Keep furnishings minimal and let the model choose coherent supporting pieces.";
  return [
    "Create one polished, photorealistic hotel-room blueprint contact sheet. Show exactly four equal panels arranged in 2 columns by 2 rows with thin quiet gutters. Keep each panel composed safely for a wide landscape crop.",
    `Room type: ${roomTypes.get(input.roomTypeId)}. Bed type: ${bedTypes.get(input.bedTypeId)}. Usable area: exactly ${input.areaSqm} square metres.`,
    `Furniture and per-item directions: ${selectedFurniture}.`,
    `Overall direction (controls the design style, lighting, and special elements): ${input.stylePrompt}`,
    "Treat stated furniture material and style as higher priority than the overall direction. All four panels depict the same physically consistent room: preserve architecture, bed configuration, window placement, furniture, materials, lighting and styling across the sheet. The views are: entry toward bed, window-side seating, bed-facing detail, and the reverse view toward entry. No people, no text and no logos. Compose believable eye-level interiors.",
  ].join("\n");
}

function findImage(payload) {
  const image = payload?.data?.[0] ?? payload?.data?.data?.[0];
  if (!image || typeof image.b64_json !== "string") return null;
  const header = Buffer.from(image.b64_json.slice(0, 24), "base64");
  const mimeType = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP"
      ? "image/webp"
      : "image/jpeg";
  return { base64: image.b64_json, mimeType };
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
  const endpoint = new URL("v1/images/generations", origin);
  if (endpoint.origin !== origin.origin) throw new Error("provider_origin");
  const upstream = await fetchImplementation(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(input),
      size: "2048x1024",
      quality: "high",
      response_format: "b64_json",
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

async function generateMultiAngleBlueprint(input, options) {
  return callImageModel(input, options);
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
  const model = environment.CLOUD_INN_IMAGE_MODEL ?? "gpt-image-2.5";
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
      const image = await generateMultiAngleBlueprint(input, { apiKey, model, providerOrigin, fetchImplementation });
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
import sharp from "sharp";
