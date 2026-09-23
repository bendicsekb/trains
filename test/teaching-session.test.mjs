import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  GitRepository,
  TeachingSessionController,
  createProcessRunner,
} from "../src/teaching-session.mjs";
import { createTeachingExtension } from "../extensions/teaching-session.js";

const execFileAsync = promisify(execFile);

async function command(command, args, cwd) {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function git(cwd, ...args) {
  const result = await command("git", args, cwd);
  return result.stdout.trim();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trains-teaching-"));
  const remote = path.join(root, "remote.git");
  const worktree = path.join(root, "work");
  await fs.mkdir(worktree);
  await command("git", ["init", "--bare", remote], root);
  await command("git", ["init", "--initial-branch=main"], worktree);
  await git(worktree, "config", "user.name", "Teaching Test");
  await git(worktree, "config", "user.email", "teaching-test@example.invalid");
  await fs.writeFile(path.join(worktree, "README.md"), "baseline\n");
  await git(worktree, "add", "README.md");
  await git(worktree, "commit", "-m", "baseline");
  await git(worktree, "remote", "add", "origin", remote);
  await git(worktree, "push", "--set-upstream", "origin", "main");
  const base = await git(worktree, "rev-parse", "HEAD");
  return { root, remote, worktree, base };
}

class FakeGitHub {
  constructor() {
    this.calls = [];
    this.nextNumber = 41;
    this.pullRequest = null;
  }

  async createOrReuseDraft(input) {
    this.calls.push(input);
    if (!this.pullRequest) {
      this.pullRequest = {
        number: this.nextNumber,
        url: `https://github.invalid/pull/${this.nextNumber}`,
        isDraft: true,
        headRefName: input.head,
        baseRefName: input.base,
      };
    }
    return this.pullRequest;
  }
}

class FakeSessionManager {
  constructor() {
    this.entries = [];
    this.leafId = null;
    this.counter = 0;
    this.sessionId = "pi-teaching-test";
    this.sessionFile = "/private/pi/teaching-test.jsonl";
  }

  nextId(prefix = "entry") {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  appendCustomEntry(customType, data) {
    return this.append({ type: "custom", customType, data });
  }

  appendUser(text) {
    return this.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  }

  append(entry) {
    const full = {
      id: entry.id ?? this.nextId(entry.type),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    this.leafId = full.id;
    return full.id;
  }

  getEntries() { return [...this.entries]; }
  getBranch(fromId = this.leafId) {
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const branch = [];
    let current = fromId ? byId.get(fromId) : undefined;
    while (current) {
      branch.unshift(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch;
  }
  getLeafId() { return this.leafId; }
  getSessionId() { return this.sessionId; }
  getSessionFile() { return this.sessionFile; }
}

function context(manager, worktree) {
  const ui = {
    notifications: [],
    editorText: undefined,
    notify(message, level) { this.notifications.push({ message, level }); },
    setEditorText(text) { this.editorText = text; },
  };
  return {
    cwd: worktree,
    sessionManager: manager,
    ui,
    isIdle: () => true,
    navigateTree: async (targetId) => {
      const target = manager.entries.find((entry) => entry.id === targetId);
      if (!target) throw new Error(`missing target ${targetId}`);
      manager.leafId = target.parentId;
      const text = target.message?.content?.find((part) => part.type === "text")?.text;
      return { cancelled: false, editorText: text };
    },
  };
}

async function controllerFixture() {
  const files = await fixture();
  const manager = new FakeSessionManager();
  const pi = context(manager, files.worktree);
  const github = new FakeGitHub();
  const gitRepo = new GitRepository({ cwd: files.worktree, run: createProcessRunner() });
  const controller = new TeachingSessionController({
    gitFactory: () => gitRepo,
    githubFactory: () => github,
    id: () => "teaching-test",
  });
  await controller.start(pi);
  return { ...files, manager, pi, github, controller };
}

async function prompt({ controller, manager, pi, text, change }) {
  const entryId = manager.appendUser(text);
  const record = await controller.recordPrompt(text, pi);
  assert.equal(record.piEntryId, entryId);
  await change?.();
  await controller.settle(pi);
  return controller.state.prompts.find((candidate) => candidate.id === record.id);
}

async function realisticPrompt({ controller, manager, pi, text, change }) {
  const record = await controller.recordPrompt(text, pi);
  const entryId = manager.appendUser(text);
  await change?.();
  await controller.settle(pi);
  const settled = controller.state.prompts.find((candidate) => candidate.id === record.id);
  assert.equal(settled.piEntryId, entryId);
  return settled;
}

test("start records a clean checkpoint and rejects dirty repositories", async () => {
  const files = await fixture();
  await fs.writeFile(path.join(files.worktree, "unrelated.txt"), "keep me\n");
  const manager = new FakeSessionManager();
  const pi = context(manager, files.worktree);
  const controller = new TeachingSessionController({
    gitFactory: (cwd) => new GitRepository({ cwd, run: createProcessRunner() }),
    githubFactory: () => new FakeGitHub(),
    id: () => "dirty-test",
  });
  await assert.rejects(() => controller.start(pi), /clean Git working tree/);
  assert.equal(await git(files.worktree, "branch", "--show-current"), "main");
  assert.equal((await git(files.worktree, "branch", "--list", "teach/*")).trim(), "");
});

test("read-only prompt records one boundary without an empty commit or PR", async () => {
  const run = await controllerFixture();
  const promptRecord = await prompt({ ...run, text: "Inspect the fixture and explain where the feature belongs." });
  assert.equal(promptRecord.status, "read_only");
  assert.equal(run.controller.state.prompts.length, 1);
  assert.equal(run.controller.state.pullRequest, null);
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), run.base);
  assert.equal(await git(run.worktree, "ls-remote", "--heads", run.remote, `refs/heads/${run.controller.state.sessionBranch}`), "");
});

test("prompt mapping tolerates Pi persisting the user entry after before_agent_start", async () => {
  const run = await controllerFixture();
  const promptRecord = await realisticPrompt({
    ...run,
    text: "Inspect the fixture without changing it.",
  });
  assert.equal(promptRecord.status, "read_only");
  assert.equal(promptRecord.parentEntryId, run.manager.entries[0].id);
});

test("each settled code prompt makes one unsigned commit and reuses one PR", async () => {
  const run = await controllerFixture();
  const first = await prompt({
    ...run,
    text: "Implement the first bounded change.",
    change: async () => fs.writeFile(path.join(run.worktree, "one.txt"), "one\n"),
  });
  const second = await prompt({
    ...run,
    text: "Implement the second bounded change.",
    change: async () => fs.writeFile(path.join(run.worktree, "two.txt"), "two\n"),
  });
  assert.equal(first.status, "published");
  assert.equal(second.status, "published");
  assert.notEqual(first.commit, second.commit);
  assert.equal(await git(run.worktree, "show", "-s", "--format=%G?", first.commit), "N");
  assert.equal(await git(run.worktree, "rev-parse", `refs/remotes/origin/${run.controller.state.sessionBranch}`), second.commit);
  assert.equal(run.github.calls.length, 2);
  assert.equal(run.github.calls[0].head, run.github.calls[1].head);
  assert.equal(run.controller.state.pullRequest.number, 41);
});

test("blank rollback feedback and busy rollback preserve all refs", async () => {
  const run = await controllerFixture();
  await prompt({
    ...run,
    text: "Implement a code change.",
    change: async () => fs.writeFile(path.join(run.worktree, "change.txt"), "change\n"),
  });
  const before = await git(run.worktree, "rev-parse", "HEAD");
  await assert.rejects(() => run.controller.rollback("1", "   ", run.pi), /explanation is required/);
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), before);
  assert.equal(run.controller.state.rollbacks.length, 0);
  const busyPi = { ...run.pi, isIdle: () => false };
  await assert.rejects(() => run.controller.rollback("1", "Something went wrong", busyPi), /current Pi prompt/);
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), before);
  assert.equal(run.controller.state.rollbacks.length, 0);
});

test("rollback preserves the abandoned branch, restores code and context, then publishes a rewrite", async () => {
  const run = await controllerFixture();
  const first = await prompt({
    ...run,
    text: "Add the first file.",
    change: async () => fs.writeFile(path.join(run.worktree, "one.txt"), "one\n"),
  });
  const second = await prompt({
    ...run,
    text: "Add the second file.",
    change: async () => fs.writeFile(path.join(run.worktree, "two.txt"), "two\n"),
  });
  const abandoned = await prompt({
    ...run,
    text: "Make the flawed third change.",
    change: async () => {
      await fs.rm(path.join(run.worktree, "one.txt"));
      await fs.writeFile(path.join(run.worktree, "bad.txt"), "bad\n");
    },
  });
  const abandonedTip = abandoned.commit;
  const explanation = "The third change removed a working file; keep the earlier behavior and try a narrower implementation.";
  await run.controller.rollback("3", explanation, run.pi);

  const rollback = run.controller.state.rollbacks[0];
  assert.equal(rollback.explanation, explanation);
  assert.equal(rollback.abandonedTip, abandonedTip);
  assert.equal(rollback.backupRemoteSha, abandonedTip);
  assert.equal(run.controller.state.status, "awaiting_rewrite");
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), second.commit);
  assert.equal(await fs.readFile(path.join(run.worktree, "one.txt"), "utf8"), "one\n");
  await assert.rejects(() => fs.access(path.join(run.worktree, "bad.txt")));
  assert.equal(await git(run.worktree, "ls-remote", "--heads", run.remote, `refs/heads/${rollback.backupBranch}`), `${abandonedTip}\trefs/heads/${rollback.backupBranch}`);
  assert.equal(run.pi.ui.editorText, "Make the flawed third change.");
  assert.deepEqual(run.manager.getBranch().map((entry) => entry.id), [run.manager.entries[0].id, first.piEntryId, run.manager.entries.find((entry) => entry.id === second.piEntryId).id]);
  assert.ok(rollback.abandonedEntryIds.includes(abandoned.piEntryId));
  assert.ok(!run.manager.getBranch().some((entry) => entry.id === abandoned.piEntryId));

  const rewritten = await prompt({
    ...run,
    text: "Make the narrower corrected third change.",
    change: async () => fs.writeFile(path.join(run.worktree, "good.txt"), "good\n"),
  });
  assert.equal(rewritten.rewriteOf, abandoned.id);
  assert.equal(rewritten.status, "published");
  assert.equal(run.controller.state.pullRequest.number, 41);
  assert.equal(run.github.calls.length, 4);
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), rewritten.commit);
});

test("unexpected worker commit blocks publication without silently remapping the prompt", async () => {
  const run = await controllerFixture();
  const entryId = run.manager.appendUser("The worker should not commit this prompt.");
  const record = await run.controller.recordPrompt("The worker should not commit this prompt.", run.pi);
  assert.equal(record.piEntryId, entryId);
  await fs.writeFile(path.join(run.worktree, "worker.txt"), "worker\n");
  await git(run.worktree, "add", "worker.txt");
  await git(run.worktree, "commit", "-m", "worker-created-commit");
  await run.controller.settle(run.pi);
  assert.equal(run.controller.state.status, "blocked");
  assert.match(run.controller.state.lastError, /unexpected commit/);
  assert.equal(run.controller.state.operation.stage, "commit");
  assert.equal(record.status, "running");
  assert.equal(run.controller.state.pullRequest, null);
});

test("remote conflict after backup preservation stops rollback with recoverable evidence", async () => {
  const run = await controllerFixture();
  const promptRecord = await prompt({
    ...run,
    text: "Create a change that will be rolled back.",
    change: async () => fs.writeFile(path.join(run.worktree, "change.txt"), "change\n"),
  });
  const branch = run.controller.state.sessionBranch;
  const originalRemoteHead = run.controller.git.remoteHead.bind(run.controller.git);
  let firstSessionRead = true;
  run.controller.git.remoteHead = async (requestedBranch) => {
    const value = await originalRemoteHead(requestedBranch);
    if (requestedBranch === branch && firstSessionRead) {
      firstSessionRead = false;
      await git(run.worktree, "--git-dir", run.remote, "update-ref", `refs/heads/${branch}`, run.base);
    }
    return value;
  };
  await assert.rejects(() => run.controller.rollback("1", "The remote moved unexpectedly.", run.pi), /Remote session branch changed/);
  assert.equal(run.controller.state.status, "blocked");
  assert.equal(run.controller.state.operation.stage, "backup_preserved");
  const rollback = run.controller.state.rollbacks[0];
  assert.equal(rollback.backupRemoteSha, promptRecord.commit);
  assert.equal(await git(run.worktree, "rev-parse", "HEAD"), promptRecord.commit);
  assert.equal(await git(run.worktree, "ls-remote", "--heads", run.remote, `refs/heads/${rollback.backupBranch}`), `${promptRecord.commit}\trefs/heads/${rollback.backupBranch}`);
});

test("session metadata and rollback explanations survive controller restart", async () => {
  const run = await controllerFixture();
  const promptRecord = await prompt({
    ...run,
    text: "Add a change that will be reconsidered.",
    change: async () => fs.writeFile(path.join(run.worktree, "change.txt"), "change\n"),
  });
  await run.controller.rollback("1", "The change was too broad; preserve the earlier boundary.", run.pi);

  const replacement = new TeachingSessionController({
    gitFactory: () => new GitRepository({ cwd: run.worktree, run: createProcessRunner() }),
    githubFactory: () => run.github,
    id: () => "replacement-id",
  });
  assert.equal(await replacement.restore(run.pi), true);
  assert.equal(replacement.state.id, run.controller.state.id);
  assert.equal(replacement.state.status, "awaiting_rewrite");
  assert.equal(replacement.state.rollbacks[0].explanation, "The change was too broad; preserve the earlier boundary.");
  assert.equal(replacement.state.rollbacks[0].abandonedTip, promptRecord.commit);
});

test("a failed push is resumable without another commit or duplicate PR", async () => {
  const files = await fixture();
  const manager = new FakeSessionManager();
  const pi = context(manager, files.worktree);
  const github = new FakeGitHub();
  const processRun = createProcessRunner();
  let failPush = true;
  const run = async (commandName, args, options) => {
    if (commandName === "git" && args[0] === "push" && failPush) {
      failPush = false;
      return { code: 1, stdout: "", stderr: "simulated push outage" };
    }
    return processRun(commandName, args, options);
  };
  const repo = new GitRepository({ cwd: files.worktree, run });
  const controller = new TeachingSessionController({
    gitFactory: () => repo,
    githubFactory: () => github,
    id: () => "push-recovery",
  });
  await controller.start(pi);
  const record = await prompt({
    controller,
    manager,
    pi,
    text: "Publish this change despite one transient outage.",
    change: async () => fs.writeFile(path.join(files.worktree, "recovery.txt"), "recovery\n"),
  });
  assert.equal(controller.state.status, "blocked");
  assert.equal(controller.state.operation.stage, "push");
  assert.equal(record.commit !== undefined, true);
  const replacement = new TeachingSessionController({
    gitFactory: () => repo,
    githubFactory: () => github,
    id: () => "unused",
  });
  await replacement.restore(pi);
  await replacement.resume();
  assert.equal(replacement.state.status, "active");
  assert.equal(replacement.state.prompts[0].status, "published");
  assert.equal(github.calls.length, 1);
  assert.equal(await git(files.worktree, "rev-parse", "HEAD"), record.commit);
});

test("extension exposes the teaching commands and lifecycle guards", () => {
  const commands = new Map();
  const hooks = new Map();
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool() {},
    on(name, handler) { hooks.set(name, handler); },
  };
  createTeachingExtension()(pi);
  for (const name of ["teach-start", "teach-status", "teach-rollback", "teach-resume-publication", "teach-end"]) {
    assert.ok(commands.has(name), name);
  }
  for (const name of ["session_start", "before_agent_start", "agent_end", "input", "session_before_tree", "session_before_fork"]) {
    assert.ok(hooks.has(name), name);
  }
});
