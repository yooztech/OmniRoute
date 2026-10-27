#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepare } from "./prepare.mjs";
import { buildArgs, imageTags } from "./image.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const usage =
  "Usage: node downstream/release.mjs --output ABSENT_ABSOLUTE_DIR [--config PATH] [--push]";
const childEnv = { ...process.env };
delete childEnv.GHCR_TOKEN;
for (const key of ["INITIAL_PASSWORD", "DATA_DIR", "NODE_TEST_CONTEXT"]) delete childEnv[key];
// Node's child_process copies this variable from process.env unless the env
// object has its own property; undefined omits it from the spawned process.
childEnv.NODE_V8_COVERAGE = undefined;

async function testPlan(configPath, patches) {
  const manifestPath = path.resolve(path.dirname(configPath), "patches", "tests.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && patches.length === 0) return [];
    throw error;
  }
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (
    !object(manifest) ||
    manifest.version !== 1 ||
    !object(manifest.patches) ||
    Object.keys(manifest).some((k) => !["version", "patches"].includes(k))
  )
    throw new Error("Invalid patch tests manifest");
  const entries = Object.keys(manifest.patches);
  if (
    entries.some((name) => !patches.includes(name)) ||
    patches.some((name) => !entries.includes(name))
  )
    throw new Error("Patch tests manifest does not match applied patches");
  const names = new Set();
  const plan = [];
  for (const patch of patches) {
    const mapping = manifest.patches[patch];
    if (
      !object(mapping) ||
      Object.keys(mapping).some((k) => !["regression", "related"].includes(k))
    )
      throw new Error(`Invalid tests for ${patch}`);
    for (const kind of ["regression", "related"]) {
      if (!Array.isArray(mapping[kind]) || mapping[kind].length === 0)
        throw new Error(`Missing ${kind} tests for ${patch}`);
      for (const test of mapping[kind]) {
        if (
          !object(test) ||
          Object.keys(test).some((k) => !["name", "argv", "env"].includes(k)) ||
          typeof test.name !== "string" ||
          !test.name.trim() ||
          names.has(test.name) ||
          !Array.isArray(test.argv) ||
          !test.argv.length ||
          test.argv.some((arg) => typeof arg !== "string" || !arg) ||
          (test.env !== undefined &&
            (!object(test.env) ||
              Object.entries(test.env).some(
                ([key, value]) =>
                  !key || key.includes("=") || key === "GHCR_TOKEN" || typeof value !== "string"
              )))
        )
          throw new Error(`Invalid or duplicate test in ${patch}`);
        names.add(test.name);
        plan.push({
          patch,
          kind,
          name: test.name,
          argv: test.argv,
          ...(test.env === undefined ? {} : { env: test.env }),
          status: "pending",
        });
      }
    }
  }
  return plan;
}

export function parseArgs(args) {
  const options = { config: path.join(here, "config.json"), push: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--push") options.push = true;
    else if (flag === "--output" || flag === "--config") {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.output || !path.isAbsolute(options.output))
    throw new Error("--output must be an absolute path to an absent directory");
  return options;
}

function command(program, args, { cwd = root, capture = false, input, env = childEnv } = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: "utf8",
    input,
    env,
    stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} ${args[0]} failed (exit ${result.status ?? result.signal})`);
  return capture ? result.stdout.trim() : undefined;
}

export async function release(options) {
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const toolCommit = command("git", ["rev-parse", "HEAD"], { capture: true });
  const tags = imageTags(config, toolCommit);
  const token = process.env.GHCR_TOKEN;
  const username = process.env.GHCR_USERNAME || config.image.split("/")[1];
  if (options.push && (!token || !username))
    throw new Error("--push requires GHCR_TOKEN and a GHCR username");

  // Exclusive creation protects existing files and directories, including symlinks.
  await mkdir(options.output);
  const source = path.join(options.output, "source");
  const metadataPath = path.join(options.output, "image.json");
  console.log("Testing downstream tooling");
  const tests = (await readdir(here))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join(here, name));
  command(process.execPath, ["--test", ...tests]);
  console.log("Preparing pinned candidate and patches");
  let candidate;
  delete process.env.GHCR_TOKEN;
  try {
    candidate = await prepare({ output: source, config: options.config });
  } finally {
    if (token !== undefined) process.env.GHCR_TOKEN = token;
  }
  const metadata = {
    ...candidate,
    toolCommit,
    tags,
    imageId: null,
    platform: "linux/amd64",
    scope: "official-baseline+patches",
    tests: [],
    manifest: "pending",
    install: "not-required",
    health: "pending",
    smoke: "pending",
    pushed: false,
  };
  const save = () => writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await save();
  try {
    metadata.tests = await testPlan(options.config, candidate.patches);
    metadata.manifest = "passed";
  } catch (error) {
    metadata.manifest = "failed";
    await save();
    throw error;
  }
  await save();
  if (candidate.patches.length) {
    const testEnv = {
      ...childEnv,
      CI: "true",
      JWT_SECRET: randomBytes(32).toString("hex"),
      API_KEY_SECRET: randomBytes(32).toString("hex"),
    };
    metadata.install = "running";
    await save();
    try {
      command("npm", ["ci"], { cwd: source, env: testEnv });
      metadata.install = "passed";
    } catch (error) {
      metadata.install = "failed";
      await save();
      throw error;
    }
    await save();
    for (const test of metadata.tests) {
      test.status = "running";
      await save();
      try {
        command(test.argv[0], test.argv.slice(1), {
          cwd: source,
          env: { ...testEnv, ...test.env },
        });
        test.status = "passed";
      } catch (error) {
        test.status = "failed";
        await save();
        throw error;
      }
      await save();
    }
  }
  console.log("Building and loading linux/amd64 image");
  command(
    "docker",
    buildArgs(
      { output: source, platform: "linux/amd64", push: false },
      config,
      toolCommit,
      candidate.patches,
      candidate.candidateCommit
    )
  );
  const imageId = command("docker", ["image", "inspect", "--format", "{{.Id}}", tags[2]], {
    capture: true,
  });
  if (!imageId) throw new Error("Docker returned an empty image ID");
  metadata.imageId = imageId;
  await save();
  let container;
  try {
    console.log("Checking container health");
    container = command(
      "docker",
      ["run", "-d", "--health-interval=5s", "--health-start-period=30s", imageId],
      { capture: true }
    );
    if (!container) throw new Error("Docker returned an empty container ID");
    const deadline = Date.now() + 300_000;
    for (;;) {
      const health = command(
        "docker",
        [
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
          container,
        ],
        { capture: true }
      );
      if (health === "healthy") break;
      if (health !== "starting") throw new Error(`Container health is ${health || "missing"}`);
      if (Date.now() >= deadline)
        throw new Error("Container did not become healthy within 300 seconds");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now())))
      );
    }
    metadata.health = "passed";
    await save();
    // The image's HEALTHCHECK probes HTTP status; also verify the route body.
    command("docker", [
      "exec",
      container,
      "node",
      "-e",
      "fetch('http://127.0.0.1:20128/healthz', { signal: AbortSignal.timeout(10000) }).then(async r => { if (r.status !== 200 || await r.text() !== 'ok\\n') process.exit(1); }).catch(() => process.exit(1))",
    ]);
    metadata.smoke = "passed";
    await save();
    if (options.push) {
      console.log("Logging in to GHCR");
      command("docker", ["login", "ghcr.io", "--username", username, "--password-stdin"], {
        input: `${token}\n`,
      });
      for (const tag of tags) {
        command("docker", ["tag", imageId, tag]);
        console.log(`Pushing ${tag}`);
        command("docker", ["push", tag]);
      }
      metadata.pushed = true;
      await save();
    }
  } catch (error) {
    if (metadata.health === "pending") metadata.health = "failed";
    else if (metadata.smoke === "pending") metadata.smoke = "failed";
    await save();
    throw error;
  } finally {
    if (container) {
      try {
        command("docker", ["logs", container]);
      } catch (error) {
        console.error(error.message);
      }
      command("docker", ["rm", "-f", container]);
    }
  }
  console.log(`${options.push ? "Published" : "Validated"}: ${tags.join(", ")}`);
  console.log(`Metadata: ${metadataPath}`);
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else await release(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
