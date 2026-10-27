import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, imageTags } from "./image.mjs";
import {
  resolveLatestRelease,
  updatedConfig,
  parseArgs as parseUpdateArgs,
} from "./update-upstream.mjs";

const upstreamCommit = "ad6f33f66bda34eba98645d3bfdabbde294bc843";
const toolCommit = "b".repeat(40);
const config = {
  upstreamRepository: "https://github.com/cheaper-inference/OmniRoute.git",
  upstreamCommit,
  upstreamTag: "v3.8.52",
  image: "ghcr.io/yooztech/omniroute",
  revision: 1,
};

test("image tags include release, base SHA, and downstream candidate identity without latest", () => {
  assert.deepEqual(imageTags(config, toolCommit), [
    "ghcr.io/yooztech/omniroute:3.8.52-fork.1",
    "ghcr.io/yooztech/omniroute:sha-ad6f33f66bda-fork.1",
    "ghcr.io/yooztech/omniroute:3.8.52-fork.1-bbbbbbbbbbbb",
  ]);
  for (const change of [
    { revision: 0 },
    { revision: 1.5 },
    { image: "docker.io/example/image" },
    { upstreamTag: "latest" },
    { upstreamCommit: "short" },
  ]) {
    assert.throws(() => imageTags({ ...config, ...change }, toolCommit));
  }
});

test("image arguments reject ambiguous or unsafe invocations before any external work", () => {
  for (const args of [
    [],
    ["--output", "relative"],
    ["--output"],
    ["--output", "/tmp/a", "--wat"],
    ["--output", "/tmp/a", "--push", "--push"],
    ["--output", "/tmp/a", "--platform", "linux/386"],
    ["--output", "/tmp/a", "--platform", "linux/amd64,linux/arm64"],
    ["--output", "/tmp/a", "--push", "--platform", "linux/amd64,linux/amd64"],
  ]) {
    assert.throws(() => parseArgs(args));
  }
  assert.throws(() => parseUpdateArgs(["--config"]));
  assert.throws(() => parseUpdateArgs(["--push"]));
});

function api(responses) {
  const calls = [];
  const request = async (url) => {
    const endpoint = new URL(url).pathname.replace("/repos/cheaper-inference/OmniRoute", "");
    calls.push(endpoint);
    assert.ok(Object.hasOwn(responses, endpoint), `Unexpected GitHub request: ${endpoint}`);
    return { ok: true, json: async () => responses[endpoint] };
  };
  return { calls, request };
}

test("updater resolves lightweight release tags and preserves already pinned revision", async () => {
  const { request, calls } = api({
    "/releases/latest": { tag_name: "v3.8.52", draft: false, prerelease: false },
    "/git/ref/tags/v3.8.52": { object: { type: "commit", sha: upstreamCommit } },
  });
  const release = await resolveLatestRelease(config, request, "");
  assert.deepEqual(release, { upstreamTag: "v3.8.52", upstreamCommit });
  const current = { ...config, revision: 5 };
  assert.equal(updatedConfig(current, release), current);
  assert.equal(calls.length, 2);
});

test("updater peels annotated tags instead of using release target branch", async () => {
  const annotated = "a".repeat(40);
  const commit = "c".repeat(40);
  const { request } = api({
    "/releases/latest": { tag_name: "v3.8.53", target_commitish: "main" },
    "/git/ref/tags/v3.8.53": { object: { type: "tag", sha: annotated } },
    [`/git/tags/${annotated}`]: { object: { type: "commit", sha: commit } },
  });
  const release = await resolveLatestRelease(config, request, "");
  assert.deepEqual(updatedConfig({ ...config, revision: 7 }, release), {
    ...config,
    upstreamTag: "v3.8.53",
    upstreamCommit: commit,
    revision: 1,
  });
});

test("updater rejects unstable releases, invalid object types, cyclic tags and HTTP errors", async () => {
  for (const release of [
    { tag_name: "v3.9.0", prerelease: true },
    { tag_name: "v3.9.0", draft: true },
    { tag_name: "nightly" },
  ]) {
    const { request } = api({ "/releases/latest": release });
    await assert.rejects(resolveLatestRelease(config, request, ""));
  }
  const annotated = "a".repeat(40);
  for (const object of [
    { type: "tree", sha: upstreamCommit },
    { type: "commit", sha: "short" },
    { type: "tag", sha: annotated },
  ]) {
    const { request } = api({
      "/releases/latest": { tag_name: "v3.8.52" },
      "/git/ref/tags/v3.8.52": { object },
      [`/git/tags/${annotated}`]: { object },
    });
    await assert.rejects(resolveLatestRelease(config, request, ""));
  }
  await assert.rejects(
    resolveLatestRelease(config, async () => ({ ok: false, status: 403 }), ""),
    /HTTP 403/
  );
  await assert.rejects(
    resolveLatestRelease({ ...config, upstreamRepository: "https://example.com/repo" }, () => {
      throw new Error("Must not fetch");
    }),
    /HTTPS GitHub/
  );
});

test("real command entry points expose help and reject invalid arguments", () => {
  for (const script of ["image.mjs", "update-upstream.mjs"]) {
    const filename = fileURLToPath(new URL(script, import.meta.url));
    const help = spawnSync(process.execPath, [filename, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    const invalid = spawnSync(process.execPath, [filename, "--not-an-option"], {
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unknown option/);
  }
});
