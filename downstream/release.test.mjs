import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "./release.mjs";

const cli = fileURLToPath(new URL("./release.mjs", import.meta.url));
const nested = process.env.OMNIROUTE_RELEASE_TEST_CHILD === "1";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t, failCoverage = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omniroute-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"),
    patches = path.join(root, "patches"),
    bin = path.join(root, "bin");
  await Promise.all([mkdir(repo), mkdir(patches), mkdir(bin)]);
  git(repo, "-c", "init.templateDir=", "init", "--quiet");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgSign", "false");
  git(repo, "config", "core.hooksPath", "/dev/null");
  const pkg = {
    name: "release-fixture",
    version: "1.0.0",
    scripts: {
      postinstall: "node setup.cjs",
      "test:coverage": "node check.cjs coverage",
      "test:all": "node check.cjs all",
      "test:integration": "node check.cjs integration",
    },
  };
  await writeFile(path.join(repo, "package.json"), JSON.stringify(pkg));
  await writeFile(
    path.join(repo, "package-lock.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: pkg.name, version: pkg.version, hasInstallScript: true } },
    })
  );
  await writeFile(
    path.join(repo, "setup.cjs"),
    "if(process.env.GHCR_TOKEN) process.exit(10); const fs=require('fs'); fs.mkdirSync('node_modules/.bin',{recursive:true}); fs.writeFileSync('node_modules/.bin/playwright','#!/bin/sh\\nexit 0\\n',{mode:0o755});\n"
  );
  await writeFile(
    path.join(repo, "check.cjs"),
    `const assert=require('node:assert/strict'); assert.equal(process.env.GHCR_TOKEN,undefined); assert.equal(require('./app.cjs')(2), 42); if(process.argv[2] === 'coverage' && ${failCoverage}) process.exit(8);\n`
  );
  await writeFile(path.join(repo, "app.cjs"), "module.exports = value => value + 1;\n");
  await writeFile(path.join(repo, "Dockerfile"), "FROM scratch AS runner-base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "app.cjs"), "module.exports = value => value + 40;\n");
  git(repo, "add", "app.cjs");
  git(repo, "commit", "--quiet", "-m", "patch behavior");
  const patch = git(repo, "format-patch", "-1", "--stdout");
  await writeFile(path.join(patches, "change.patch"), `${patch}\n`);
  await writeFile(path.join(patches, "series"), "change.patch\n");
  const config = path.join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      upstreamRepository: repo,
      upstreamCommit: base,
      upstreamTag: "v1.2.3",
      image: "ghcr.io/example/app",
      revision: 1,
      patchesDir: "patches",
    })
  );
  const state = path.join(root, "docker-state");
  await mkdir(state);
  const docker = path.join(bin, "docker");
  await writeFile(
    docker,
    `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), dir = process.env.DOCKER_STATE;
const file = name => path.join(dir, name);
const registry = () => fs.existsSync(file('registry.json')) ? JSON.parse(fs.readFileSync(file('registry.json'))) : [];
if (process.env.GHCR_TOKEN) process.exit(10);
if (a[0] === 'buildx') fs.writeFileSync(file('image'), 'loaded');
if (a[0] === 'image') { if (!fs.existsSync(file('image'))) process.exit(2); console.log('sha256:fixture'); }
if (a[0] === 'run') { if (!fs.existsSync(file('image'))) process.exit(2); fs.writeFileSync(file('container'), a.at(-1)); console.log('fixture-container'); }
if (a[0] === 'inspect') { if (!fs.existsSync(file('container'))) process.exit(2); const health = process.env.FIXTURE_HEALTH || 'healthy'; if (health === 'healthy') fs.writeFileSync(file('healthy-image'), fs.readFileSync(file('container'))); console.log(health); }
if (a[0] === 'login') { if (fs.readFileSync(0, 'utf8').trim() !== 'test-token') process.exit(2); fs.writeFileSync(file('login'), 'authenticated'); }
if (a[0] === 'tag') { const tags = fs.existsSync(file('tags.json')) ? JSON.parse(fs.readFileSync(file('tags.json'))) : {}; tags[a[2]] = a[1]; fs.writeFileSync(file('tags.json'), JSON.stringify(tags)); }
if (a[0] === 'push') { const tags = registry(), images = JSON.parse(fs.readFileSync(file('tags.json'))); if (!fs.existsSync(file('login')) || images[a[1]] !== fs.readFileSync(file('healthy-image'), 'utf8')) process.exit(2); if (process.env.FAIL_PUSH === '1' && tags.length) process.exit(9); tags.push(a[1]); fs.writeFileSync(file('registry.json'), JSON.stringify(tags)); }
if (a[0] === 'rm') fs.rmSync(file('container'));
`
  );
  await chmod(docker, 0o755);
  const output = path.join(root, "output");
  const run = (args = [], env = {}) =>
    spawnSync(process.execPath, [cli, "--config", config, "--output", output, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OMNIROUTE_RELEASE_TEST_CHILD: "1",
        DOCKER_STATE: state,
        ...env,
      },
    });
  return { root, output, run, state };
}

async function contents(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

test("argument validation requires an absolute output and rejects bad options", () => {
  for (const args of [
    [],
    ["--output", "relative"],
    ["--output"],
    ["--unknown"],
    ["--output", "/a", "--push", "--push"],
    ["--output", "/a", "--config"],
  ])
    assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(["--output", "/a"]).push, false);
});

test("existing output and missing credentials are never modified", { skip: nested }, async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(path.join(f.output, "keep"), "original");
  const existing = f.run();
  assert.notEqual(existing.status, 0);
  assert.equal(await readFile(path.join(f.output, "keep"), "utf8"), "original");
  const missing = f.run(["--push"], { GHCR_TOKEN: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /GHCR_TOKEN/);
  assert.equal(await contents(path.join(f.state, "registry.json")), "");
});

test(
  "patched candidate failing coverage is retained and never built or pushed",
  { skip: nested },
  async (t) => {
    const f = await fixture(t, true);
    const result = f.run(["--push"], { GHCR_TOKEN: "test-token" });
    assert.notEqual(result.status, 0, result.stdout);
    const app = path.join(f.output, "source", "app.cjs");
    const execution = spawnSync(
      process.execPath,
      ["-e", `process.stdout.write(String(require(${JSON.stringify(app)})(2)))`],
      { encoding: "utf8" }
    );
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "42");
    assert.equal(await contents(path.join(f.state, "image")), "");
    assert.equal(await contents(path.join(f.state, "registry.json")), "");
  }
);

test(
  "unhealthy image cannot log in or push and container is removed",
  { skip: nested },
  async (t) => {
    const f = await fixture(t);
    const result = f.run(["--push"], { GHCR_TOKEN: "test-token", FIXTURE_HEALTH: "unhealthy" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /unhealthy/);
    assert.equal(await contents(path.join(f.state, "container")), "");
    assert.equal(await contents(path.join(f.state, "login")), "");
    assert.equal(await contents(path.join(f.state, "registry.json")), "");
    assert.equal(JSON.parse(await readFile(path.join(f.output, "image.json"))).pushed, false);
  }
);

test(
  "partial push failure retains unpublished metadata and removes container",
  { skip: nested },
  async (t) => {
    const f = await fixture(t);
    const result = f.run(["--push"], { GHCR_TOKEN: "test-token", FAIL_PUSH: "1" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /Published:/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
    const published = JSON.parse(await contents(path.join(f.state, "registry.json")));
    assert.equal(published.length, 1);
    assert.equal(await contents(path.join(f.state, "container")), "");
    assert.equal(JSON.parse(await readFile(path.join(f.output, "image.json"))).pushed, false);
  }
);

test(
  "healthy local validation leaves image loaded but does not publish",
  { skip: nested },
  async (t) => {
    const f = await fixture(t);
    const result = f.run([], { GHCR_TOKEN: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await contents(path.join(f.state, "image")), "loaded");
    assert.equal(await contents(path.join(f.state, "container")), "");
    assert.equal(await contents(path.join(f.state, "login")), "");
    assert.equal(await contents(path.join(f.state, "registry.json")), "");
    assert.equal(JSON.parse(await readFile(path.join(f.output, "image.json"))).pushed, false);
  }
);

test(
  "healthy release publishes every metadata tag and removes its container",
  { skip: nested },
  async (t) => {
    const f = await fixture(t);
    const result = f.run(["--push"], { GHCR_TOKEN: "test-token" });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /test-token/);
    const metadata = JSON.parse(await readFile(path.join(f.output, "image.json")));
    assert.equal(metadata.pushed, true);
    assert.deepEqual(
      JSON.parse(await contents(path.join(f.state, "registry.json"))),
      metadata.tags
    );
    assert.equal(await contents(path.join(f.state, "healthy-image")), metadata.imageId);
    const taggedImages = JSON.parse(await contents(path.join(f.state, "tags.json")));
    for (const tag of metadata.tags) assert.equal(taggedImages[tag], metadata.imageId);
    assert.equal(await contents(path.join(f.state, "container")), "");
  }
);
