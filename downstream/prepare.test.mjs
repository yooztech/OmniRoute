import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./prepare.mjs", import.meta.url));

function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omniroute-prepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const patches = path.join(root, "patches");
  await mkdir(source);
  await mkdir(patches);
  const git = (...args) => command("git", args, source);
  git("-c", "init.templateDir=", "init", "--quiet");
  git("config", "user.name", "Patch test");
  git("config", "user.email", "patch-test@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.hooksPath", "/dev/null");
  await writeFile(path.join(source, "behavior.mjs"), 'process.stdout.write("1\\n");\n');
  git("add", "behavior.mjs");
  git("commit", "--quiet", "-m", "Official base");
  const base = git("rev-parse", "HEAD");
  for (const value of [2, 3]) {
    await writeFile(path.join(source, "behavior.mjs"), `process.stdout.write("${value}\\n");\n`);
    git("commit", "--quiet", "-am", `Return ${value}`);
    await writeFile(
      path.join(patches, `${value}.patch`),
      `${git("format-patch", "-1", "--stdout")}\n`
    );
  }
  const config = path.join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      upstreamRepository: source,
      upstreamCommit: base,
      upstreamTag: "v1.0.0",
      image: "ghcr.io/example/omniroute",
      revision: 1,
    })
  );
  await writeFile(path.join(patches, "series"), "");
  const output = path.join(root, "prepared");
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--config", config, "--output", output, ...args], {
      encoding: "utf8",
    });
  const series = (text) => writeFile(path.join(patches, "series"), text);
  return { root, source, patches, config, base, output, run, series, git };
}

async function gitShim(f, { failures = 0, blockFetch = false, failCommand = "" } = {}) {
  const bin = path.join(f.root, "bin");
  const log = path.join(f.root, "git-invocations.jsonl");
  await mkdir(bin);
  const realGit = command("which", ["git"]);
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
let entries = [];
try { entries = fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code !== "ENOENT") throw error; }
fs.appendFileSync(log, JSON.stringify({ args, time: Date.now(), pid: process.pid }) + "\\n");
if (args[0] === "fetch") {
  if (${blockFetch}) { setInterval(() => {}, 1000); return; }
  if (entries.filter(entry => entry.args[0] === "fetch").length < ${failures}) process.exit(1);
}
if (args[0] === ${JSON.stringify(failCommand)}) process.exit(1);
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
    { mode: 0o755 }
  );
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    entries: async () => {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

function startPrepare(t, f, env, ...args) {
  const child = spawn(
    process.execPath,
    [cli, "--config", f.config, "--output", f.output, ...args],
    { env }
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, exited, stderr: () => stderr };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test(
  "fetch retries multiple failures at five-second intervals before applying the patch to the exact SHA",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.series("2.patch\n");
    const shim = await gitShim(f, { failures: 2 });
    const run = startPrepare(t, f, shim.env);
    const result = await run.exited;
    assert.equal(result.code, 0, result.stderr);
    const fetches = (await shim.entries()).filter((entry) => entry.args[0] === "fetch");
    assert.equal(fetches.length, 3);
    for (const fetch of fetches) assert.equal(fetch.args.at(-1), f.base);
    for (let i = 1; i < fetches.length; i++) {
      assert.ok(
        fetches[i].time - fetches[i - 1].time >= 4900,
        "fetch retries must wait five seconds"
      );
    }
    const metadata = JSON.parse(result.stdout);
    assert.equal(metadata.upstreamCommit, f.base);
    assert.deepEqual(metadata.patches, ["2.patch"]);
    assert.equal(command("git", ["rev-parse", "HEAD^"], f.output), f.base);
    assert.equal(command(process.execPath, [path.join(f.output, "behavior.mjs")]), "2");
    assert.equal(command("git", ["status", "--porcelain"], f.output), "");
  }
);

test(
  "a permanent non-fetch failure is not retried and removes the candidate",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const shim = await gitShim(f, { failCommand: "checkout" });
    const result = await startPrepare(t, f, shim.env).exited;
    assert.notEqual(result.code, 0);
    const entries = await shim.entries();
    assert.equal(entries.filter((entry) => entry.args[0] === "fetch").length, 1);
    assert.equal(entries.filter((entry) => entry.args[0] === "checkout").length, 1);
    await assert.rejects(access(f.output), { code: "ENOENT" });
  }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const phase of ["active fetch", "retry sleep"]) {
    test(
      `${signal} interrupts ${phase}, exits with the signal status, and removes the candidate`,
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t);
        const shim = await gitShim(
          f,
          phase === "active fetch" ? { blockFetch: true } : { failures: 100 }
        );
        const run = startPrepare(t, f, shim.env);
        await waitFor(
          async () => (await shim.entries()).some((entry) => entry.args[0] === "fetch"),
          "fetch to start"
        );
        if (phase === "retry sleep")
          await waitFor(() => /retry/i.test(run.stderr()), "retry sleep");
        const fetches = (await shim.entries()).filter((entry) => entry.args[0] === "fetch");
        assert.equal(fetches.length, 1);
        assert.equal(run.child.kill(signal), true);
        const result = await run.exited;
        assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
        assert.equal(result.signal, null);
        assert.equal((await shim.entries()).filter((entry) => entry.args[0] === "fetch").length, 1);
        await assert.rejects(access(f.output), { code: "ENOENT" });
        if (phase === "active fetch") {
          assert.throws(() => process.kill(fetches[0].pid, 0), { code: "ESRCH" });
        }
      }
    );
  }
}

test("empty queue checks out the exact official SHA, not the repository tip", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.output, f.output);
  assert.equal(metadata.upstreamCommit, f.base);
  assert.equal(metadata.candidateCommit, f.base);
  assert.equal(metadata.upstreamTag, "v1.0.0");
  assert.deepEqual(metadata.patches, []);
  assert.equal(command(process.execPath, [path.join(f.output, "behavior.mjs")]), "1");
  assert.equal(command("git", ["rev-parse", "HEAD"], f.output), f.base);
  assert.equal(command("git", ["status", "--porcelain"], f.output), "");
});

test("git am applies real behavior patches in series order with local identity", async (t) => {
  const f = await fixture(t);
  await f.series("# Ordered mail patches\n\n2.patch\n3.patch\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).patches, ["2.patch", "3.patch"]);
  assert.equal(command(process.execPath, [path.join(f.output, "behavior.mjs")]), "3");
  assert.equal(command("git", ["log", "-2", "--format=%s"], f.output), "Return 3\nReturn 2");
  assert.equal(
    command("git", ["config", "--local", "user.email"], f.output),
    "downstream@users.noreply.github.com"
  );
  assert.equal(command("git", ["status", "--porcelain"], f.output), "");
  const candidateCommit = JSON.parse(result.stdout).candidateCommit;
  assert.equal(candidateCommit, command("git", ["rev-parse", "HEAD"], f.output));
  assert.notEqual(candidateCommit, f.base);
  assert.equal(
    command("git", ["log", "-1", "--format=%aI|%cI"], f.output).split("|")[0],
    command("git", ["log", "-1", "--format=%cI"], f.output)
  );
  await rm(f.output, { recursive: true });
  const repeated = f.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).candidateCommit, candidateCommit);
});

test("reversed dependent patches fail and remove the incomplete output", async (t) => {
  const f = await fixture(t);
  await f.series("3.patch\n2.patch\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git am failed/);
  await assert.rejects(access(f.output), { code: "ENOENT" });
});

test("malformed patches fail rather than silently producing a build context", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.patches, "bad.patch"), "not a mail patch\n");
  await f.series("2.patch\nbad.patch\n");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /git am failed/);
  await assert.rejects(access(f.output), { code: "ENOENT" });
});

test("existing nonempty and empty outputs are never overwritten", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  await writeFile(path.join(f.output, "keep"), "user data");
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(f.output, "keep"), "utf8"), "user data");
});

test("broken output symlinks are also refused", async (t) => {
  const f = await fixture(t);
  await symlink(path.join(f.root, "absent"), f.output);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
});

test("series rejects traversal, absolute paths, duplicates and symlink escapes", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, "outside.patch"),
    await readFile(path.join(f.patches, "2.patch"))
  );
  await symlink(path.join(f.root, "outside.patch"), path.join(f.patches, "escape.patch"));
  for (const entry of [
    "../outside.patch",
    path.join(f.root, "outside.patch"),
    "sub/../../outside.patch",
    "..\\outside.patch",
    "2.patch\n2.patch",
    "escape.patch",
  ]) {
    await f.series(`${entry}\n`);
    const result = f.run();
    assert.notEqual(result.status, 0, entry);
    await assert.rejects(access(f.output), { code: "ENOENT" });
  }
});

test("commit override requires a full SHA and selects the requested commit", async (t) => {
  const f = await fixture(t);
  for (const commit of ["main", "abc123", "g".repeat(40), "a".repeat(39)]) {
    const result = f.run("--commit", commit);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /40-hex SHA/);
  }
  const tip = f.git("rev-parse", "HEAD");
  const result = f.run("--commit", tip);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).upstreamCommit, tip);
  assert.equal(command(process.execPath, [path.join(f.output, "behavior.mjs")]), "3");
});

test(
  "unavailable pinned commits keep retrying until interrupted and remove the output",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const shim = await gitShim(f);
    const run = startPrepare(t, f, shim.env, "--commit", "f".repeat(40));
    await waitFor(
      () => (run.stderr().match(/retrying/gi) ?? []).length >= 2,
      "a second failed fetch"
    );
    const fetches = (await shim.entries()).filter((entry) => entry.args[0] === "fetch");
    assert.equal(fetches.length, 2);
    assert.ok(fetches.every((entry) => entry.args.at(-1) === "f".repeat(40)));
    assert.equal(run.child.kill("SIGINT"), true);
    const result = await run.exited;
    assert.equal(result.code, 130, result.stderr);
    await assert.rejects(access(f.output), { code: "ENOENT" });
  }
);

test("CLI rejects missing, unknown and repeated options", async (t) => {
  const f = await fixture(t);
  for (const args of [["--wat"], ["--commit"], ["--output", f.output]]) {
    const result = f.run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
  }
  const result = spawnSync(process.execPath, [cli, "--config", f.config], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output ABSENT_DIRECTORY is required/);
});
