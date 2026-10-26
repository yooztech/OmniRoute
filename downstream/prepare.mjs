#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultConfig = fileURLToPath(new URL("./config.json", import.meta.url));

function git(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
    delete env[key];
  }
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed (exit ${result.status ?? result.signal})`);
  return result.stdout.trim();
}

export function parseArguments(args) {
  const options = {};
  const names = { "--output": "output", "--commit": "commit", "--config": "config" };
  for (let i = 0; i < args.length; i++) {
    const name = names[args[i]];
    if (!name || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Usage: node downstream/prepare.mjs --output ABSENT_DIRECTORY [--commit FULL_SHA] [--config PATH]");
    }
    options[name] = args[++i];
  }
  if (!options.output) throw new Error("--output ABSENT_DIRECTORY is required");
  return options;
}

export async function prepare({ output, commit, config: configPath = defaultConfig }) {
  if (typeof output !== "string" || !output) throw new Error("An output directory is required");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const upstreamCommit = commit ?? config.upstreamCommit;
  if (typeof upstreamCommit !== "string" || !/^[0-9a-f]{40}$/i.test(upstreamCommit)) {
    throw new Error("Upstream commit must be a full 40-hex SHA");
  }
  if (typeof config.upstreamRepository !== "string" || !config.upstreamRepository || config.upstreamRepository.startsWith("-")) {
    throw new Error("upstreamRepository must be a nonempty repository URL or path");
  }
  const destination = path.resolve(output);
  try {
    await lstat(destination);
    throw new Error(`Refusing to overwrite existing output: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const patchRoot = await realpath(path.join(path.dirname(path.resolve(configPath)), "patches"));
  const series = (await readFile(path.join(patchRoot, "series"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const patches = [];
  const seen = new Set();
  for (const entry of series) {
    if (path.posix.isAbsolute(entry) || entry.includes("\\") || entry.split("/").some((part) => !part || part === "." || part === "..") || seen.has(entry)) {
      throw new Error(`Unsafe or duplicate patch path in series: ${entry}`);
    }
    seen.add(entry);
    const patch = await realpath(path.join(patchRoot, entry));
    const relative = path.relative(patchRoot, patch);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(patch)).isFile()) {
      throw new Error(`Patch must be a file inside patches/: ${entry}`);
    }
    patches.push(patch);
  }

  // mkdir is deliberately exclusive: even a competing creator must not be overwritten.
  await mkdir(destination);
  try {
    git(["-c", "init.templateDir=", "init", "--quiet", destination]);
    git(["config", "user.name", "OmniRoute downstream"], destination);
    git(["config", "user.email", "downstream@users.noreply.github.com"], destination);
    git(["config", "commit.gpgSign", "false"], destination);
    git(["config", "core.hooksPath", "/dev/null"], destination);
    git(["fetch", "--no-tags", "--depth=1", "--", config.upstreamRepository, upstreamCommit], destination);
    const fetched = git(["rev-parse", "FETCH_HEAD^{commit}"], destination);
    if (fetched !== upstreamCommit.toLowerCase()) throw new Error("Fetched commit does not match the requested SHA");
    git(["checkout", "--quiet", "--detach", fetched], destination);
    for (const patch of patches) git(["am", "--committer-date-is-author-date", "--", patch], destination);
    if (git(["status", "--porcelain", "--untracked-files=all"], destination)) {
      throw new Error("Prepared source tree is not clean");
    }
    return {
      output: destination,
      upstreamRepository: config.upstreamRepository,
      upstreamCommit: fetched,
      candidateCommit: git(["rev-parse", "HEAD"], destination),
      upstreamTag: config.upstreamTag,
      image: config.image,
      revision: config.revision,
      patches: series,
    };
  } catch (error) {
    // Never leave a failed application looking like a usable build context.
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const metadata = await prepare(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
  } catch (error) {
    console.error(`prepare: ${error.message}`);
    process.exitCode = 1;
  }
}
