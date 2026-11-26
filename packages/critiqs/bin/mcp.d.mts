export interface ToolResult {
  /** Text, and for critiqs_screenshot an image (base64 `data` and its `mimeType`). */
  content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
  /** The same result as data, for agents that read it. */
  structuredContent?: Record<string, unknown>;
}
export declare const TOOLS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}[];
export declare function createTools(options?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  open?: (url: string) => void;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): { call(name: string, args?: Record<string, unknown>): Promise<ToolResult>; close(): void };
export declare function handleMessage(
  message: unknown,
  tools: { call(name: string, args?: Record<string, unknown>): Promise<ToolResult> },
  version: string,
): Promise<Record<string, unknown> | null>;
export declare function serveMcp(options?: { cwd?: string; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): Promise<void>;
