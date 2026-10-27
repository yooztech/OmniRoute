import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("./release.sh", import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-wrapper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const gh = path.join(bin, "gh");
  await writeFile(gh, "#!/bin/sh\necho 'gh authentication failed' >&2\nexit 23\n");
  await chmod(gh, 0o755);
  return { dir, env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, HOME: dir } };
}

async function logFor(result, dir) {
  const match = result.stdout.match(/^Release log: (.+)$/m);
  assert.ok(match, result.stdout);
  assert.ok(match[1].startsWith(`${dir}${path.sep}`));
  const log = await readFile(match[1], "utf8");
  assert.match(log, /Release failed \(exit code \d+\)/);
  assert.ok(log.includes(match[1]));
  return { path: match[1], contents: log };
}

test("noninteractive authentication failures retain their status and a log", async (t) => {
  const { dir, env } = await fixture(t);
  const result = spawnSync("bash", [wrapper], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 23, result.stderr);
  const log = await logFor(result, dir);
  assert.match(log.contents, /gh authentication failed/);
  assert.doesNotMatch(log.contents, /Press Enter|release succeeded/i);
  await assert.rejects(stat(log.path.slice(0, -4)), { code: "ENOENT" });
});

test("real node failures are reported without leaking supplied credentials", async (t) => {
  const { dir, env } = await fixture(t);
  const secret = "wrapper-test-credential-not-real";
  const options = {
    cwd: dir,
    env: {
      ...env,
      GHCR_TOKEN: secret,
      GHCR_USERNAME: "test",
      NODE_OPTIONS: "--not-a-real-node-option",
    },
    encoding: "utf8",
    timeout: 10000,
  };
  const first = spawnSync("bash", [wrapper], options);
  const second = spawnSync("bash", [wrapper], options);
  assert.notEqual(first.status, 0);
  assert.notEqual(second.status, 0);
  const firstLog = await logFor(first, dir);
  const secondLog = await logFor(second, dir);
  assert.notEqual(firstLog.path, secondLog.path);
  assert.match(firstLog.contents, /not-a-real-node-option/);
  assert.doesNotMatch(firstLog.contents, /gh authentication failed|release succeeded/i);
  assert.ok(!firstLog.contents.includes(secret));
});
