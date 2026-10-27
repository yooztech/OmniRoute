import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("unavailable pinned commits fail and remove the output", async (t) => {
  const f = await fixture(t);
  const result = f.run("--commit", "f".repeat(40));
  assert.notEqual(result.status, 0);
  await assert.rejects(access(f.output), { code: "ENOENT" });
});

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
