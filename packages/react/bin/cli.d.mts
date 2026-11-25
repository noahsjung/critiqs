export declare const USAGE: string;
export interface CommandOptions {
  command: "init" | "doctor" | "mcp" | null;
  projectId: string | null;
  dir: string;
  dryRun: boolean;
  /** "cloud", "own-convex", or a backend URL. */
  target: string | null;
  name: string | null;
  reviewUrl: string | null;
  help: boolean;
  entry: string | null;
  mount: string | null;
  signIn: "remote" | "browser" | null;
  newProject: boolean;
  json: boolean;
  /** The .env file to set an environment-backed project ID in, relative to `dir`. */
  envFile: string | null;
}
export declare function parseCommand(argv: string[]): CommandOptions | { error: string };
export declare function runCli(argv: string[], options?: { cwd?: string; print?: (message: string) => void }): Promise<number>;
