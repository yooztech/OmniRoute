#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repository = "yooztech/OmniRoute";
const workflow = "downstream-image.yml";
const allowedRefs = ["main", "downstream/patch-build"];
const help = `Usage: node downstream/publish.mjs [--ref main|downstream/patch-build]

Dispatch the trusted fork's GHCR workflow, wait for this request, and report its published image tags.
Requires authenticated GitHub CLI (gh). The workflow must first exist on main (merge PR #1).
No checkout, merge, local Docker build, or latest tag publication is performed.
`;

export function parseArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  if (args.length === 0) return { ref: "main" };
  if (args.length !== 2 || args[0] !== "--ref" || !allowedRefs.includes(args[1])) {
    throw new Error("Only --ref main or --ref downstream/patch-build is supported");
  }
  return { ref: args[1] };
}

export function runGh(args, { inherit = false } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      ...(inherit ? {} : { timeout: 30_000 }),
    });
  } catch (cause) {
    const detail = cause.stderr?.toString().trim() || cause.message;
    const error = new Error(`gh ${args[0]} failed: ${detail}`, { cause });
    error.exitCode = Number.isInteger(cause.status) && cause.status > 0 ? cause.status : 1;
    throw error;
  }
}

export function parseRunList(json, requestId, ref) {
  const runs = JSON.parse(json);
  if (!Array.isArray(runs)) throw new Error("GitHub returned an invalid workflow run list");
  const matches = runs.filter(
    (run) =>
      run.displayTitle === `Downstream GHCR image / ${requestId}` &&
      run.event === "workflow_dispatch" &&
      run.headBranch === ref
  );
  if (matches.length > 1)
    throw new Error(
      "Multiple workflow runs match this publication request; refusing an ambiguous run"
    );
  if (matches.length === 0) return null;
  if (!Number.isSafeInteger(matches[0].databaseId) || matches[0].databaseId < 1)
    throw new Error("GitHub returned an invalid workflow run ID");
  return matches[0];
}

export function requireSuccess(json) {
  const run = JSON.parse(json);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `Publication did not succeed (status=${run.status}, conclusion=${run.conclusion})`
    );
  }
  return run;
}

export function publishedTags(json) {
  const metadata = JSON.parse(json);
  if (
    !Array.isArray(metadata.tags) ||
    metadata.tags.length === 0 ||
    metadata.tags.some(
      (tag) =>
        typeof tag !== "string" ||
        !/^ghcr\.io\/yooztech\/omniroute:[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(tag) ||
        tag.endsWith(":latest")
    )
  ) {
    throw new Error("Publication artifact contains invalid image tags");
  }
  return metadata.tags;
}

export async function publish(
  { ref },
  {
    gh = runGh,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    requestId = randomUUID(),
    log = console.log,
  } = {}
) {
  gh(["auth", "status", "--hostname", "github.com"]);
  // GitHub only accepts dispatches for workflows registered on the default branch.
  // Check that prerequisite even when the execution ref is the maintenance branch.
  try {
    gh(["api", `repos/${repository}/contents/.github/workflows/${workflow}?ref=main`]);
  } catch (cause) {
    throw new Error(
      `Cannot confirm ${workflow} on ${repository}:main. If PR #1 is not merged, merge PR #1 first; --ref cannot bypass GitHub's default-branch workflow requirement. Check gh authentication/repository access too. ${cause.message}`,
      { cause }
    );
  }
  const registered = JSON.parse(gh(["api", `repos/${repository}/actions/workflows/${workflow}`]));
  if (registered.state !== "active")
    throw new Error(
      `Publication workflow is not active (state=${registered.state}); enable it in GitHub Actions first`
    );
  if (ref !== "main")
    gh([
      "api",
      `repos/${repository}/contents/.github/workflows/${workflow}?ref=${encodeURIComponent(ref)}`,
    ]);
  gh([
    "workflow",
    "run",
    workflow,
    "--repo",
    repository,
    "--ref",
    ref,
    "--raw-field",
    `request_id=${requestId}`,
  ]);
  log(`Dispatched ${repository}@${ref}; request_id=${requestId}`);
  let run;
  for (let attempt = 0; attempt < 25; attempt++) {
    run = parseRunList(
      gh([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        workflow,
        "--branch",
        ref,
        "--event",
        "workflow_dispatch",
        "--limit",
        "100",
        "--json",
        "databaseId,displayTitle,event,headBranch",
      ]),
      requestId,
      ref
    );
    if (run) break;
    if (attempt < 24) await sleep(5_000);
  }
  if (!run)
    throw new Error(
      `Workflow run was not registered after 25 lookups; request_id=${requestId}. No publication success is claimed. Inspect GitHub Actions before dispatching again.`
    );
  const runId = String(run.databaseId);
  const url = `https://github.com/${repository}/actions/runs/${runId}`;
  log(url);
  gh(["run", "watch", runId, "--repo", repository, "--exit-status"], { inherit: true });
  requireSuccess(gh(["run", "view", runId, "--repo", repository, "--json", "status,conclusion"]));
  const directory = mkdtempSync(path.join(tmpdir(), "omniroute-publication-"));
  try {
    gh([
      "run",
      "download",
      runId,
      "--repo",
      repository,
      "--name",
      "downstream-publication",
      "--dir",
      directory,
    ]);
    const tags = publishedTags(readFileSync(path.join(directory, "image.json"), "utf8"));
    log(`Published successfully (${url}):\n${tags.join("\n")}`);
    return { runId: run.databaseId, url, tags };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else await publish(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
