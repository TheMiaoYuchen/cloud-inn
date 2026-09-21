import assert from "node:assert/strict";
import test from "node:test";
import { createGenerateHandler } from "./_image-generation.js";

const origin = "https://cloud-inn-test.zhong2.xyz";
const validBody = { roomTypeId: "single", bedTypeId: "queen", furniture: [{ id: "lounge-chair", material: "藤编", style: "低矮" }, { id: "reading-lamp", material: "", style: "" }], areaSqm: 36, stylePrompt: "设计风格：安静温暖的海边客房。光照：午后自然光。特殊元素：可见海面。" };

function responseSpy() {
  return {
    headers: {}, statusCode: 200, payload: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; },
    end() {},
  };
}

function request(body = validBody, requestOrigin = origin) {
  return { method: "POST", url: "/api/generate", body, headers: { origin: requestOrigin, "x-forwarded-for": "203.0.113.42" } };
}

test("requests one native 2:1 four-view blueprint from the Images API", async () => {
  const upstreamRequests = [];
  const handler = createGenerateHandler({
    environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin, CLOUD_INN_IMAGE_API_ORIGIN: "https://image.example/", CLOUD_INN_IMAGE_MODEL: "gpt-image-2.5" },
    fetchImplementation: async (url, options) => {
      upstreamRequests.push({ url: String(url), options });
      return new Response(JSON.stringify({ data: { data: [{ b64_json: "aW1hZ2U=" }] } }), { status: 200 });
    },
  });
  const response = responseSpy();
  await handler(request(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.model, "gpt-image-2.5");
  assert.equal(response.payload.image.mimeType, "image/jpeg");
  assert.equal(response.payload.image.base64, "aW1hZ2U=");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "https://image.example/v1/images/generations");
  assert.equal(upstreamRequests[0].options.headers.authorization, "Bearer test-only-key");
  const providerBody = JSON.parse(upstreamRequests[0].options.body);
  assert.equal(providerBody.model, "gpt-image-2.5");
  assert.equal(providerBody.size, "2048x1024");
  assert.equal(providerBody.quality, "high");
  assert.equal(providerBody.response_format, "b64_json");
  assert.match(providerBody.prompt, /lounge chair/);
  assert.match(providerBody.prompt, /material: 藤编/);
  assert.match(providerBody.prompt, /choose material and style randomly/);
  assert.match(providerBody.prompt, /exactly 36 square metres/);
  assert.match(providerBody.prompt, /exactly four equal panels/);
});

test("does not call the provider without a server-side key", async () => {
  const handler = createGenerateHandler({ environment: { CLOUD_INN_ALLOWED_ORIGIN: origin }, fetchImplementation: () => { throw new Error("must not be called"); } });
  const response = responseSpy();
  await handler(request(), response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error.code, "GENERATION_NOT_CONFIGURED");
});

test("accepts one functional-area request and sends its area brief", async () => {
  const upstreamRequests = [];
  const handler = createGenerateHandler({
    environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin, CLOUD_INN_IMAGE_API_ORIGIN: "https://image.example/" },
    fetchImplementation: async (_url, options) => {
      upstreamRequests.push(options);
      return new Response(JSON.stringify({ data: { data: [{ b64_json: "aW1hZ2U=" }] } }), { status: 200 });
    },
  });
  const response = responseSpy();
  await handler(request({ designKind: "zone", zoneTypeId: "spa", areaSqm: 140, stylePrompt: "低照度石材水疗，蒸汽与香气。" }), response);
  assert.equal(response.statusCode, 200);
  const providerBody = JSON.parse(upstreamRequests[0].body);
  assert.match(providerBody.prompt, /hotel spa/);
  assert.match(providerBody.prompt, /低照度石材水疗/);
  assert.match(providerBody.prompt, /exactly 140 square metres/);
  assert.match(providerBody.prompt, /four complementary eye-level views/);
});

test("rejects a request from an unconfigured origin", async () => {
  const handler = createGenerateHandler({ environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin } });
  const response = responseSpy();
  await handler(request(validBody, "https://other.example"), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.error.code, "ORIGIN_DENIED");
});
