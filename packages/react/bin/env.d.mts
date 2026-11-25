export type Framework = "next" | "vite";
export declare const FRAMEWORKS: Record<Framework, { name: string; access: "process.env" | "import.meta.env"; prefix: string }>;
export declare const ENV_FILES: string[];

export interface AppEnvironment {
  root: string;
  framework: Framework | null;
  workspace: { root: string; name: string; label: string } | null;
  projectName: string;
  envDir: string;
  envFile: string | null;
  /** The app loads `.env` files from outside its own folder. */
  sharedEnv: boolean;
  variable: string | null;
  access: "process.env" | "import.meta.env" | null;
  customPrefix?: boolean;
  problem: string | null;
}

export interface EnvPlan {
  name: string;
  value: string;
  file: string;
  original: string | null;
  source: string;
  changed: boolean;
  example: { file: string; original: string | null; source: string } | null;
}

export declare function detectFramework(root: string): Framework | null;
export declare function workspacePatterns(dir: string): string[] | null;
export declare function workspaceMembers(workspaceRoot: string, patterns?: string[]): string[];
export declare function findWorkspace(root: string): { root: string; patterns: string[] } | null;
export declare function describeApp(root: string, options?: { envFile?: string | null }): AppEnvironment;
export declare function envVariableOf(text: string | undefined, app: AppEnvironment): string | null;
export declare function envFiles(app: AppEnvironment): string[];
export declare function readEnvValue(app: AppEnvironment, name: string): { value: string; file: string } | null;
export declare function planEnv(app: AppEnvironment, name: string, value: string): EnvPlan;
export declare function checkWritable(file: string): void;
export declare function applyEnv(plan: EnvPlan): { example: string | null };
export declare function gitIgnored(file: string): boolean | null;
