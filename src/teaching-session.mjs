import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const TEACHING_ENTRY = "teaching.session.v1";
export const TEACHING_SCHEMA_VERSION = 1;

const execFileAsync = promisify(execFile);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function now() {
  return new Date().toISOString();
}

function shortHash(value) {
  return String(value).slice(0, 12);
}

function safeBranchPart(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function promptText(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "user") return null;
  if (typeof entry.message.content === "string") return entry.message.content;
  return (entry.message.content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("");
}

function isActiveStatus(status) {
  return ["active", "publishing", "rolling_back", "awaiting_rewrite", "blocked"].includes(status);
}

function isCodePromptStatus(status) {
  return ["published", "read_only", "rolled_back"].includes(status);
}

function errorWithResult(message, result) {
  const detail = [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();
  const error = new Error(detail ? `${message}: ${detail}` : message);
  error.result = result;
  return error;
}

export function createProcessRunner({ execFileImpl = execFileAsync } = {}) {
  return async (command, args, options = {}) => {
    try {
      const result = await execFileImpl(command, args, {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      });
      return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    } catch (error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message ?? "",
      };
    }
  };
}

export class GitRepository {
  constructor({ cwd, run = createProcessRunner(), remote = "origin" } = {}) {
    if (!cwd) throw new Error("GitRepository requires cwd");
    this.cwd = cwd;
    this.run = run;
    this.remote = remote;
  }

  async command(args, label = `git ${args.join(" ")}`) {
    const result = await this.run("git", args, { cwd: this.cwd });
    if (result.code !== 0) throw errorWithResult(label, result);
    return result.stdout.trimEnd();
  }

  async tryCommand(args) {
    return this.run("git", args, { cwd: this.cwd });
  }

  async commonDir() {
    const value = await this.command(["rev-parse", "--git-common-dir"], "Unable to locate Git common directory");
    return path.resolve(this.cwd, value.trim());
  }

  async head() {
    return this.command(["rev-parse", "HEAD"], "Unable to read Git HEAD");
  }

  async branch() {
    return this.command(["branch", "--show-current"], "Unable to read the current Git branch");
  }

  async status() {
    return this.command(["status", "--porcelain=v1", "--untracked-files=all"], "Unable to inspect the Git working tree");
  }

  async assertClean(message = "Teaching sessions must start from a clean Git working tree") {
    const status = await this.status();
    if (status) throw new Error(`${message}:\n${status}`);
  }

  async switchNewBranch(branch, startPoint) {
    await this.command(["switch", "--create", branch, startPoint], `Unable to create teaching session branch ${branch}`);
  }

  async ensureOnBranch(branch) {
    const current = await this.branch();
    if (current !== branch) throw new Error(`Expected teaching session branch ${branch}, found ${current || "detached HEAD"}`);
  }

  async addAndCommit(message) {
    await this.command(["add", "--all"], "Unable to stage the teaching prompt changes");
    await this.command([
      "-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false",
      "commit", "--no-gpg-sign", "-m", message,
    ], "Unable to publish the teaching prompt commit");
    return this.head();
  }

  async commitParent(commit) {
    return this.command(["rev-parse", `${commit}^`], `Unable to read parent of ${commit}`);
  }

  async commitSignatureStatus(commit) {
    return this.command(["show", "-s", "--format=%G?", commit], `Unable to inspect signature of ${commit}`);
  }

  async assertUnsigned(commit) {
    const status = await this.commitSignatureStatus(commit);
    if (status !== "N") throw new Error(`Teaching commit ${commit} is signed or has an unknown signature state (${status})`);
  }

  async remoteHead(branch = undefined) {
    const ref = branch ?? await this.branch();
    const result = await this.tryCommand(["ls-remote", "--heads", this.remote, `refs/heads/${ref}`]);
    if (result.code !== 0) throw errorWithResult(`Unable to inspect remote branch ${ref}`, result);
    const line = result.stdout.trim().split("\n").find(Boolean);
    return line ? line.split(/\s+/)[0] : null;
  }

  async pushBranch(branch, { forceWithLease } = {}) {
    const args = ["push"];
    if (forceWithLease !== undefined) {
      args.push(`--force-with-lease=refs/heads/${branch}:${forceWithLease ?? ""}`);
    } else {
      args.push("--set-upstream");
    }
    args.push(this.remote, `HEAD:refs/heads/${branch}`);
    await this.command(args, `Unable to push teaching branch ${branch}`);
  }

  async createBranch(branch, commit) {
    const existing = await this.tryCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (existing.code !== 0) await this.command(["branch", branch, commit], `Unable to create backup branch ${branch}`);
    const actual = await this.command(["rev-parse", `refs/heads/${branch}`], `Unable to verify backup branch ${branch}`);
    if (actual !== commit) throw new Error(`Backup branch ${branch} points to ${actual}, expected ${commit}`);
  }

  async resetHard(commit) {
    await this.command(["reset", "--hard", commit], `Unable to restore Git checkpoint ${commit}`);
  }

  async isDirectChild(parent, child) {
    try {
      return (await this.commitParent(child)) === parent;
    } catch {
      return false;
    }
  }
}

export class GitHubAdapter {
  constructor({ cwd, run = createProcessRunner(), gh = "gh" } = {}) {
    if (!cwd) throw new Error("GitHubAdapter requires cwd");
    this.cwd = cwd;
    this.run = run;
    this.gh = gh;
  }

  async command(args, label) {
    const result = await this.run(this.gh, args, { cwd: this.cwd });
    if (result.code !== 0) throw errorWithResult(label ?? `gh ${args.join(" ")}`, result);
    return result.stdout.trim();
  }

  async listOpenDrafts(head) {
    const text = await this.command([
      "pr", "list", "--head", head, "--state", "open",
      "--json", "number,url,isDraft,headRefOid,headRefName,baseRefName",
    ], `Unable to find the teaching session pull request for ${head}`);
    const items = JSON.parse(text || "[]");
    return items.filter((item) => item.isDraft !== false);
  }

  async createOrReuseDraft({ head, base, title, body }) {
    const existing = await this.listOpenDrafts(head);
    if (existing.length) {
      const match = existing.find((item) => !item.baseRefName || item.baseRefName === base);
      if (!match) throw new Error(`An open pull request already exists for ${head}, but not against ${base}`);
      return match;
    }

    const output = await this.command([
      "pr", "create", "--draft", "--base", base, "--head", head,
      "--title", title, "--body", body,
    ], `Unable to create the teaching session draft pull request for ${head}`);
    const url = output.split(/\s+/).find((part) => /^https?:\/\//.test(part));
    if (!url) throw new Error(`GitHub did not return a pull request URL: ${output}`);
    const detail = await this.command([
      "pr", "view", url, "--json", "number,url,isDraft,headRefOid,headRefName,baseRefName",
    ], `Unable to inspect the newly created teaching session pull request`);
    return JSON.parse(detail);
  }
}

export class TeachingSessionStore {
  constructor({ commonDir, fsImpl = fs } = {}) {
    if (!commonDir) throw new Error("TeachingSessionStore requires commonDir");
    this.commonDir = commonDir;
    this.fs = fsImpl;
    this.directory = path.join(commonDir, "teaching-sessions");
  }

  filePath(id) {
    return path.join(this.directory, `${safeBranchPart(id)}.json`);
  }

  save(state) {
    this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const target = this.filePath(state.id);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    this.fs.renameSync(temporary, target);
    return target;
  }

  load(id) {
    try {
      return JSON.parse(this.fs.readFileSync(this.filePath(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  list() {
    if (!this.fs.existsSync(this.directory)) return [];
    return this.fs.readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try { return JSON.parse(this.fs.readFileSync(path.join(this.directory, name), "utf8")); } catch { return null; }
      })
      .filter(Boolean);
  }

  findForPiSession({ sessionId, sessionFile }) {
    return this.list()
      .filter((state) => state.piSessionId === sessionId || (sessionFile && state.piSessionFile === sessionFile))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ?? null;
  }
}

export function latestTeachingEntry(ctx) {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === TEACHING_ENTRY && entry.data) return entry.data;
  }
  return null;
}

export function hasActiveTeachingSession(ctx) {
  const entry = latestTeachingEntry(ctx);
  return Boolean(entry && isActiveStatus(entry.status));
}

export class TeachingSessionController {
  constructor({
    gitFactory = (cwd) => new GitRepository({ cwd }),
    githubFactory = (cwd) => new GitHubAdapter({ cwd }),
    storeFactory = (commonDir) => new TeachingSessionStore({ commonDir }),
    id = () => `teach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clock = now,
    notify = () => {},
  } = {}) {
    this.gitFactory = gitFactory;
    this.githubFactory = githubFactory;
    this.storeFactory = storeFactory;
    this.id = id;
    this.clock = clock;
    this.notify = notify;
    this.ctx = null;
    this.git = null;
    this.github = null;
    this.store = null;
    this.state = null;
    this.authorizedNavigation = false;
    this.settling = false;
  }

  attachContext(ctx) {
    this.ctx = ctx;
    if (!ctx) return;
    if (!this.git || this.git.cwd !== ctx.cwd) {
      this.git = this.gitFactory(ctx.cwd);
      this.github = this.githubFactory(ctx.cwd);
      this.store = null;
    }
  }

  async ensureStore() {
    if (!this.store) this.store = this.storeFactory(await this.git.commonDir());
    return this.store;
  }

  persist() {
    if (!this.state || !this.store) return;
    this.state.updatedAt = this.clock();
    this.store.save(this.state);
  }

  appendPiState() {
    const manager = this.ctx?.sessionManager;
    if (typeof manager?.appendCustomEntry === "function" && this.state) {
      manager.appendCustomEntry(TEACHING_ENTRY, {
        id: this.state.id,
        status: this.state.status,
        piSessionId: this.state.piSessionId,
      });
    }
  }

  async restore(ctx = this.ctx) {
    this.attachContext(ctx);
    if (!this.git || !this.ctx?.sessionManager) return false;
    const store = await this.ensureStore();
    const restored = store.findForPiSession({
      sessionId: this.ctx.sessionManager.getSessionId?.(),
      sessionFile: this.ctx.sessionManager.getSessionFile?.(),
    });
    if (!restored) return false;
    this.state = restored;
    this.notify(`Teaching session ${restored.id}: ${restored.status}`, "info");
    return true;
  }

  async start(ctx = this.ctx) {
    this.attachContext(ctx);
    if (!this.git || !this.ctx?.sessionManager) throw new Error("Teaching session requires a Pi session context");
    if (this.state && isActiveStatus(this.state.status)) throw new Error(`Teaching session ${this.state.id} is already active`);
    const trainState = this.ctx.sessionManager.getEntries?.().slice().reverse().find((entry) => entry.type === "custom" && entry.customType === "trains.state.v1")?.data;
    if (trainState && isActiveStatus(trainState.status)) throw new Error(`Cannot start teaching while train ${trainState.trainId ?? "run"} is ${trainState.status}`);
    if (!this.ctx.isIdle?.()) throw new Error("Start teaching only while Pi is idle");

    await this.git.assertClean();
    const baseCommit = await this.git.head();
    const originalBranch = await this.git.branch();
    if (!originalBranch) throw new Error("Teaching sessions require a named starting Git branch");
    const id = this.id();
    const sessionBranch = `teach/${safeBranchPart(id)}`;
    await this.git.switchNewBranch(sessionBranch, baseCommit);
    this.store = await this.ensureStore();
    this.state = {
      schemaVersion: TEACHING_SCHEMA_VERSION,
      id,
      status: "active",
      cwd: this.ctx.cwd,
      piSessionId: this.ctx.sessionManager.getSessionId?.(),
      piSessionFile: this.ctx.sessionManager.getSessionFile?.(),
      baseCommit,
      originalBranch,
      sessionBranch,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      prompts: [],
      rollbacks: [],
      pullRequest: null,
      operation: null,
      pendingPromptId: null,
    };
    this.persist();
    this.appendPiState();
    this.notify(`Teaching session started on ${sessionBranch} at ${baseCommit}`, "info");
    return clone(this.state);
  }

  currentPrompt() {
    return this.state?.prompts?.find((prompt) => prompt.id === this.state.pendingPromptId) ?? null;
  }

  findPrompt(identifier) {
    if (!this.state) throw new Error("No teaching session is active");
    const text = String(identifier ?? "").trim();
    const prompt = this.state.prompts.find((candidate) => candidate.id === text)
      ?? this.state.prompts.find((candidate) => String(candidate.sequence) === text);
    if (!prompt) throw new Error(`Unknown teaching prompt ${text || "(empty)"}`);
    return prompt;
  }

  findPiUserEntry(prompt, ctx = this.ctx) {
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const exact = branch.findLast?.((entry) => promptText(entry) === prompt) ?? [...branch].reverse().find((entry) => promptText(entry) === prompt);
    if (exact) return exact;
    const entries = ctx?.sessionManager?.getEntries?.() ?? [];
    return [...entries].reverse().find((entry) => promptText(entry) === prompt) ?? null;
  }

  async recordPrompt(prompt, ctx = this.ctx) {
    this.attachContext(ctx);
    if (!this.state || !isActiveStatus(this.state.status)) return null;
    if (this.state.operation) throw new Error("Teaching session has an unfinished operation; run /teach-resume-publication first");
    if (this.state.pendingPromptId) throw new Error("Teaching session is already tracking a prompt; wait for it to settle");
    if (!["active", "awaiting_rewrite"].includes(this.state.status)) throw new Error(`Teaching session cannot accept a prompt while ${this.state.status}`);

    const entry = this.findPiUserEntry(prompt, ctx);
    await this.git.ensureOnBranch(this.state.sessionBranch);
    await this.git.assertClean("Teaching prompts must begin from a clean session branch");
    const preCommit = await this.git.head();
    const rewriteOf = this.state.status === "awaiting_rewrite" ? this.state.rewriteBoundaryPromptId : null;
    const record = {
      id: `${this.state.id}:p${this.state.prompts.length + 1}`,
      sequence: this.state.prompts.length + 1,
      prompt,
      originalPrompt: prompt,
      piSessionId: ctx.sessionManager.getSessionId?.(),
      piSessionFile: ctx.sessionManager.getSessionFile?.(),
      // Pi emits before_agent_start before it persists the user message. The
      // entry is resolved at settle time; the current leaf is the parent
      // boundary available at prompt start.
      piEntryId: entry?.id ?? null,
      parentEntryId: entry?.parentId ?? ctx.sessionManager.getLeafId?.() ?? null,
      preCommit,
      status: "running",
      rewriteOf,
      startedAt: this.clock(),
    };
    this.state.prompts.push(record);
    this.state.pendingPromptId = record.id;
    this.state.status = "active";
    delete this.state.rewriteBoundaryPromptId;
    this.persist();
    return clone(record);
  }

  async detectChanges() {
    return Boolean(await this.git.status());
  }

  async settle(ctx = this.ctx, { willRetry = false } = {}) {
    this.attachContext(ctx);
    if (willRetry || !this.state?.pendingPromptId || this.settling) return;
    this.settling = true;
    try {
      await this.publishPending();
    } catch (error) {
      this.failOperation(error);
    } finally {
      this.settling = false;
    }
  }

  async publishPending() {
    const prompt = this.currentPrompt();
    if (!prompt) return;
    const entry = prompt.piEntryId ? null : this.findPiUserEntry(prompt.prompt, this.ctx);
    if (!prompt.piEntryId && !entry?.id) throw new Error("Unable to map the settled prompt to a persisted Pi session entry");
    if (entry?.id) {
      prompt.piEntryId = entry.id;
      prompt.parentEntryId = entry.parentId ?? prompt.parentEntryId;
      prompt.piSessionId = this.ctx?.sessionManager?.getSessionId?.() ?? prompt.piSessionId;
      prompt.piSessionFile = this.ctx?.sessionManager?.getSessionFile?.() ?? prompt.piSessionFile;
      this.persist();
    }
    await this.git.ensureOnBranch(this.state.sessionBranch);
    const recovering = this.state.status === "blocked" && this.state.operation?.kind === "publish";
    const operation = this.state.operation?.kind === "publish"
      ? this.state.operation
      : { kind: "publish", promptId: prompt.id, stage: "commit", preCommit: prompt.preCommit };
    this.state.operation = operation;
    this.state.status = "publishing";
    this.persist();

    let head = await this.git.head();
    if (operation.stage === "commit") {
      if (head !== prompt.preCommit) {
        if (recovering && await this.git.isDirectChild(prompt.preCommit, head) && (await this.git.status()) === "") {
          await this.git.assertUnsigned(head);
          operation.commit = head;
        } else {
          throw new Error(`Pi created an unexpected commit while processing prompt ${prompt.sequence}: ${head}`);
        }
      } else if (await this.detectChanges()) {
        operation.commit = await this.git.addAndCommit(`teach(${prompt.sequence}): ${prompt.prompt.replace(/\s+/g, " ").trim().slice(0, 72)}`);
        await this.git.assertUnsigned(operation.commit);
      } else {
        prompt.status = "read_only";
        prompt.commit = head;
        prompt.finishedAt = this.clock();
        this.state.operation = null;
        this.state.pendingPromptId = null;
        this.state.status = "active";
        this.persist();
        this.notify(`Teaching prompt ${prompt.sequence} completed without code changes`, "info");
        return;
      }
      prompt.commit = operation.commit;
      operation.stage = "push";
      this.persist();
      head = operation.commit;
    }

    if (operation.stage === "push") {
      await this.git.pushBranch(this.state.sessionBranch);
      const remoteSha = await this.git.remoteHead(this.state.sessionBranch);
      if (remoteSha !== operation.commit) throw new Error(`Remote teaching branch ${this.state.sessionBranch} is ${remoteSha}, expected ${operation.commit}`);
      prompt.remoteSha = remoteSha;
      operation.stage = "pull_request";
      this.persist();
    }

    if (operation.stage === "pull_request") {
      const titlePrompt = this.state.prompts.find((candidate) => candidate.status === "published") ?? prompt;
      const pullRequest = await this.github.createOrReuseDraft({
        head: this.state.sessionBranch,
        base: this.state.originalBranch,
        title: `Teaching session: ${titlePrompt.prompt.replace(/\s+/g, " ").trim().slice(0, 72)}`,
        body: `Teaching session ${this.state.id}. Each settled code-producing prompt is published as an unsigned checkpoint.`,
      });
      this.state.pullRequest = {
        number: pullRequest.number,
        url: pullRequest.url,
        isDraft: pullRequest.isDraft !== false,
        base: pullRequest.baseRefName ?? this.state.originalBranch,
        head: pullRequest.headRefName ?? this.state.sessionBranch,
        headSha: pullRequest.headRefOid ?? prompt.remoteSha,
      };
      prompt.pullRequestNumber = pullRequest.number;
    }

    prompt.status = "published";
    prompt.finishedAt = this.clock();
    this.state.operation = null;
    this.state.pendingPromptId = null;
    this.state.status = "active";
    this.persist();
    this.notify(`Teaching prompt ${prompt.sequence} published${this.state.pullRequest?.url ? `: ${this.state.pullRequest.url}` : ""}`, "success");
  }

  failOperation(error) {
    if (!this.state) return;
    this.state.status = "blocked";
    this.state.lastError = error.message;
    this.state.lastErrorAt = this.clock();
    this.persist();
    this.notify(`Teaching session blocked: ${error.message}`, "error");
  }

  async resume() {
    if (!this.state?.operation) throw new Error("Teaching session has no unfinished operation");
    try {
      if (this.state.operation.kind === "publish") await this.publishPending();
      else if (this.state.operation.kind === "rollback") await this.resumeRollback();
      else throw new Error(`Unknown teaching operation ${this.state.operation.kind}`);
    } catch (error) {
      this.failOperation(error);
      throw error;
    }
    return clone(this.state);
  }

  async rollback(identifier, explanation, ctx = this.ctx) {
    this.attachContext(ctx);
    if (!this.state || !isActiveStatus(this.state.status)) throw new Error("No active teaching session");
    if (ctx?.isIdle && !ctx.isIdle()) throw new Error("Wait for the current Pi prompt to finish before rolling back");
    if (this.state.operation || this.state.pendingPromptId) throw new Error("Rollback is unavailable until the current prompt is fully published");
    if (typeof explanation !== "string" || !explanation.trim()) throw new Error("Rollback explanation is required");
    const prompt = this.findPrompt(identifier);
    if (!isCodePromptStatus(prompt.status)) throw new Error(`Prompt ${prompt.sequence} is not a completed prompt`);

    const rollbackId = `${this.state.id}:r${this.state.rollbacks.length + 1}`;
    const record = {
      id: rollbackId,
      promptId: prompt.id,
      promptSequence: prompt.sequence,
      explanation,
      originalPrompt: prompt.originalPrompt,
      selectedEntryId: prompt.piEntryId,
      parentEntryId: prompt.parentEntryId,
      abandonedSessionFile: prompt.piSessionFile,
      status: "started",
      startedAt: this.clock(),
    };
    this.state.rollbacks.push(record);
    this.state.operation = {
      kind: "rollback",
      rollbackId,
      promptId: prompt.id,
      stage: "recorded",
      targetCommit: prompt.preCommit,
    };
    this.state.status = "rolling_back";
    this.persist();
    try {
      await this.resumeRollback();
    } catch (error) {
      this.failOperation(error);
      throw error;
    }
    return clone(this.state);
  }

  rollbackRecord() {
    return this.state?.rollbacks?.find((record) => record.id === this.state.operation?.rollbackId)
      ?? this.state?.rollbacks?.at(-1);
  }

  async resumeRollback() {
    const operation = this.state?.operation;
    if (!operation || operation.kind !== "rollback") throw new Error("No rollback operation is waiting for recovery");
    const record = this.rollbackRecord();
    const prompt = this.state.prompts.find((candidate) => candidate.id === operation.promptId);
    if (!record || !prompt) throw new Error("Rollback record is incomplete");
    await this.git.ensureOnBranch(this.state.sessionBranch);
    const abandonedTip = record.abandonedTip ?? await this.git.head();
    record.abandonedTip = abandonedTip;
    const remoteSessionSha = record.remoteSessionSha ?? await this.git.remoteHead(this.state.sessionBranch);
    record.remoteSessionSha = remoteSessionSha;
    this.persist();

    if (operation.stage === "recorded") {
      const backupBranch = record.backupBranch ?? `teach/backup-${safeBranchPart(this.state.id)}-${record.promptSequence}-${shortHash(abandonedTip)}`;
      record.backupBranch = backupBranch;
      await this.git.createBranch(backupBranch, abandonedTip);
      await this.git.pushBranch(backupBranch, { forceWithLease: undefined });
      const backupRemoteSha = await this.git.remoteHead(backupBranch);
      if (backupRemoteSha !== abandonedTip) throw new Error(`Backup branch ${backupBranch} is ${backupRemoteSha}, expected ${abandonedTip}`);
      record.backupRemoteSha = backupRemoteSha;
      record.status = "backup_preserved";
      operation.stage = "backup_preserved";
      this.persist();
    }

    if (operation.stage === "backup_preserved") {
      const currentRemote = await this.git.remoteHead(this.state.sessionBranch);
      if (currentRemote !== remoteSessionSha) {
        throw new Error(`Remote session branch changed during rollback: expected ${remoteSessionSha ?? "absent"}, found ${currentRemote ?? "absent"}`);
      }
      await this.git.resetHard(operation.targetCommit);
      if (remoteSessionSha) {
        await this.git.pushBranch(this.state.sessionBranch, { forceWithLease: remoteSessionSha });
        const restoredRemoteSha = await this.git.remoteHead(this.state.sessionBranch);
        if (restoredRemoteSha !== operation.targetCommit) throw new Error(`Restored remote branch is ${restoredRemoteSha}, expected ${operation.targetCommit}`);
      }
      record.status = "code_restored";
      operation.stage = "code_restored";
      this.persist();
    }

    if (operation.stage === "code_restored") {
      const currentLeafId = this.ctx?.sessionManager?.getLeafId?.() ?? null;
      record.abandonedLeafId = currentLeafId;
      record.abandonedEntryIds = (this.ctx?.sessionManager?.getBranch?.() ?? []).map((entry) => entry.id);
      if (!this.ctx?.navigateTree) throw new Error("Pi context cannot restore the teaching conversation tree");
      this.authorizedNavigation = true;
      let navigation;
      try {
        navigation = await this.ctx.navigateTree(prompt.piEntryId, { summarize: false });
      } finally {
        this.authorizedNavigation = false;
      }
      if (navigation?.cancelled) throw new Error("Pi cancelled conversation restoration");
      this.ctx.ui?.setEditorText?.(navigation?.editorText ?? prompt.originalPrompt);
      record.status = "conversation_restored";
      record.restoredLeafId = this.ctx.sessionManager.getLeafId?.() ?? prompt.parentEntryId;
      operation.stage = "conversation_restored";
      this.persist();
    }

    if (operation.stage === "conversation_restored") {
      prompt.status = "rolled_back";
      prompt.rolledBackAt = this.clock();
      record.status = "complete";
      record.completedAt = this.clock();
      this.state.operation = null;
      this.state.pendingPromptId = null;
      this.state.status = "awaiting_rewrite";
      this.state.rewriteBoundaryPromptId = prompt.id;
      this.persist();
      this.notify(`Rolled back before prompt ${prompt.sequence}; rewrite it in the editor`, "success");
    }
  }

  guardNativeNavigation() {
    return Boolean(this.state && isActiveStatus(this.state.status) && !this.authorizedNavigation);
  }

  status() {
    if (!this.state) return { status: "idle" };
    return clone({
      ...this.state,
      prompts: this.state.prompts.map((prompt) => ({
        sequence: prompt.sequence,
        id: prompt.id,
        prompt: prompt.prompt,
        status: prompt.status,
        preCommit: prompt.preCommit,
        commit: prompt.commit,
        piEntryId: prompt.piEntryId,
        rewriteOf: prompt.rewriteOf,
      })),
    });
  }

  async end() {
    if (!this.state || !isActiveStatus(this.state.status)) throw new Error("No active teaching session");
    if (this.state.operation || this.state.pendingPromptId) throw new Error("Finish or recover the current teaching operation before ending");
    await this.git.ensureOnBranch(this.state.sessionBranch);
    await this.git.assertClean("Cannot end a teaching session with uncommitted changes");
    this.state.status = "ended";
    this.state.endedAt = this.clock();
    this.persist();
    this.notify(`Teaching session ended: ${this.state.id}`, "info");
    return clone(this.state);
  }
}

export default TeachingSessionController;
