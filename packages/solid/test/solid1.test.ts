import { mock } from "bun:test";
import * as Solid from "solid-js-1";
import { critiqsSuite } from "./suite.ts";

mock.module("solid-js", () => Solid);
critiqsSuite("Solid 1.9", Solid as never);
