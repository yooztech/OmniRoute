import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertMirrorRepairRejectsUnsafeLocale } from "../_helpers/mirrorRepairLocaleGuard.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const relativeSource = "docs/architecture/RESILIENCE_GUIDE.md";
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const current = read(relativeSource);
const sourceParagraph = current.match(
  /The same gate covers the pre-dispatch case \(#16319\):[\s\S]+?hint-less 503\.\n\n/
)?.[0];

test("resilience mirror repair rejects a traversal before target reads", async () => {
  assert(sourceParagraph);
  await assertMirrorRepairRejectsUnsafeLocale({
    script: path.join(root, "scripts/ad-hoc/relay-resilience-delta-mirrors-20261013.mjs"),
    relativeSource,
    current,
    previous: current.replace(sourceParagraph, ""),
  });
});
