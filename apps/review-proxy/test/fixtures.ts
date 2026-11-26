import { execFileSync } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeNetwork, type PublicWeb, type ResolvedAddress } from "@critiqs/server/public-web";

// Test networks. Upstream sites run on 127.0.0.1, which the proxy refuses, so
// tests give names public addresses (from documentation-free public space)
// and route connections for those addresses to local ports. The real pinned
// connector makes every connection; only the destination port is swapped
// after every check has passed. Every resolve and connection is recorded, so
// a test can assert nothing was dialed.

export const PUBLIC_A = "93.184.215.14";
export const PUBLIC_B = "93.184.215.15";
export const PUBLIC_C = "93.184.215.16";

export type Answers = readonly ResolvedAddress[] | ((call: number) => readonly ResolvedAddress[]);

export interface TestWeb extends PublicWeb {
  /** Host names resolved, in order. */
  resolved: string[];
  /** Addresses connected to, in order. */
  connected: string[];
}

export function v4(address: string): ResolvedAddress {
  return { address, family: 4 };
}

export function v6(address: string): ResolvedAddress {
  return { address, family: 6 };
}

/**
 * A network where `names` resolve as given and a connection to an address in
 * `routes` reaches that local port. A connection to any other address fails.
 */
export function testWeb(names: Record<string, Answers>, routes: Record<string, number>, options: { ca?: string } = {}): TestWeb {
  const real = nodeNetwork({ http, https, Resolver }, options.ca === undefined ? {} : { ca: options.ca });
  const calls = new Map<string, number>();
  const resolved: string[] = [];
  const connected: string[] = [];
  return {
    resolved,
    connected,
    async resolve(hostname, signal) {
      signal.throwIfAborted();
      resolved.push(hostname);
      const answers = names[hostname.toLowerCase()];
      if (answers === undefined) return [];
      const call = (calls.get(hostname) ?? 0) + 1;
      calls.set(hostname, call);
      return typeof answers === "function" ? answers(call) : answers;
    },
    async fetchPinned(request) {
      connected.push(request.address.address);
      const port = routes[request.address.address];
      if (port === undefined) throw new Error(`No test route to ${request.address.address}.`);
      const url = new URL(request.url);
      url.port = String(port);
      return await real.fetchPinned({ ...request, url, address: v4("127.0.0.1") });
    },
  };
}

export function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export function close(server: http.Server | https.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A server that records each request and answers with `handler`. */
export function recordingServer(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): { server: http.Server; requests: http.IncomingMessage[] } {
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    handler(request, response);
  });
  return { server, requests };
}

/** A self-signed certificate for `names`, made with openssl for this run; null without openssl. */
export function certificate(names: readonly string[]): { key: Buffer; cert: Buffer } | null {
  const directory = mkdtempSync(join(tmpdir(), "critiqs-proxy-cert-"));
  try {
    const [key, cert] = [join(directory, "key.pem"), join(directory, "cert.pem")];
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`],
      { stdio: "ignore" },
    );
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
  let result = "";
  for await (const chunk of body) result += Buffer.from(chunk).toString("utf8");
  return result;
}

/** Resolves when `server` sees a request's connection close, or rejects after `ms`. */
export function closedWithin(closed: Promise<unknown>, ms: number, what: string): Promise<unknown> {
  return Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} stayed open`)), ms))]);
}
