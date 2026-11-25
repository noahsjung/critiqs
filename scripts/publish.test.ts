import { expect, test } from "bun:test";
import { publishProblems } from "./publish.ts";

const ready = { name: "critiqs-react", version: "0.3.0", license: "MIT", publishConfig: { access: "public" }, files: ["dist", "LICENSE"] };

test("publishing needs the released version of a public, MIT-licensed package", () => {
  expect(publishProblems(ready, { version: "0.3.0", pendingReleases: 0, published: ["0.2.0"] })).toEqual([]);
  expect(publishProblems({ ...ready, private: true, license: undefined, publishConfig: undefined, files: ["dist"] }, { version: "0.3.0", pendingReleases: 0, published: [] })).toEqual([
    "The package is private.",
    "The package must name its MIT license.",
    'publishConfig.access must be "public".',
    "The package's files must include LICENSE.",
  ]);
});

test("publishing refuses another version, unreleased notes, and a version npm already has", () => {
  expect(publishProblems(ready, { version: "0.4.0", pendingReleases: 0, published: [] })[0]).toContain("is version 0.3.0, not 0.4.0");
  expect(publishProblems(ready, { version: "0.3.0", pendingReleases: 2, published: [] })[0]).toContain("merge the release pull request first");
  expect(publishProblems(ready, { version: "0.3.0", pendingReleases: 0, published: ["0.3.0"] })[0]).toContain("already published");
});
