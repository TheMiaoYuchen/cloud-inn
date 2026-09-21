import assert from "node:assert/strict";
import test from "node:test";
import { createGenerateHandler } from "./_image-generation.js";

const origin = "https://cloud-inn-test.zhong2.xyz";
const validBody = { templateId: "garden-queen", furnitureIds: ["oak-bed", "paper-lamp"], stylePrompt: "安静而温暖的海边客房" };

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

test("generates one image through the configured model", async () => {
  let upstreamRequest;
  const handler = createGenerateHandler({
    environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin, CLOUD_INN_IMAGE_API_ORIGIN: "https://image.example/", CLOUD_INN_IMAGE_MODEL: "one-model" },
    fetchImplementation: async (url, options) => {
      upstreamRequest = { url: String(url), options };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }] }), { status: 200 });
    },
  });
  const response = responseSpy();
  await handler(request(), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { image: { mimeType: "image/png", base64: "aGVsbG8=" }, model: "one-model" });
  assert.equal(upstreamRequest.url, "https://image.example/v1beta/models/one-model:generateContent");
  assert.equal(upstreamRequest.options.headers.authorization, "Bearer test-only-key");
  const providerBody = JSON.parse(upstreamRequest.options.body);
  assert.match(providerBody.contents[0].parts[0].text, /橡木床架/);
  assert.match(providerBody.contents[0].parts[0].text, /exactly four equal 2:1 landscape panels/);
  assert.equal(providerBody.generationConfig.imageConfig.aspectRatio, "2:1");
});

test("does not call the provider without a server-side key", async () => {
  const handler = createGenerateHandler({ environment: { CLOUD_INN_ALLOWED_ORIGIN: origin }, fetchImplementation: () => { throw new Error("must not be called"); } });
  const response = responseSpy();
  await handler(request(), response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.error.code, "GENERATION_NOT_CONFIGURED");
});

test("rejects a request from an unconfigured origin", async () => {
  const handler = createGenerateHandler({ environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin } });
  const response = responseSpy();
  await handler(request(validBody, "https://other.example"), response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.payload.error.code, "ORIGIN_DENIED");
});
