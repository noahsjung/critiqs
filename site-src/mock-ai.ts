// A stand-in for Critiqs AI while recording the Mockup clip: an
// OpenAI-compatible endpoint that answers Mockup requests with scripted
// changes instead of calling a model. The local backend points at it with
// CRITIQS_MANAGED_AI_PROVIDER=compatible and _BASE_URL=http://127.0.0.1:4812/v1.
import { mkdirSync, writeFileSync } from "node:fs";
import { answer } from "./mock-answers.ts";

const logDir = new URL("../.local/site-src-data/mock-ai/", import.meta.url).pathname;
mkdirSync(logDir, { recursive: true });
let n = 0;

Bun.serve({
  port: 4812,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "critiqs-demo" }] });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("Not found", { status: 404 });
    const body = await request.json();
    const prompt = body.messages.map((m: { role: string; content: unknown }) => `## ${m.role}\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
    writeFileSync(`${logDir}request-${++n}.txt`, prompt);
    const content = JSON.stringify(answer(prompt));
    await Bun.sleep(3200); // long enough to show Critiqs AI's progress
    return Response.json({
      id: `demo-${n}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
    });
  },
});
console.log("Mock Critiqs AI on http://127.0.0.1:4812/v1");
