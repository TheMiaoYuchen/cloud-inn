const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_PRODUCTION_ORIGIN = "https://cloud-inn-test.zhong2.xyz";
const BODY_LIMIT = 1024;
const RESPONSE_LIMIT = 48 * 1024;
const REQUEST_TIMEOUT_MS = 35_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;

const roomTypes = new Set(["single", "suite"]);
const bedTypes = new Set(["queen", "twin"]);
const zoneTypes = new Set(["lobby", "dining", "meeting-room", "gift-shop", "pool", "fitness", "spa"]);
const furnitureTypes = new Set(["lounge-chair", "side-table", "reading-lamp", "floor-rug", "work-desk", "mini-bar", "lounge-sofa", "coffee-table", "wardrobe", "console", "floor-lamp", "indoor-plant"]);

function allowedOrigins(environment) {
  const configured = environment.CLOUD_INN_ALLOWED_ORIGIN;
  return new Set((configured ? configured.split(",") : [...LOCAL_ORIGINS, DEFAULT_PRODUCTION_ORIGIN]).map((origin) => origin.trim()).filter(Boolean));
}
function send(response, status, payload, origin) {
  response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
  if (origin) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
  if (typeof response.status === "function" && typeof response.json === "function") { response.status(status).json(payload); return; }
  response.statusCode = status; response.end(JSON.stringify(payload));
}
function problem(response, status, code, message, origin) { send(response, status, { error: { code, message } }, origin); }
function readBody(request) {
  if (request.body && typeof request.body === "object") return Promise.resolve(request.body);
  if (typeof request.body === "string") { if (Buffer.byteLength(request.body) > BODY_LIMIT) return Promise.reject(new Error("too_large")); try { return Promise.resolve(JSON.parse(request.body)); } catch { return Promise.reject(new Error("invalid_json")); } }
  return new Promise((resolve, reject) => {
    let byteLength = 0; let raw = ""; request.setEncoding("utf8");
    request.on("data", (chunk) => { byteLength += Buffer.byteLength(chunk); if (byteLength > BODY_LIMIT) { reject(new Error("too_large")); request.destroy(); return; } raw += chunk; });
    request.on("end", () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error("invalid_json")); } }); request.on("error", reject);
  });
}
function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const blueprintCount = Number(value.blueprintCount);
  if (!Number.isInteger(blueprintCount) || blueprintCount < 0 || blueprintCount > 999) return null;
  return { blueprintCount };
}
function text(value, limit) { return typeof value === "string" && value.trim() && [...value.trim()].length <= limit ? value.trim() : null; }
function validateGift(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const guest = value.guest; const gift = value.gift;
  if (!guest || typeof guest !== "object" || !gift || typeof gift !== "object") return null;
  const guestName = text(guest.name, 40); const guestTitle = text(guest.title, 60); const stayStory = text(guest.stayStory, 360); const note = text(guest.note, 240);
  const name = text(gift.name, 40); const stylePrompt = text(gift.stylePrompt, 600); const areaSqm = Number(gift.areaSqm);
  if (!guestName || !guestTitle || !stayStory || !note || !name || !stylePrompt || !Number.isInteger(areaSqm) || areaSqm < 8 || areaSqm > 600) return null;
  const designKind = gift.designKind === "zone" ? "zone" : gift.designKind === "room" ? "room" : null;
  if (!designKind || !roomTypes.has(gift.roomTypeId) || !bedTypes.has(gift.bedTypeId)) return null;
  if (designKind === "zone" && !zoneTypes.has(gift.zoneTypeId)) return null;
  const furniture = Array.isArray(gift.furniture) ? gift.furniture.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== "object" || !furnitureTypes.has(item.id)) return [];
    const material = typeof item.material === "string" ? item.material.trim().slice(0, 80) : "";
    const style = typeof item.style === "string" ? item.style.trim().slice(0, 80) : "";
    return [{ id: item.id, material, style }];
  }) : [];
  return { guest: { guestName, guestTitle, stayStory, note }, gift: { name, designKind, roomTypeId: gift.roomTypeId, bedTypeId: gift.bedTypeId, zoneTypeId: designKind === "zone" ? gift.zoneTypeId : undefined, areaSqm, furniture, stylePrompt } };
}
function promptFor({ blueprintCount }) {
  return [
    "You create one rare, warm, collectible gift for a calm AI-driven high-rise hotel design game. Return JSON only; no markdown.",
    "The player owns " + blueprintCount + " normal blueprints. A rare guest has just checked in and leaves exactly one limited gift: either a buildable hotel room or a functional area. It must feel architecturally plausible and emotionally memorable, never be a brand reference, famous person, or copyrighted fictional property.",
    "Use this exact JSON schema: {\\\"guest\\\":{\\\"name\\\":string,\\\"title\\\":string,\\\"stayStory\\\":string,\\\"note\\\":string},\\\"gift\\\":{\\\"name\\\":string,\\\"designKind\\\":\\\"room\\\"|\\\"zone\\\",\\\"roomTypeId\\\":\\\"single\\\"|\\\"suite\\\",\\\"bedTypeId\\\":\\\"queen\\\"|\\\"twin\\\",\\\"zoneTypeId\\\":\\\"lobby\\\"|\\\"dining\\\"|\\\"meeting-room\\\"|\\\"gift-shop\\\"|\\\"pool\\\"|\\\"fitness\\\"|\\\"spa\\\",\\\"areaSqm\\\":integer 8-600,\\\"furniture\\\":[{\\\"id\\\": one of lounge-chair,side-table,reading-lamp,floor-rug,work-desk,mini-bar,lounge-sofa,coffee-table,wardrobe,console,floor-lamp,indoor-plant,\\\"material\\\":string,\\\"style\\\":string}],\\\"stylePrompt\\\":string}. For a room, zoneTypeId may be omitted. Write every value in concise, evocative Chinese. stylePrompt must direct an image model on atmosphere, materials, lighting, furnishing and one unforgettable special element. Keep the gift original and buildable.",
  ].join("\\n");
}
function clientAddress(request) { const forwarded = request.headers["x-forwarded-for"]; return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : request.socket?.remoteAddress ?? "unknown"; }
function allowRequest(request, calls, now) { const address = clientAddress(request); const recent = (calls.get(address) ?? []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS); if (recent.length >= RATE_LIMIT_MAX) return false; recent.push(now); calls.set(address, recent); return true; }
async function responseJson(upstream) {
  const contentLength = Number(upstream.headers.get("content-length") ?? 0); if (contentLength > RESPONSE_LIMIT) throw new Error("provider_response");
  const raw = await upstream.text(); if (Buffer.byteLength(raw) > RESPONSE_LIMIT) throw new Error("provider_response");
  try { return JSON.parse(raw); } catch { throw new Error("provider_response"); }
}
function contentFrom(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  return null;
}
async function callTextModel(input, { apiKey, model, providerOrigin, fetchImplementation }) {
  const base = new URL(providerOrigin.endsWith("/") ? providerOrigin : `${providerOrigin}/`);
  const endpoint = new URL("chat/completions", base);
  if (endpoint.origin !== base.origin) throw new Error("provider_origin");
  const upstream = await fetchImplementation(endpoint, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, temperature: 1, response_format: { type: "json_object" }, messages: [{ role: "user", content: promptFor(input) }] }), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!upstream.ok) throw new Error("provider_failed");
  const content = contentFrom(await responseJson(upstream)); if (!content) throw new Error("provider_response");
  try { return validateGift(JSON.parse(content)); } catch { return null; }
}
export function createLegendGiftHandler({ environment = process.env, fetchImplementation = fetch, now = () => Date.now() } = {}) {
  const calls = new Map(); const permittedOrigins = allowedOrigins(environment); const model = environment.CLOUD_INN_TEXT_MODEL ?? "gpt-5.6-luna"; const providerOrigin = environment.CLOUD_INN_TEXT_API_ORIGIN ?? "https://apinebula.ai/v1/"; const apiKey = environment.CLOUD_INN_TEXT_API_KEY;
  return async function legendGiftHandler(request, response) {
    const origin = request.headers.origin; const corsOrigin = origin && permittedOrigins.has(origin) ? origin : undefined;
    if (request.method === "OPTIONS" && request.url?.startsWith("/api/legend-gift") && corsOrigin) { response.setHeader("access-control-allow-origin", corsOrigin); response.setHeader("access-control-allow-methods", "POST, OPTIONS"); response.setHeader("access-control-allow-headers", "content-type"); response.setHeader("vary", "Origin"); if (typeof response.status === "function") response.status(204).end(); else { response.statusCode = 204; response.end(); } return; }
    if (!request.url?.startsWith("/api/legend-gift")) { problem(response, 404, "NOT_FOUND", "接口不存在。", corsOrigin); return; }
    if (request.method !== "POST") { problem(response, 405, "METHOD_NOT_ALLOWED", "只支持 POST 请求。", corsOrigin); return; }
    if (!corsOrigin) { problem(response, 403, "ORIGIN_DENIED", "请求来源不被允许。"); return; }
    if (!allowRequest(request, calls, now())) { problem(response, 429, "RATE_LIMITED", "传说客人稍后才会再次出现。", corsOrigin); return; }
    if (!apiKey) { problem(response, 503, "TEXT_NOT_CONFIGURED", "云端赠礼尚未配置文字模型密钥。", corsOrigin); return; }
    try {
      const input = validateRequest(await readBody(request)); if (!input) { problem(response, 400, "INVALID_REQUEST", "来访资料不正确。", corsOrigin); return; }
      const result = await callTextModel(input, { apiKey, model, providerOrigin, fetchImplementation }); if (!result) { problem(response, 502, "TEXT_GENERATION_FAILED", "传说客人留下的信笺无法辨认，请稍后再试。", corsOrigin); return; }
      send(response, 200, { guest: { name: result.guest.guestName, title: result.guest.guestTitle, stayStory: result.guest.stayStory, note: result.guest.note }, gift: result.gift, model }, corsOrigin);
    } catch (error) { const code = error instanceof Error ? error.message : "unknown"; problem(response, code === "too_large" || code === "invalid_json" ? 400 : 502, code === "too_large" || code === "invalid_json" ? "INVALID_REQUEST" : "TEXT_GENERATION_FAILED", code === "too_large" || code === "invalid_json" ? "来访资料不正确。" : "文字模型暂时无法回应，请稍后再试。", corsOrigin); }
  };
}
export const internal = { validateGift, promptFor, contentFrom };
