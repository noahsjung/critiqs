// Solid 1.9's server build, as server rendering loads it.
import { mock } from "bun:test";
import { dirname, join } from "node:path";
import { serverSuite } from "./suite.ts";

const solid = await import(join(dirname(Bun.resolveSync("solid-js-1/package.json", import.meta.dir)), "dist/server.js"));
mock.module("solid-js", () => solid);
serverSuite("Solid 1.9", solid);
