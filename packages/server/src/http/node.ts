import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { CritiqsHandler } from "./handler.ts";

/**
 * Critiqs's handler as a Node request listener, for `http.createServer` or
 * Express-style apps (`app.use("/critiqs", toNodeListener(critiqs))` works,
 * since Express keeps the full path in `originalUrl`). Never throws: a
 * malformed request gets 400, and a failure 500.
 */
export function toNodeListener(handler: CritiqsHandler) {
  return async (request: IncomingMessage & { originalUrl?: string }, response: ServerResponse) => {
    try {
      let url: URL;
      try {
        const proto = (request.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
        const encrypted = (request.socket as { encrypted?: boolean }).encrypted === true;
        url = new URL(request.originalUrl ?? request.url ?? "/", `${proto === "https" || encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`);
      } catch {
        response.writeHead(400).end("Bad request");
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      // The body streams in, so Critiqs can refuse a large one without holding it in memory.
      const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
      if (hasBody) {
        init.body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const result = await handler.fetch(new Request(url, init), { remoteAddress: request.socket.remoteAddress });
      const outgoing: Record<string, string | string[]> = {};
      result.headers.forEach((value, name) => {
        if (name !== "set-cookie") outgoing[name] = value;
      });
      const cookies = result.headers.getSetCookie();
      if (cookies.length > 0) outgoing["set-cookie"] = cookies;
      response.writeHead(result.status, outgoing);
      response.end(request.method === "HEAD" ? undefined : Buffer.from(await result.arrayBuffer()));
      // Whatever of the body Critiqs didn't read is discarded.
      if (hasBody && !request.readableEnded) request.resume();
    } catch (error) {
      console.error("Critiqs request failed:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  };
}
