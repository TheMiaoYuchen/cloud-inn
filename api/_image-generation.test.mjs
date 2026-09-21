import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
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

test("generates a four-view blueprint through the configured model", async () => {
  const upstreamRequests = [];
  const panel = (await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c9a071" } }).jpeg().toBuffer()).toString("base64");
  const handler = createGenerateHandler({
    environment: { CLOUD_INN_IMAGE_API_KEY: "test-only-key", CLOUD_INN_ALLOWED_ORIGIN: origin, CLOUD_INN_IMAGE_API_ORIGIN: "https://image.example/", CLOUD_INN_IMAGE_MODEL: "one-model" },
    fetchImplementation: async (url, options) => {
      upstreamRequests.push({ url: String(url), options });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: panel } }] } }] }), { status: 200 });
    },
  });
  const response = responseSpy();
  await handler(request(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.model, "one-model");
  assert.equal(response.payload.image.mimeType, "image/jpeg");
  const metadata = await sharp(Buffer.from(response.payload.image.base64, "base64")).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 2048, height: 1024 });
  assert.equal(upstreamRequests.length, 4);
  assert.equal(upstreamRequests[0].url, "https://image.example/v1beta/models/one-model:generateContent");
  assert.equal(upstreamRequests[0].options.headers.authorization, "Bearer test-only-key");
  const providerBody = JSON.parse(upstreamRequests[3].options.body);
  assert.match(providerBody.contents[0].parts[0].text, /橡木床架/);
  assert.equal(providerBody.generationConfig.imageConfig.aspectRatio, "2:1");
  assert.equal(providerBody.contents[0].parts.length, 2);
  assert.match(providerBody.contents[0].parts[0].text, /canonical version/);
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
