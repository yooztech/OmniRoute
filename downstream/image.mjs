#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const help = `Usage: node downstream/image.mjs --output ABSENT_DIRECTORY [--config PATH] [--push] [--platform linux/amd64,linux/arm64]

Build the pinned upstream plus downstream patch queue with Docker Buildx.
Default: linux/amd64, loaded into local Docker. Only --push uploads to GHCR.
The output directory must not already exist; it is retained as the build context.
`;

export function parseArgs(args) {
  const options = { config: path.join(here, "config.json"), push: false, platform: "linux/amd64" };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--push") options.push = true;
    else if (["--output", "--config", "--platform"].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.output) throw new Error("--output is required");
  if (!path.isAbsolute(options.output)) throw new Error("--output must be an absolute path");
  const platforms = options.platform.split(",");
  if (platforms.some((platform) => !["linux/amd64", "linux/arm64"].includes(platform)) || new Set(platforms).size !== platforms.length) {
    throw new Error("--platform must contain unique linux/amd64 and/or linux/arm64 values");
  }
  if (!options.push && platforms.length !== 1) throw new Error("Multiple platforms require --push; Docker --load supports one platform");
  options.config = path.resolve(options.config);
  return options;
}

export function imageTags(config, toolCommit) {
  if (!/^v?\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/.test(config.upstreamTag)) throw new Error("Invalid upstream release tag");
  if (!/^[a-f0-9]{40}$/.test(config.upstreamCommit)) throw new Error("Invalid upstream commit");
  if (!/^[a-f0-9]{40}$/.test(toolCommit)) throw new Error("Invalid downstream tool commit");
  if (!Number.isSafeInteger(config.revision) || config.revision < 1) throw new Error("revision must be a positive integer");
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/.test(config.image)) throw new Error("image must be an untagged lowercase GHCR repository");
  const version = config.upstreamTag.replace(/^v/, "");
  const release = `${version}-custom.${config.revision}`;
  return [release, `sha-${config.upstreamCommit.slice(0, 12)}-custom.${config.revision}`, `${release}-${toolCommit.slice(0, 12)}`].map((tag) => `${config.image}:${tag}`);
}

export function buildArgs(options, config, toolCommit, patches, candidateCommit) {
  const tags = imageTags(config, toolCommit);
  return ["buildx", "build", "--file", path.join(options.output, "Dockerfile"), "--target", "runner-base",
    "--platform", options.platform, "--build-arg", "OMNIROUTE_USE_TURBOPACK=0", "--build-arg", "OMNIROUTE_BUILD_MEMORY_MB=12288",
    ...tags.flatMap((tag) => ["--tag", tag]),
    "--label", `org.opencontainers.image.revision=${toolCommit}`,
    "--label", "org.opencontainers.image.source=https://github.com/yooztech/OmniRoute",
    "--label", `io.omniroute.downstream.upstream-commit=${config.upstreamCommit}`,
    "--label", `io.omniroute.downstream.upstream-tag=${config.upstreamTag}`,
    "--label", `io.omniroute.downstream.candidate-commit=${candidateCommit}`,
    "--label", `io.omniroute.downstream.patches=${JSON.stringify(patches)}`,
    options.push ? "--push" : "--load", options.output];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || "see output above"}`);
  return result.stdout?.trim();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void process.stdout.write(help);
  const config = JSON.parse(readFileSync(options.config, "utf8"));
  const toolCommit = run("git", ["-C", path.resolve(here, ".."), "rev-parse", "HEAD"]);
  imageTags(config, toolCommit);
  const metadata = JSON.parse(run(process.execPath, [path.join(here, "prepare.mjs"), "--output", options.output, "--config", options.config], { stdio: ["ignore", "pipe", "inherit"] }));
  run("docker", buildArgs(options, config, toolCommit, metadata.patches, metadata.candidateCommit), { stdio: ["inherit", 2, 2] });
  process.stdout.write(`${JSON.stringify({ ...metadata, toolCommit, tags: imageTags(config, toolCommit), pushed: options.push, platform: options.platform })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
