// The versions the consumer checks pin for the apps they make and the tools
// they drive, read from the check scripts themselves.
import { expect, test } from "bun:test";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const checks = ["scripts/*.ts", "packages/*/scripts/check-*.ts"].flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root })]).filter((path) => !path.endsWith(".test.ts"));

test("the Nuxt check leaves out only the vue-router release that breaks Nuxt, so it takes the next one by itself", async () => {
  const source = await Bun.file(join(root, "packages/nuxt/scripts/check-consumer.ts")).text();
  // Each assignment's value: a string, or the name of a constant holding one.
  const values = [...source.matchAll(/manifest\.(?:dependencies|overrides)\["vue-router"\] = ([^;]+);/g)].map((match) => match[1]!);
  expect(values.length).toBe(2);
  for (const value of values) {
    const literal = value.startsWith('"') ? value : source.match(new RegExp(`const ${value} = ("[^"]+");`))?.[1];
    expect(literal, value).toBeString();
    const range = JSON.parse(literal!) as string;
    // nuxt 4.7.0 asks for ^5.5.1; 5.5.2 is the broken release.
    expect(["5.5.1", "5.5.3", "5.6.0", "5.10.2"].filter((version) => !Bun.semver.satisfies(version, range))).toEqual([]);
    expect(["5.5.2", "6.0.0", "5.5.0"].filter((version) => Bun.semver.satisfies(version, range))).toEqual([]);
  }
});

test("every check installs Playwright at one exact version", async () => {
  const found: string[] = [];
  for (const path of checks) {
    for (const match of (await Bun.file(join(root, path)).text()).matchAll(/["'`]playwright-core@([^"'`\s]+)["'`]/g)) found.push(`${path}: ${match[1]}`);
  }
  expect(found.length).toBeGreaterThan(5);
  const versions = new Set(found.map((entry) => entry.slice(entry.indexOf(": ") + 2)));
  expect(found.filter((entry) => !/: \d+\.\d+\.\d+$/.test(entry))).toEqual([]);
  expect(versions.size).toBe(1);
});
