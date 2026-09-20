import { createServer } from "node:http";
import { createGenerateHandler } from "../api/_image-generation.js";

const port = Number(process.env.CLOUD_INN_PROXY_PORT ?? 8787);
const handler = createGenerateHandler();

createServer(handler).listen(port, () => console.log(`Cloud Inn image proxy listening on http://localhost:${port}`));
