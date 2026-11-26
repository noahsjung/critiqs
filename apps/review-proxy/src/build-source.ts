import type { ReviewDirectory } from "./directory.ts";

// Where a shared build's files come from: the backend that holds them, and
// nowhere else. The proxy asks the backend which file a request is on every
// request (so a deleted or expired build stops at once), then reads the
// file's bytes, by their SHA-256, from a cache or from the backend. Nothing
// here can open a connection to any other address: there is no egress.

export interface BuildFile {
  status: 200 | 404;
  contentType: string;
  sha256: string;
  body: Uint8Array<ArrayBuffer>;
}

export interface BuildSource {
  /** The file a frame host's path stands for now, or null when the host serves nothing or no file matches. */
  file(label: string, path: string, signal?: AbortSignal): Promise<BuildFile | null>;
}

/**
 * A build source over the backend's directory, keeping up to `maxBytes` of
 * file bodies by SHA-256. A body is reused only after the backend has said,
 * for this request, that this host's build holds a file with that SHA-256.
 */
export function buildSource(directory: Pick<ReviewDirectory, "buildFile" | "buildBlob">, options: { maxBytes?: number } = {}): BuildSource {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const bodies = new Map<string, Uint8Array<ArrayBuffer>>();
  let held = 0;
  const keep = (sha256: string, body: Uint8Array<ArrayBuffer>) => {
    if (body.byteLength > maxBytes) return;
    bodies.delete(sha256);
    bodies.set(sha256, body);
    held += body.byteLength;
    for (const [key, value] of bodies) {
      if (held <= maxBytes) break;
      bodies.delete(key);
      held -= value.byteLength;
    }
  };
  return {
    async file(label, path, signal) {
      const answer = await directory.buildFile(label, path, signal);
      if (answer === null) return null;
      let body = bodies.get(answer.sha256) ?? null;
      if (body !== null) {
        // Most recently used last.
        bodies.delete(answer.sha256);
        bodies.set(answer.sha256, body);
      } else {
        body = await directory.buildBlob(label, answer.sha256, signal);
        if (body === null || body.byteLength !== answer.size) return null;
        keep(answer.sha256, body);
      }
      return { status: answer.status, contentType: answer.contentType, sha256: answer.sha256, body };
    },
  };
}
