import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("./release.sh", import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "release-wrapper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const selected = path.join(dir, "selected");
  const nvmDir = path.join(dir, "nvm");
  await Promise.all([mkdir(bin), mkdir(selected), mkdir(nvmDir)]);
  const executable = async (file, contents) => {
    await writeFile(file, contents);
    await chmod(file, 0o755);
  };
  await executable(
    path.join(bin, "gh"),
    "#!/bin/sh\necho 'gh authentication failed' >&2\nexit 23\n"
  );
  await executable(
    path.join(bin, "node"),
    "#!/bin/sh\necho 'unsupported PATH node executed' >&2\nexit 91\n"
  );
  await executable(
    path.join(selected, "node"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$TRACE_NODE"\nexec ${JSON.stringify(process.execPath)} "$@"\n`
  );
  await writeFile(
    path.join(nvmDir, "nvm.sh"),
    `nvm() {
  printf '%s\\n' "$*" >> "$TRACE_NVM"
  if [[ "$1" == install ]]; then return "${"$"}{INSTALL_STATUS:-0}"; fi
  if [[ "$1" == use ]]; then
    if [[ "${"$"}{USE_STATUS:-0}" != 0 ]]; then return "$USE_STATUS"; fi
    export PATH="$SELECTED_BIN:$PATH"
    return 0
  fi
  return 99
}
`
  );
  return {
    dir,
    nvmDir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: dir,
      HOME: dir,
      NVM_DIR: nvmDir,
      SELECTED_BIN: selected,
      TRACE_NVM: path.join(dir, "nvm-trace"),
      TRACE_NODE: path.join(dir, "node-trace"),
    },
  };
}

async function assertCleaned(stdout, dir) {
  const match = stdout.match(/^Release work directory: (.+)$/m);
  assert.ok(match, stdout);
  assert.equal(path.dirname(match[1]), dir);
  await assert.rejects(stat(match[1]), { code: "ENOENT" });
  return match[1];
}

async function logFor(result, dir) {
  const match = result.stdout.match(/^Release log: (.+)$/m);
  assert.ok(match, result.stdout);
  assert.ok(match[1].startsWith(`${dir}${path.sep}`));
  await assertCleaned(result.stdout, dir);
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

test("selected Node runs the release entry instead of the PATH Node", async (t) => {
  const { dir, env } = await fixture(t);
  const localWrapper = path.join(dir, "release.sh");
  await copyFile(wrapper, localWrapper);
  await writeFile(
    path.join(dir, "release.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.TRACE_ENTRY, JSON.stringify(process.argv.slice(2)));\n`
  );
  const traceEntry = path.join(dir, "entry-trace");
  const result = spawnSync("bash", [localWrapper], {
    cwd: dir,
    env: { ...env, GHCR_TOKEN: "test", TRACE_ENTRY: traceEntry },
    encoding: "utf8",
    timeout: 10000,
  });
  await assertCleaned(result.stdout, dir);
  const logPath = result.stdout.match(/^Release log: (.+)$/m)?.[1];
  assert.ok(logPath);
  await stat(logPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(env.TRACE_NVM, "utf8"), "install 24.15.0\nuse 24.15.0\n");
  const args = JSON.parse(await readFile(traceEntry, "utf8"));
  assert.deepEqual(args.slice(0, 1), ["--output"]);
  assert.ok(args[1].startsWith(`${dir}${path.sep}`));
  assert.deepEqual(args.slice(2), ["--push"]);
  assert.doesNotMatch(result.stdout, /unsupported PATH node executed/);
});

for (const [failure, status, message] of [
  ["missing", 1, /nvm not found/],
  ["install", 31, /Failed to install Node\.js 24\.15\.0/],
  ["use", 32, /Failed to select Node\.js 24\.15\.0/],
]) {
  test(`nvm ${failure} failure stops before authentication and release`, async (t) => {
    const { dir, nvmDir, env } = await fixture(t);
    if (failure === "missing") await rm(path.join(nvmDir, "nvm.sh"));
    const result = spawnSync("bash", [wrapper], {
      cwd: dir,
      env: {
        ...env,
        INSTALL_STATUS: failure === "install" ? "31" : "0",
        USE_STATUS: failure === "use" ? "32" : "0",
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, status, result.stderr);
    const log = await logFor(result, dir);
    assert.match(log.contents, message);
    assert.doesNotMatch(log.contents, /gh authentication failed|unsupported PATH node executed/);
    await assert.rejects(stat(env.TRACE_NODE), { code: "ENOENT" });
    if (failure === "install")
      assert.equal(await readFile(env.TRACE_NVM, "utf8"), "install 24.15.0\n");
  });
}

for (const status of [0, 47]) {
  test(`release exit ${status} preserves diagnostics and removes large artifacts`, async (t) => {
    const { dir, env } = await fixture(t);
    const localWrapper = path.join(dir, "release.sh");
    await copyFile(wrapper, localWrapper);
    await writeFile(
      path.join(dir, "release.mjs"),
      `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[3];
mkdirSync(path.join(output, "source", "node_modules"), { recursive: true });
writeFileSync(path.join(output, "source", "node_modules", "large-marker"), Buffer.alloc(1024 * 1024));
writeFileSync(path.join(output, "image.json"), JSON.stringify({ image: "fixture" }));
process.exit(${status});
`
    );
    const result = spawnSync("bash", [localWrapper], {
      cwd: dir,
      env: { ...env, GHCR_TOKEN: "private-token" },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, status, result.stderr);
    await assertCleaned(result.stdout, dir);
    const log = result.stdout.match(/^Release log: (.+)$/m)?.[1];
    const metadata = result.stdout.match(/^Release metadata: (.+)$/m)?.[1];
    assert.ok(log && metadata, result.stdout);
    assert.equal(path.dirname(metadata), dir);
    assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")), { image: "fixture" });
    assert.ok(!(await readFile(log, "utf8")).includes("private-token"));
  });
}

for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  test(`${signal} waits for release child before cleanup`, async (t) => {
    const { dir, env } = await fixture(t);
    const localWrapper = path.join(dir, "release.sh");
    const ready = path.join(dir, "ready");
    const stopped = path.join(dir, "stopped");
    await copyFile(wrapper, localWrapper);
    await writeFile(
      path.join(dir, "release.mjs"),
      `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[3];
mkdirSync(path.join(output, "source", "node_modules"), { recursive: true });
writeFileSync(path.join(output, "source", "node_modules", "large-marker"), Buffer.alloc(1024 * 1024));
writeFileSync(path.join(output, "image.json"), '{"image":"interrupted"}');
process.on(${JSON.stringify(signal)}, () => setTimeout(() => {
  writeFileSync(process.env.STOPPED, String(existsSync(output)));
  process.exit(0);
}, 100));
writeFileSync(process.env.READY, String(process.pid));
setInterval(() => {}, 1000);
`
    );
    const child = spawn("bash", [localWrapper], {
      cwd: dir,
      env: { ...env, GHCR_TOKEN: "test", READY: ready, STOPPED: stopped },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, exitSignal) => resolve({ code, exitSignal }));
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await stat(ready);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      assert.ok(Date.now() < deadline, "release child did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = Number(await readFile(ready, "utf8"));
    child.kill(signal);
    assert.deepEqual(await exited, { code: status, exitSignal: null });
    assert.equal(await readFile(stopped, "utf8"), "true");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assertCleaned(stdout, dir);
    const metadata = stdout.match(/^Release metadata: (.+)$/m)?.[1];
    const log = stdout.match(/^Release log: (.+)$/m)?.[1];
    assert.ok(metadata && log, stdout);
    assert.deepEqual(JSON.parse(await readFile(metadata, "utf8")), { image: "interrupted" });
    await stat(log);
  });
}
