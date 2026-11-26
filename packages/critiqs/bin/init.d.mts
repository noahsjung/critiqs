export interface InitOptions {
  help: boolean;
  command: string | null;
  projectId: string | null;
  dir: string;
  entry: string | null;
  mount: string | null;
  envFile: string | null;
  dryRun: boolean;
}

export declare const PROJECT_ID_PATTERN: RegExp;
export declare const HELP: string;
export declare function isValidProjectId(id: string): boolean;
export declare function parseArguments(argv: string[]): InitOptions | { error: string };
export declare function runInit(argv: string[], options?: { cwd?: string; print?: (message: string) => void; env?: Record<string, string | undefined> }): number;
