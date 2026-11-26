#!/usr/bin/env node
// `npx critiqs-react <command>` runs the shared Critiqs setup CLI from the
// critiqs package, the same as `npx critiqs <command>`.
import { runCli } from "critiqs/cli";

process.exitCode = await runCli(process.argv.slice(2));
