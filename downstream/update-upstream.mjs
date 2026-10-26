#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const help = `Usage: node downstream/update-upstream.mjs [--config PATH]

Resolve the latest stable upstream GitHub release to its full commit SHA.
Update only downstream config, resetting revision to 1 on an upstream change.
This command does not deploy, publish an image, or modify production source.
`;

export function parseArgs(args) {
  let config = path.join(here, "config.json");
  let seen = false;
  for (let index = 0; index < args.length; index++) {
    if (["--help", "-h"].includes(args[index])) return { help: true };
    if (args[index] !== "--config") throw new Error(`Unknown option: ${args[index]}`);
    if (seen) throw new Error("Duplicate option: --config");
    seen = true;
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --config");
    config = path.resolve(value);
  }
  return { config };
}

export async function resolveLatestRelease(config, request = fetch, token = process.env.GITHUB_TOKEN) {
  const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(config.upstreamRepository)?.[1];
  if (!repository) throw new Error("upstreamRepository must be an HTTPS GitHub repository URL");
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "OmniRoute-downstream-update" };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function get(endpoint) {
    const response = await request(`${base}${endpoint}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`GitHub API ${endpoint}: HTTP ${response.status}`);
    return response.json();
  }
  const release = await get("/releases/latest");
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error("Latest release is not a supported stable release");
  let object = (await get(`/git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
  const visited = new Set();
  while (object?.type === "tag") {
    if (!/^[a-f0-9]{40}$/.test(object.sha) || visited.has(object.sha) || visited.size >= 10) throw new Error("Invalid or cyclic annotated tag chain");
    visited.add(object.sha);
    object = (await get(`/git/tags/${object.sha}`)).object;
  }
  if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Release tag does not resolve to a full commit SHA");
  return { upstreamTag: release.tag_name, upstreamCommit: object.sha };
}

export function updatedConfig(config, release) {
  if (config.upstreamTag === release.upstreamTag && config.upstreamCommit === release.upstreamCommit) return config;
  return { ...config, ...release, revision: 1 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void process.stdout.write(help);
  const config = JSON.parse(readFileSync(options.config, "utf8"));
  const release = await resolveLatestRelease(config);
  const next = updatedConfig(config, release);
  if (next !== config) writeFileSync(options.config, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ changed: next !== config, ...release, revision: next.revision })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
