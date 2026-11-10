import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("automatic Gather deployment only runs for merged PRs targeting main", async () => {
  const workflow = await readFile(new URL("../.github/workflows/deploy-events-auto.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request:\s*\n\s*types: \[closed\]\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /pull_request\.merged == true/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /pull_request\.merge_commit_sha/);
  assert.match(workflow, /group: events-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /test:cloudflare/);
  assert.match(workflow, /automatic-events-release\.mjs preflight/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /--keep-vars/);
  assert.match(workflow, /automatic-events-release\.mjs verify/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /925c25ad0f89b6deb85838ae36f13d168444b1d0/);
});

test("separate manual release remains opt-in and pinned", async () => {
  const manual = await readFile(new URL("../.github/workflows/deploy-events-manual.yml", import.meta.url), "utf8");
  assert.match(manual, /workflow_dispatch:/);
  assert.doesNotMatch(manual, /^\s+push:/m);
  assert.match(manual, /925c25ad0f89b6deb85838ae36f13d168444b1d0/);
});
