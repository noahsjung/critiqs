// Every acceptance case for Critiqs on the page, in one command: the
// checklist (A1 to A7, A9, A10), the strict and hostile pages, the worker and
// injection (A8, A11, A12), each in real Chrome, and the documents (A13).
// Results go to CRITIQS_EVIDENCE_DIR/checklist, /overlay and /documents.txt;
// a summary prints at the end. Exits with 1 when anything fails.
//
//   CRITIQS_BACKEND=http://127.0.0.1:3210 bun run check:acceptance
//
// Settings are the two scripts' (see checklist.ts and check-overlay.ts).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.CRITIQS_EVIDENCE_DIR ?? join(process.env.TMPDIR ?? "/tmp", `critiqs-acceptance-${Date.now()}`);
await mkdir(evidence, { recursive: true });

const summary: string[] = [];
let failed = false;
for (const [name, command] of [
  ["checklist", ["bun", "scripts/checklist.ts"]],
  ["overlay", ["bun", "scripts/check-overlay.ts"]],
] as const) {
  const child = Bun.spawn([...command], { cwd: here, env: { ...process.env, CRITIQS_EVIDENCE_DIR: join(evidence, name) }, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  failed ||= code !== 0;
  const results = await Bun.file(join(evidence, name, "results.md")).text().catch(() => "");
  summary.push(`${name}: ${/^Result: .*$/m.exec(results)?.[0] ?? `no results (exit ${code})`}`);
}
const documents = Bun.spawn(["bun", "test", "./test/documents.acceptance.ts"], { cwd: here, stdout: "pipe", stderr: "pipe" });
const output = (await new Response(documents.stdout).text()) + (await new Response(documents.stderr).text());
const documentsCode = await documents.exited;
failed ||= documentsCode !== 0;
await Bun.write(join(evidence, "documents.txt"), output);
summary.push(`documents (A13): ${output.split("\n").filter((line) => /^\((pass|fail)\) A13/.test(line.trim())).map((line) => line.trim().replace(/ \[.*$/, "")).join("; ")}`);
console.log(`\n${summary.join("\n")}\nEvidence: ${evidence}`);
process.exit(failed ? 1 : 0);
