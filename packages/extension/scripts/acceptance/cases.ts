// The acceptance contract's cases, each named by its number (A4.3), ending
// pass, fail, "not run" with the reason, or "not automatable" with the reason
// (a person's case, kept in MANUAL_TEST.md). Results go to results.md and
// results.json with a screenshot per case. CRITIQS_CASES picks some cases
// (comma-separated numbers or prefixes, such as `A4.3,A8`).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "./browser.ts";
import { Missing } from "./overlay.ts";

export type Outcome = "pass" | "fail" | "not run" | "not automatable";
export interface Result {
  id: string;
  check: string;
  outcome: Outcome;
  measured: string;
  ms: number;
  shots: string[];
}

/** Ends a case as not run, with the reason. */
export class NotRun extends Error {}
/** Ends a case as a person's, with the reason. */
export class NotAutomatable extends Error {}

const picked = (process.env.CRITIQS_CASES ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean);
export const selected = (id: string) => picked.length === 0 || picked.some((prefix) => id === prefix || id.startsWith(`${prefix}.`) || (prefix.endsWith(".") && id.startsWith(prefix)));

export class Run {
  readonly results: Result[] = [];
  #shots = 0;
  /** The page screenshots show; cases set it as they move between tabs. */
  page: Page | null = null;

  constructor(
    readonly title: string,
    readonly evidence: string,
  ) {}

  async start() {
    await mkdir(join(this.evidence, "shots"), { recursive: true });
  }

  async shoot(name: string, shots: string[], page = this.page) {
    if (page === null || page.isClosed?.()) return;
    const file = `shots/${String(++this.#shots).padStart(2, "0")}-${name.replace(/[^\w.-]+/g, "-")}.png`;
    await page.screenshot({ path: join(this.evidence, file) }).then(
      () => shots.push(file),
      () => undefined,
    );
  }

  /** Runs one case when selected. `run` returns what was measured; Missing, or any other thrown error, fails it. */
  async case(id: string, check: string, run: (shots: string[]) => Promise<string>) {
    if (!selected(id)) return;
    const shots: string[] = [];
    const started = Date.now();
    let outcome: Outcome = "pass";
    let measured: string;
    try {
      measured = await run(shots);
      await this.shoot(id, shots);
    } catch (error) {
      outcome = error instanceof NotRun ? "not run" : error instanceof NotAutomatable ? "not automatable" : "fail";
      measured = error instanceof Error ? (error instanceof Missing || error instanceof NotRun || error instanceof NotAutomatable ? error.message : `${error.message}`) : String(error);
      if (outcome === "fail") await this.shoot(`${id}-failed`, shots);
    }
    const result: Result = { id, check, outcome, measured, ms: Date.now() - started, shots };
    this.results.push(result);
    console.log(`${outcome.toUpperCase().padEnd(16)} ${id.padEnd(6)} ${check} (${(result.ms / 1000).toFixed(1)} s)\n${" ".repeat(23)}${measured.slice(0, 600)}`);
  }

  /** A person's case: listed with why a script can't do it. */
  async person(id: string, check: string, why: string) {
    await this.case(id, check, async () => {
      throw new NotAutomatable(why);
    });
  }

  counts() {
    const count = (outcome: Outcome) => this.results.filter((result) => result.outcome === outcome).length;
    return { pass: count("pass"), fail: count("fail"), "not run": count("not run"), "not automatable": count("not automatable") };
  }

  async write(header: string[]) {
    const order = (id: string) => id.replace(/^A/, "").split(".").map((part) => part.padStart(3, "0")).join(".");
    const sorted = [...this.results].sort((a, b) => order(a.id).localeCompare(order(b.id)));
    const counts = this.counts();
    const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const report = [
      `# ${this.title}`,
      "",
      ...header,
      picked.length > 0 ? `Cases picked with CRITIQS_CASES: ${picked.join(", ")}.` : "",
      `Result: ${counts.pass} pass, ${counts.fail} fail, ${counts["not run"]} not run, ${counts["not automatable"]} not automatable.`,
      "",
      "| Case | Check | Result | Measured | Screenshots |",
      "| --- | --- | --- | --- | --- |",
      ...sorted.map((result) => `| ${result.id} | ${cell(result.check)} | ${result.outcome} | ${cell(result.measured)} | ${result.shots.map((shot, index) => `[${index + 1}](${shot})`).join(" ")} |`),
      "",
    ].join("\n");
    await Bun.write(join(this.evidence, "results.md"), report);
    await Bun.write(join(this.evidence, "results.json"), `${JSON.stringify({ title: this.title, header, results: sorted }, null, 2)}\n`);
    console.log(`\n${counts.pass} pass, ${counts.fail} fail, ${counts["not run"]} not run, ${counts["not automatable"]} not automatable. Results: ${join(this.evidence, "results.md")}`);
  }
}
