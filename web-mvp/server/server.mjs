import { createServer } from "node:http";
import { createGenerateHandler } from "../api/_image-generation.js";
import { createLegendGiftHandler } from "../api/_legend-gift.js";

const port = Number(process.env.CLOUD_INN_PROXY_PORT ?? 8787);
const imageHandler = createGenerateHandler();
const legendGiftHandler = createLegendGiftHandler();

createServer((request, response) => request.url?.startsWith("/api/legend-gift") ? legendGiftHandler(request, response) : imageHandler(request, response)).listen(port, () => console.log(`Cloud Inn API proxy listening on http://localhost:${port}`));
