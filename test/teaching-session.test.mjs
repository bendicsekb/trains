import assert from "node:assert/strict";
import { test } from "node:test";

import { TeachingSessionController } from "../src/teaching-session.mjs";

function fakeTeachingContext() {
  const messages = [];
  const entries = [];
  return {
    cwd: "/tmp/teaching-backport",
    isIdle: () => true,
    sendUserMessage: async (text) => messages.push(text),
    ui: { notify() {} },
    sessionManager: {
      appendCustomEntry: (customType, data) => entries.push({ customType, data }),
      getEntries: () => entries,
      getSessionId: () => "pi-session",
      getSessionFile: () => "/tmp/teaching-backport/session.jsonl",
    },
    messages,
  };
}

function fakeGit() {
  const parents = new Map([
    ["aaaaaaa", "0000000"],
    ["bbbbbbb", "aaaaaaa"],
    ["ccccccc", "0000000"],
    ["ddddddd", "ccccccc"],
  ]);
  const localRefs = new Map();
  const remotes = new Map([["teach/session", "remote-b"]]);
  const calls = [];
  let currentBranch = "main";
  let headValue = "0000000";

  return {
    cwd: "/tmp/teaching-backport",
    calls,
    setHead(value) { headValue = value; },
    setRemote(branch, value) { remotes.set(branch, value); },
    async commonDir() { return "/tmp/teaching-backport/.git"; },
    async status() { return ""; },
    async assertClean() {},
    async head() { return headValue; },
    async branch() { return currentBranch; },
    async switchNewBranch(branch, startPoint) {
      currentBranch = branch;
      headValue = startPoint;
    },
    async ensureOnBranch(branch) { assert.equal(currentBranch, branch); },
    async remoteHead(branch) { return remotes.get(branch) ?? null; },
    async createBranch(branch, commit) {
      localRefs.set(branch, commit);
    },
    async pushBranch(branch, options) {
      calls.push({ branch, options });
      remotes.set(branch, branch === currentBranch ? headValue : localRefs.get(branch));
    },
    async resolveCommit(commit) {
      if (!parents.has(commit)) throw new Error(`unknown commit ${commit}`);
      return commit;
    },
    async commitParent(commit) { return parents.get(commit); },
  };
}

test("agent-owned backport preserves the old chain and rewrites checkpoint mappings", async () => {
  const git = fakeGit();
  const ctx = fakeTeachingContext();
  const controller = new TeachingSessionController({
    gitFactory: () => git,
    githubFactory: () => ({ createOrReuseDraft: async () => ({ number: 1, url: "https://example.test/pr/1", isDraft: true }) }),
    storeFactory: () => ({ save() {} }),
    id: () => "teach-test",
    clock: () => "2026-09-25T00:00:00.000Z",
  });

  await controller.start(ctx);
  git.setRemote(controller.state.sessionBranch, "remote-b");
  controller.state.prompts = [
    { id: "teach-test:p1", sequence: 1, prompt: "A", originalPrompt: "A", status: "published", preCommit: "0000000", commit: "aaaaaaa", remoteSha: "aaaaaaa" },
    { id: "teach-test:p2", sequence: 2, prompt: "B", originalPrompt: "B", status: "published", preCommit: "aaaaaaa", commit: "bbbbbbb", remoteSha: "bbbbbbb" },
  ];
  controller.state.pullRequest = { number: 1, url: "https://example.test/pr/1", isDraft: true, base: "main", head: "teach/session", headSha: "bbbbbbb" };
  controller.state.status = "active";
  git.setHead("bbbbbbb");

  await controller.backport("1", ctx);
  assert.match(ctx.messages[0], /You own the entire history rewrite/);
  assert.equal(controller.state.operation.backupRemoteSha, "bbbbbbb");

  git.setHead("ddddddd");
  await controller.completeBackport({
    checkpoints: [
      { sequence: 1, commit: "ccccccc" },
      { sequence: 2, commit: "ddddddd" },
    ],
    summary: "Moved the shared test setup into checkpoint A and removed the duplicate from B.",
  });
  await controller.resume();

  assert.equal(controller.state.operation, null);
  assert.equal(controller.state.status, "active");
  assert.equal(controller.state.prompts[0].commit, "ccccccc");
  assert.equal(controller.state.prompts[1].preCommit, "ccccccc");
  assert.equal(controller.state.prompts[1].commit, "ddddddd");
  assert.equal(controller.state.pullRequest.headSha, "ddddddd");
  assert.equal(controller.state.backports[0].previousPrompts[1].commit, "bbbbbbb");
  assert.equal(controller.state.backports[0].backupRemoteSha, "bbbbbbb");
  assert.equal(controller.state.backports[0].rewrite.checkpoints[1].commit, "ddddddd");
  assert.equal(git.calls.at(-1).options.forceWithLease, "remote-b");
});
