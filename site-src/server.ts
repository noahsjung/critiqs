// Local Critiqs backend for recording the landing page's clips: the real
// self-hosted server with a throwaway SQLite file, codes shown on screen, and
// optional AI for Mockup mode (CRITIQS_DEMO_AI_PROVIDER, _MODEL, _KEY from the
// environment, for example through `op run`).
import { mkdirSync } from "node:fs";
import { createCritiqsHandler } from "../packages/server/src/http/index.ts";

const dataDir = new URL("../.local/site-src-data/", import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

const provider = process.env.CRITIQS_DEMO_AI_PROVIDER as "anthropic" | "openai" | "openrouter" | "gateway" | undefined;
const critiqs = await createCritiqsHandler({
  database: `${dataDir}critiqs.sqlite`,
  developmentSignIn: true,
  ai: provider
    ? { provider, model: process.env.CRITIQS_DEMO_AI_MODEL, apiKey: process.env.CRITIQS_DEMO_AI_KEY, timeoutMs: 120_000 }
    : undefined,
});

const server = Bun.serve({
  port: 4810,
  hostname: "127.0.0.1",
  fetch: (request, server) => critiqs.fetch(request, { remoteAddress: server.requestIP(request)?.address }),
});
console.log(`Critiqs demo backend on ${server.url} (AI: ${provider ?? "off"})`);
