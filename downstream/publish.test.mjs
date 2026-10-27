import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  parseRunList,
  requireSuccess,
  publishedTags,
  publish,
  runGh,
} from "./publish.mjs";

const requestId = "cfcbd702-016c-48f0-a54f-f39a412b7fbd";
const ref = "downstream/patch-build";
const matching = {
  databaseId: 123,
  displayTitle: `Downstream GHCR image / ${requestId}`,
  event: "workflow_dispatch",
  headBranch: ref,
};
const tags = [
  "ghcr.io/yooztech/omniroute:3.8.52-fork.1",
  "ghcr.io/yooztech/omniroute:sha-ad6f33f66bda-fork.1",
];

test("CLI rejects unsafe refs, unknown and repeated options before invoking gh", () => {
  assert.deepEqual(parseArgs([]), { ref: "main" });
  assert.deepEqual(parseArgs(["--ref", ref]), { ref });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  for (const args of [
    ["--ref"],
    ["--ref", "feature/untrusted"],
    ["--ref", "main; touch /tmp/unsafe"],
    ["--repo", "other/repo"],
    ["--ref", "main", "--ref", ref],
    ["--push"],
  ]) {
    assert.throws(() => parseArgs(args), /Only --ref/);
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./publish.mjs", import.meta.url)), ...args],
      { encoding: "utf8", env: { ...process.env, PATH: "" } }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Only --ref/);
    assert.equal(result.stdout, "");
  }
});

test("missing gh is a real executable failure, never a simulated success", () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.throws(
      () => runGh(["auth", "status"]),
      (error) => error.exitCode === 1 && /ENOENT/.test(error.message)
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("run correlation ignores unrelated, old, wrong-event and wrong-branch runs", () => {
  const unrelated = [
    { ...matching, databaseId: 1, displayTitle: "Downstream GHCR image / old-request" },
    { ...matching, databaseId: 2, event: "push" },
    { ...matching, databaseId: 3, headBranch: "main" },
  ];
  assert.equal(parseRunList(JSON.stringify(unrelated), requestId, ref), null);
  assert.deepEqual(
    parseRunList(JSON.stringify([...unrelated, matching]), requestId, ref),
    matching
  );
  assert.throws(
    () => parseRunList(JSON.stringify([matching, matching]), requestId, ref),
    /ambiguous/
  );
  for (const databaseId of [null, 0, -1, "123", 1.2]) {
    assert.throws(
      () => parseRunList(JSON.stringify([{ ...matching, databaseId }]), requestId, ref),
      /invalid workflow run ID/
    );
  }
  assert.throws(() => parseRunList("{}", requestId, ref), /invalid workflow run list/);
  assert.throws(() => parseRunList("not JSON", requestId, ref), SyntaxError);
});

test("success requires a completed successful run, not merely a successful watch invocation", () => {
  assert.equal(
    requireSuccess('{"status":"completed","conclusion":"success"}').conclusion,
    "success"
  );
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "skipped",
    "neutral",
    "action_required",
    null,
  ]) {
    assert.throws(
      () => requireSuccess(JSON.stringify({ status: "completed", conclusion })),
      /did not succeed/
    );
  }
  assert.throws(
    () => requireSuccess('{"status":"in_progress","conclusion":"success"}'),
    /did not succeed/
  );
});

test("published addresses must come from valid fork GHCR artifact metadata", () => {
  assert.deepEqual(publishedTags(JSON.stringify({ tags })), tags);
  for (const metadata of [
    {},
    { tags: [] },
    { tags: "ghcr.io/yooztech/omniroute:tag" },
    { tags: [null] },
    { tags: ["ghcr.io/yooztech/omniroute:latest"] },
    { tags: ["docker.io/yooztech/omniroute:tag"] },
    { tags: ["ghcr.io/attacker/omniroute:tag"] },
    { tags: ["ghcr.io/yooztech/omniroute:tag\nspoof"] },
  ]) {
    assert.throws(() => publishedTags(JSON.stringify(metadata)), /invalid image tags/);
  }
  assert.throws(() => publishedTags("not JSON"), SyntaxError);
});

// The transport is the only substituted boundary: exercise the actual dispatch,
// registration retry, result validation, artifact reader and cleanup state machine.
function transport({
  registeredAfter = 1,
  state = "active",
  status = "completed",
  conclusion = "success",
  fail = null,
  artifact = { tags },
} = {}) {
  const calls = [];
  let lookups = 0;
  let directory;
  return {
    calls,
    get directory() {
      return directory;
    },
    gh(args) {
      calls.push(args);
      if (fail?.(args)) throw new Error("HTTP 403: Resource not accessible by integration");
      if (args[0] === "api" && args[1].includes("/actions/workflows/"))
        return JSON.stringify({ state });
      if (args[0] === "run" && args[1] === "list")
        return JSON.stringify(++lookups >= registeredAfter ? [matching] : []);
      if (args[0] === "run" && args[1] === "view") return JSON.stringify({ status, conclusion });
      if (args[0] === "run" && args[1] === "download") {
        directory = args[args.indexOf("--dir") + 1];
        writeFileSync(`${directory}/image.json`, JSON.stringify(artifact));
      }
      return "";
    },
  };
}

test("unmerged default-branch workflow fails preflight without dispatch even with --ref", async () => {
  const io = transport({ fail: (args) => args[0] === "api" && args[1].endsWith("?ref=main") });
  await assert.rejects(publish({ ref }, { gh: io.gh, requestId }), /merge PR #1 first.*HTTP 403/s);
  assert.equal(
    io.calls.some((args) => args[0] === "workflow"),
    false
  );
});

test("disabled workflow and denied dispatch are fatal without watching or claiming success", async () => {
  for (const options of [
    { state: "disabled_manually" },
    { fail: (args) => args[0] === "workflow" },
  ]) {
    const io = transport(options);
    await assert.rejects(publish({ ref }, { gh: io.gh, requestId }), /not active|HTTP 403/);
    assert.equal(
      io.calls.some((args) => args[1] === "watch"),
      false
    );
  }
});

test("registration retries are bounded and never watch another run", async () => {
  const io = transport({ registeredAfter: Infinity });
  let sleeps = 0;
  await assert.rejects(
    publish(
      { ref },
      {
        gh: io.gh,
        requestId,
        log() {},
        sleep: async () => {
          sleeps++;
        },
      }
    ),
    /not registered after 25 lookups/
  );
  assert.equal(sleeps, 24);
  assert.equal(io.calls.filter((args) => args[1] === "list").length, 25);
  assert.equal(
    io.calls.some((args) => args[1] === "watch"),
    false
  );
});

test("delayed successful run reports artifact addresses and removes downloaded files", async () => {
  const io = transport({ registeredAfter: 3 });
  const logs = [];
  const result = await publish(
    { ref },
    { gh: io.gh, requestId, log: (line) => logs.push(line), sleep: async () => {} }
  );
  assert.deepEqual(result.tags, tags);
  assert.equal(result.runId, 123);
  assert.equal(existsSync(io.directory), false);
  assert.match(logs.at(-1), /Published successfully/);
  assert.ok(logs.at(-1).includes(tags[0]));
});

test("failed watch, failed final status and invalid artifact cannot claim publication success", async () => {
  for (const options of [
    { fail: (args) => args[1] === "watch" },
    { conclusion: "failure" },
    { artifact: { tags: ["ghcr.io/yooztech/omniroute:latest"] } },
    { fail: (args) => args[1] === "download" },
  ]) {
    const io = transport(options);
    const logs = [];
    await assert.rejects(
      publish({ ref }, { gh: io.gh, requestId, log: (line) => logs.push(line) }),
      /HTTP 403|did not succeed|invalid image tags/
    );
    assert.equal(
      logs.some((line) => line.includes("Published successfully")),
      false
    );
    if (io.directory) assert.equal(existsSync(io.directory), false);
  }
});
