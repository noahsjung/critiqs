// A host app's own server with Critiqs inside it: the prototype's files, and
// Critiqs at /critiqs storing feedback in critiqs.sqlite next to this file.
// The prototype passes backend="/critiqs" to <Critiqs />.
import { createCritiqsHandler } from "critiqs-react/server";

const critiqs = await createCritiqsHandler({
  database: new URL("./critiqs.sqlite", import.meta.url).pathname,
  // With a Resend key, reviewers get sign-in codes and mention emails by email.
  ...(process.env.RESEND_API_KEY && process.env.CRITIQS_EMAIL_FROM
    ? { email: { resendApiKey: process.env.RESEND_API_KEY, from: process.env.CRITIQS_EMAIL_FROM } }
    : { developmentSignIn: true }),
  // Optional AI for tag grouping, search, and insights, from this server's environment;
  // search and grouping work without it. Example: CRITIQS_AI_PROVIDER=compatible,
  // CRITIQS_AI_MODEL=llama3.2, CRITIQS_AI_BASE_URL=http://localhost:11434/v1 for a local Ollama.
  ai: {
    ...(process.env.CRITIQS_AI_PROVIDER && process.env.CRITIQS_AI_MODEL
      ? {
          provider: process.env.CRITIQS_AI_PROVIDER as "openai" | "anthropic" | "google" | "gateway" | "compatible",
          model: process.env.CRITIQS_AI_MODEL,
          apiKey: process.env.CRITIQS_AI_API_KEY,
          baseURL: process.env.CRITIQS_AI_BASE_URL,
        }
      : {}),
    // Lets project owners connect their own provider in Critiqs, with keys stored encrypted.
    encryptionKey: process.env.CRITIQS_AI_ENCRYPTION_KEY,
    allowedEndpoints: process.env.CRITIQS_AI_ALLOWED_ENDPOINTS?.split(",").filter(Boolean),
  },
});

const site = new URL(process.env.STATIC_DIR ?? "../pilot/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: Number(process.env.PORT ?? 4310),
  // This computer only: development sign-in shows codes to anyone who can reach it.
  hostname: "127.0.0.1",
  async fetch(request, server) {
    const { pathname } = new URL(request.url);
    if (pathname === "/critiqs" || pathname.startsWith("/critiqs/")) {
      return critiqs.fetch(request, { remoteAddress: server.requestIP(request)?.address });
    }
    const file = Bun.file(`${site}${pathname === "/" ? "index.html" : pathname.slice(1)}`);
    // The prototype routes in the browser, so unknown paths get its page.
    return new Response((await file.exists()) && !pathname.includes("..") ? file : Bun.file(`${site}index.html`));
  },
});
console.log(`The prototype, with Critiqs self-hosted, is at http://localhost:${server.port}/`);
