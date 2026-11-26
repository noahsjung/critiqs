// critiqs/cli's declaration matches what the command line parses, so code that
// compares `command` with any command the CLI runs compiles. `bun run
// typecheck` compiles this file through the package's own export.
import { expect, test } from "bun:test";
import { parseCommand, type CommandOptions } from "critiqs/cli";

type Command = "init" | "doctor" | "mcp" | "sign-in" | "sign-out";
/** `true` only when A and B are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const declared: Same<CommandOptions["command"], Command | null> = true;

test.each<Command>(["init", "doctor", "mcp", "sign-in", "sign-out"])("%s parses as a command the declaration names", (command) => {
  const options = parseCommand([command]);
  if ("error" in options) throw new Error(options.error);
  // Before sign-in and sign-out were declared, these comparisons failed to compile (TS2367).
  const signs = options.command === "sign-in" || options.command === "sign-out";
  expect(signs).toBe(command.startsWith("sign-"));
  expect(options.command).toBe(command);
  expect(declared).toBe(true);
});
