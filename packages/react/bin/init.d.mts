export declare const PROJECT_ID_PATTERN: RegExp;
export declare const SOURCE_EXTENSIONS: ReadonlySet<string>;
export declare const IGNORED_DIRECTORIES: ReadonlySet<string>;
export declare const HELP: string;
import type { AppEnvironment } from "./env.mjs";

/** A property as init writes it: a string literal, code such as `import.meta.env.VITE_…`, or `true` for a bare attribute. */
export type PropValue = string | { expression: string } | true;
export type Props = Record<string, PropValue>;

export type Wiring =
  | { mode: "literal"; app: AppEnvironment; problem?: undefined }
  | { mode: "env"; app: AppEnvironment; variable?: string; addFlag?: boolean; problem: string | null };

export interface JsxAttribute {
  name: string;
  start: number;
  nameEnd: number;
  /** null for a bare attribute such as `<Critiqs projectId />`. */
  value: { kind: "string" | "expression" | "element"; start: number; end: number } | null;
}

export interface JsxElement {
  /** Index of `<`. */
  start: number;
  /** Index right after the tag name. */
  nameEnd: number;
  /** Index right after the opening element's `>`. */
  end: number;
  line: number;
  attributes: JsxAttribute[];
  /** Index right after the last spread prop such as `{...props}`, or null when there is none. */
  spreadEnd: number | null;
}

export type ProjectIdPlan =
  | { action: "insert" | "replace"; source: string; line: number }
  | { action: "unchanged" | "expression" | "spread"; line: number };

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

/** Any JSX element, with where its children close (`close` is null for `<X />`). */
export interface AnyJsxElement {
  name: string;
  start: number;
  openEnd: number;
  end: number;
  /** How many elements enclose it. */
  depth: number;
  close: { start: number; end: number } | null;
}

export type MountKind = "next-app" | "next-pages" | "react-root" | "chosen";
export declare const MOUNT_KINDS: Record<MountKind, string>;
export interface MountPoint {
  kind: MountKind;
  element: AnyJsxElement;
  line: number;
}

export type ComponentPlan =
  | {
      ok: true;
      action: "install" | "update" | "unchanged";
      file: string;
      original: string;
      source: string;
      line: number;
      changed: string[];
      kind?: MountKind;
      imported?: boolean;
      preview?: string[];
    }
  | { ok: false; reason: string; [detail: string]: unknown };

export declare function isValidProjectId(id: string): boolean;
export declare function findSourceFiles(root: string): string[];
export declare function scanSource(
  source: string,
  options?: { jsx?: boolean; tagName?: string },
): { elements: JsxElement[]; all: AnyJsxElement[]; comments: [number, number][]; literals: [number, number][] };
export declare function lineAt(source: string, index: number): number;
/** `excluded` ranges (comments and strings) default to those found by `scanSource`. */
export declare function importsCritiqs(source: string, excluded?: [number, number][]): boolean;
export declare function findCritiqsElements(source: string, options?: { jsx?: boolean }): JsxElement[];
export declare function planProp(source: string, element: JsxElement, name: string, value: PropValue): ProjectIdPlan;
export declare function planProjectId(source: string, element: JsxElement, projectId: string): ProjectIdPlan;
export declare function readProp(
  source: string,
  element: JsxElement,
  name: string,
): { kind: "literal"; value: string } | { kind: "expression"; text?: string } | null;
export declare function findCritiqsUsages(root: string): { file: string; source: string; element: JsxElement }[];
export declare function parseArguments(argv: string[]): InitOptions | { error: string };
export declare function runInit(argv: string[], options?: { cwd?: string; print?: (message: string) => void }): number;
export declare function mountPointsIn(source: string, path: string, options?: { mount?: string | null; explicit?: boolean }): MountPoint[];
export declare function findMountPoints(
  root: string,
  options?: { entry?: string | null; mount?: string | null },
): (MountPoint & { file: string; source: string })[];
export declare function changedLines(before: string, after: string): string[];
export declare function propsText(props: Props): string;
export declare function planInstall(root: string, props: Props, options?: { entry?: string | null; mount?: string | null }): ComponentPlan;
export declare function planComponent(root: string, props: Props, options?: { entry?: string | null; mount?: string | null }): ComponentPlan;
export declare function applyPlan(plan: ComponentPlan): void;
export declare function manualInstructions(props: Props): string;
export declare function refusal(
  plan: ComponentPlan & { ok: false },
  props: Props,
  where: (file: string, line: number) => string,
  folder: string,
): string;
export declare function chooseWiring(root: string, options?: { envFile?: string | null }): Wiring;
export declare function connectionProps(wiring: Wiring, projectId: string, backend?: string | null): Props;
export declare function deploymentAdvice(wiring: Wiring): string;
export declare function workspaceApps(root: string): string[] | null;
export declare function workspaceRefusal(apps: string[], folder: string, show: (dir: string) => string, command: string): string;
