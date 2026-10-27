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
  const testEnv = {
    ...childEnv,
    CI: "true",
    DATA_DIR: path.join(options.output, "data"),
    JWT_SECRET: randomBytes(32).toString("hex"),
    API_KEY_SECRET: randomBytes(32).toString("hex"),
    INITIAL_PASSWORD: randomBytes(24).toString("hex"),
    DISABLE_SQLITE_AUTO_BACKUP: "true",
  };
  await mkdir(testEnv.DATA_DIR);
  const phases = [
    ["npm", ["ci"]],
    ["npx", ["--no-install", "playwright", "install", "chromium"]],
    ["npm", ["run", "test:coverage"]],
    ["npm", ["run", "test:all"]],
    ["npm", ["run", "test:integration"]],
  ];
  for (const [program, args] of phases) {
    console.log(`Running ${program} ${args.join(" ")}`);
    command(program, args, { cwd: source, env: testEnv });
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
  const metadata = {
    ...candidate,
    toolCommit,
    tags,
    imageId,
    platform: "linux/amd64",
    pushed: false,
  };
  const save = () => writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
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
