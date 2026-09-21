import assert from "node:assert/strict";
import test from "node:test";
import { createLegendGiftHandler } from "./_legend-gift.js";

const origin = "https://cloud-inn-test.zhong2.xyz";
const modelGift = {
  guest: { name: "林雾", title: "收集雨声的旅行者", stayStory: "她在暴雨来临前住进了酒店，把听见的云层低语留在窗边。", note: "愿每一位夜行客，都能在这里听见自己的呼吸。" },
  gift: { name: "雨声书房", designKind: "zone", roomTypeId: "single", bedTypeId: "queen", zoneTypeId: "lobby", areaSqm: 48, furniture: [{ id: "lounge-chair", material: "深色胡桃木", style: "低矮" }], stylePrompt: "设计风格：雨夜中的静谧书房。光照：窗边微光。陈设：旧木、书与雨滴。特殊元素：可聆听云层雨声的玻璃穹顶。" },
};

function responseSpy() { return { headers: {}, statusCode: 200, payload: undefined, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; }, end() {} }; }
function request(body = { blueprintCount: 3 }, requestOrigin = origin) { return { method: "POST", url: "/api/legend-gift", body, headers: { origin: requestOrigin, "x-forwarded-for": "203.0.113.42" } }; }

test("creates a structured limited-gift brief with the separate text API", async () => {
  const calls = [];
  const handler = createLegendGiftHandler({ environment: { CLOUD_INN_TEXT_API_KEY: "test-key", CLOUD_INN_TEXT_API_ORIGIN: "https://text.example/v1", CLOUD_INN_TEXT_MODEL: "gpt-5.6-luna", CLOUD_INN_ALLOWED_ORIGIN: origin }, fetchImplementation: async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelGift) } }] }), { status: 200 }); } });
  const response = responseSpy(); await handler(request(), response);
  assert.equal(response.statusCode, 200); assert.equal(response.payload.model, "gpt-5.6-luna"); assert.equal(response.payload.gift.name, "雨声书房"); assert.equal(response.payload.guest.name, "林雾");
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "https://text.example/v1/chat/completions"); assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  const body = JSON.parse(calls[0].options.body); assert.equal(body.model, "gpt-5.6-luna"); assert.equal(body.response_format.type, "json_object"); assert.match(body.messages[0].content, /rare, warm, collectible gift/);
});

test("does not call the text provider without a server-side key", async () => {
  const handler = createLegendGiftHandler({ environment: { CLOUD_INN_ALLOWED_ORIGIN: origin }, fetchImplementation: () => { throw new Error("must not be called"); } });
  const response = responseSpy(); await handler(request(), response);
  assert.equal(response.statusCode, 503); assert.equal(response.payload.error.code, "TEXT_NOT_CONFIGURED");
});

test("rejects invalid gifts returned by the text provider", async () => {
  const handler = createLegendGiftHandler({ environment: { CLOUD_INN_TEXT_API_KEY: "test-key", CLOUD_INN_ALLOWED_ORIGIN: origin }, fetchImplementation: async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }) });
  const response = responseSpy(); await handler(request(), response);
  assert.equal(response.statusCode, 502); assert.equal(response.payload.error.code, "TEXT_GENERATION_FAILED");
});
