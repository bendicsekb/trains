import path from "node:path";

import { bindingKind, isObject, loadTrain, outputBindingKind, refParts } from "../src/train-definition.mjs";
import { hasActiveTeachingSession } from "../src/teaching-session.mjs";

const STATE_ENTRY = "trains.state.v1";
const HANDOFF_TOOL = "train_handoff";
const DEFAULT_MAX_ITERATIONS = 8;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

function now() {
  return new Date().toISOString();
}

function invocationId(state, frame, stepId, iteration) {
  return `${state.runId}:${frame.trainId}:${stepId}:i${iteration}:a${(frame.steps[stepId]?.attempts ?? 0) + 1}`;
}

function renderProcedure(procedure) {
  if (Array.isArray(procedure)) return procedure.map((line) => `- ${line}`).join("\n");
  return `Invoke nested train ${procedure.ref}. Pi will enter it as a separate call frame.`;
}

function renderOutputs(outputs) {
  return Object.entries(outputs).map(([name, binding]) => {
    const lines = [binding.ref
      ? `- ${name}: derived from ${binding.ref}; the runner resolves this output`
      : `- ${name}: ${binding.doc}`];
    if (binding.acceptance?.length) lines.push(`  acceptance: ${binding.acceptance.join("; ")}`);
    return lines.join("\n");
  }).join("\n");
}

function resolvePath(value, parts, description) {
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || !(part in Object(current))) {
      throw new Error(`Unable to resolve ${description}: missing ${part}`);
    }
    current = current[part];
  }
  return current;
}

function resolveReference(ref, values, currentOutputs, description) {
  const parts = refParts(ref, { localOutput: true });
  if (!parts) throw new Error(`Invalid ${description}: ${ref}`);
  if (currentOutputs && Object.prototype.hasOwnProperty.call(currentOutputs, parts[0])) {
    return resolvePath(currentOutputs[parts[0]], parts.slice(1), description);
  }
  if (parts.length < 2 || !values[parts[0]] || !Object.prototype.hasOwnProperty.call(values[parts[0]], parts[1])) {
    throw new Error(`Unknown ${description}: ${ref}`);
  }
  return resolvePath(values[parts[0]][parts[1]], parts.slice(2), description);
}

function resolveInputs(step, frame) {
  const resolved = {};
  for (const [inputId, binding] of Object.entries(step.inputs ?? {})) {
    if (bindingKind(binding) === "doc") {
      if (!Object.prototype.hasOwnProperty.call(frame.supplied, inputId)) {
        if (frame.optionalInputs?.includes(inputId)) continue;
        throw new Error(`Missing input ${inputId}`);
      }
      resolved[inputId] = frame.supplied[inputId];
    } else {
      resolved[inputId] = resolveReference(binding.ref, frame.values, null, `input ${inputId}`);
    }
  }
  return resolved;
}

function boundaryOutputs(train, frame) {
  const outputs = {};
  for (const { stepId, outputId } of train.finalOutputs) {
    if (!frame.values[stepId] || !Object.prototype.hasOwnProperty.call(frame.values[stepId], outputId)) continue;
    if (Object.prototype.hasOwnProperty.call(outputs, outputId)) throw new Error(`Nested train exposes duplicate output ${outputId}`);
    outputs[outputId] = frame.values[stepId][outputId];
  }
  return outputs;
}

function stepDependencies(train, step) {
  const dependencies = new Set();
  const bindings = [
    ...Object.values(step.inputs ?? {}),
    ...(step.human?.prompt ? [step.human.prompt] : []),
  ];
  for (const binding of bindings) {
    if (bindingKind(binding) === "ref") {
      const parts = refParts(binding.ref);
      if (parts && train.definition.steps[parts[0]]) dependencies.add(parts[0]);
    }
  }
  for (const binding of Object.values(step.outputs)) {
    if (outputBindingKind(binding) === "ref") {
      const parts = refParts(binding.ref);
      if (parts && train.definition.steps[parts[0]]) dependencies.add(parts[0]);
    }
  }
  return dependencies;
}

function createFrame(train, supplied, scope, returnTo = null, optionalInputs = []) {
  return {
    trainPath: train.filePath,
    trainId: train.definition.id,
    supplied: clone(supplied),
    optionalInputs,
    scope,
    values: {},
    steps: Object.fromEntries(Object.keys(train.definition.steps).map((stepId) => [stepId, {
      status: "pending",
      attempts: 0,
      iteration: 1,
      invocations: [],
    }])),
    returnTo,
  };
}

function latestState(ctx) {
  const entries = ctx?.sessionManager?.getEntries?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && isObject(entry.data)) return entry.data;
  }
  return null;
}

function outputSchema(step) {
  return Object.fromEntries(Object.entries(step.outputs).map(([name, binding]) => [name, {
    description: binding.doc ?? `Output ${name}`,
  }]));
}

function renderHumanPrompt(prompt) {
  if (typeof prompt === "string") return prompt;
  try {
    return JSON.stringify(prompt, null, 2);
  } catch {
    return String(prompt);
  }
}

function mapLeafOutputs(train, frame, stepId, produced) {
  const step = train.definition.steps[stepId];
  const values = { ...frame.values, [stepId]: produced };
  const outputs = {};
  for (const [outputId, binding] of Object.entries(step.outputs)) {
    if (outputBindingKind(binding) === "doc") {
      if (!Object.prototype.hasOwnProperty.call(produced, outputId)) throw new Error(`Handoff is missing output ${stepId}.${outputId}`);
      outputs[outputId] = produced[outputId];
    } else outputs[outputId] = resolveReference(binding.ref, values, produced, `output ${outputId}`);
  }
  return outputs;
}

export class TrainMachine {
  constructor({ pi, load = loadTrain, maxIterations = DEFAULT_MAX_ITERATIONS, id = () => `train-${Date.now()}` } = {}) {
    this.pi = pi;
    this.load = load;
    this.maxIterations = maxIterations;
    this.id = id;
    this.state = null;
    this.ctx = null;
    this.driving = false;
    this.advanceQueued = false;
  }

  attachContext(ctx) {
    if (!ctx) return;
    // Plain user input is delivered with an ExtensionContext, which can read
    // and persist state but cannot create the next car session. Do not let
    // that restricted context replace the command/session context that owns
    // newSession().
    const incomingCanCreateSession = typeof ctx.newSession === "function";
    const currentCanCreateSession = typeof this.ctx?.newSession === "function";
    if (incomingCanCreateSession || !currentCanCreateSession) this.ctx = ctx;
  }

  notify(message, level = "info") {
    this.ctx?.ui?.notify?.(message, level);
  }

  persist() {
    if (!this.state || !this.pi?.appendEntry) return;
    this.state.updatedAt = now();
    const manager = this.ctx?.sessionManager;
    if (typeof manager?.appendCustomEntry === "function") manager.appendCustomEntry(STATE_ENTRY, clone(this.state));
    else this.pi.appendEntry(STATE_ENTRY, clone(this.state));
  }

  persistTo(manager) {
    if (!this.state || !manager?.appendCustomEntry) return;
    this.state.updatedAt = now();
    manager.appendCustomEntry(STATE_ENTRY, clone(this.state));
  }

  restore(ctx) {
    const restored = latestState(ctx);
    if (!restored) return false;
    this.state = restored;
    this.attachContext(ctx);
    return true;
  }

  start(trainPath, inputs = {}) {
    if (this.state && ["running", "starting", "paused", "blocked", "waiting_human"].includes(this.state.status)) {
      throw new Error(`A train is already active: ${this.state.trainId} (${this.state.status})`);
    }
    if (hasActiveTeachingSession(this.ctx)) {
      throw new Error("Cannot start a train while a teaching session is active in this Pi session");
    }
    const train = this.load(path.resolve(this.ctx.cwd, trainPath));
    for (const name of train.interfaceInputs) if (!Object.prototype.hasOwnProperty.call(inputs, name)) throw new Error(`Missing train input: ${name}`);
    const extra = Object.keys(inputs).filter((name) => !train.interfaceInputs.includes(name));
    if (extra.length) throw new Error(`Unknown train inputs: ${extra.join(", ")}`);

    const root = createFrame(train, inputs, "root");
    this.state = {
      schemaVersion: 1,
      runId: this.id(),
      trainId: train.definition.id,
      trainPath: train.filePath,
      status: "running",
      inputs: clone(inputs),
      frames: [root],
      active: null,
      history: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.persist();
    return this.drive();
  }

  currentFrame() {
    return this.state?.frames?.[this.state.frames.length - 1];
  }

  loadFrameTrain(frame) {
    return this.load(frame.trainPath);
  }

  markBlocked(message) {
    if (!this.state) return;
    this.state.status = "blocked";
    this.state.blockedReason = message;
    this.persist();
    this.notify(`Train blocked: ${message}`, "warning");
  }

  async drive() {
    if (this.driving || !this.state || this.state.status !== "running") return;
    this.driving = true;
    try {
      while (this.state.status === "running" && !this.state.active) {
        const frame = this.currentFrame();
        const train = this.loadFrameTrain(frame);
        const stepIds = Object.keys(train.definition.steps);
        const pending = stepIds.filter((stepId) => frame.steps[stepId].status !== "completed");
        if (pending.length === 0) {
          await this.finishFrame(train, frame);
          continue;
        }

        const ready = pending.find((stepId) => [...stepDependencies(train, train.definition.steps[stepId])]
          .every((dependency) => frame.steps[dependency]?.status === "completed"));
        if (!ready) throw new Error(`No runnable car remains in ${train.definition.id}; dependency cycle or missing handoff`);

        const step = train.definition.steps[ready];
        const stepState = frame.steps[ready];
        const iteration = stepState.iteration ?? 1;
        const ordinaryInputs = resolveInputs(step, frame);
        const invocationInputs = { ...ordinaryInputs };
        if (iteration > 1) {
          for (const [inputId, binding] of Object.entries(step.repeat?.inputs ?? {})) {
            invocationInputs[inputId] = resolveReference(binding.ref, frame.values, stepState.lastOutputs, `repeat input ${inputId}`);
          }
        }

        stepState.status = "running";
        stepState.attempts += 1;
        const invocation = invocationId(this.state, frame, ready, iteration);
        stepState.invocations.push({ invocation, iteration, attempt: stepState.attempts, status: "running", startedAt: now() });
        this.persist();

        if (isObject(step.procedure) && step.procedure.ref) {
          const child = train.nested.get(ready) ?? this.load(path.resolve(path.dirname(train.filePath), step.procedure.ref));
          stepState.status = "waiting_child";
          stepState.activeInvocation = { invocation, iteration };
          const optionalInputs = iteration === 1 ? Object.keys(step.repeat?.inputs ?? {}) : [];
          this.state.frames.push(createFrame(child, invocationInputs, `${frame.scope}.${ready}.i${iteration}`, { stepId: ready, invocation, iteration }, optionalInputs));
          this.persist();
          continue;
        }

        this.state.active = {
          frameIndex: this.state.frames.length - 1,
          stepId: ready,
          invocation,
          iteration,
          sessionId: null,
          handoff: null,
          startedAt: now(),
        };
        this.persist();
        if (step.human) await this.startHuman(train, frame, ready, step);
        else await this.startCar(train, frame, ready, step, invocationInputs);
      }
    } catch (error) {
      this.markBlocked(error.message);
    } finally {
      this.driving = false;
    }
  }

  async finishFrame(train, frame) {
    const outputs = boundaryOutputs(train, frame);
    if (this.state.frames.length === 1) {
      this.state.outputs = outputs;
      this.state.status = "completed";
      this.state.completedAt = now();
      this.persist();
      this.notify(`Train completed: ${this.state.trainId}`, "success");
      return;
    }

    const child = this.state.frames.pop();
    const parent = this.currentFrame();
    const returnTo = child.returnTo;
    const step = this.loadFrameTrain(parent).definition.steps[returnTo.stepId];
    const outputValues = {};
    for (const [outputId, binding] of Object.entries(step.outputs)) {
      if (outputBindingKind(binding) === "doc") {
        if (!Object.prototype.hasOwnProperty.call(outputs, outputId)) throw new Error(`Nested car ${returnTo.stepId} did not expose output ${outputId}`);
        outputValues[outputId] = outputs[outputId];
      } else outputValues[outputId] = resolveReference(binding.ref, child.values, outputs, `nested output ${outputId}`);
    }
    await this.finishInvocation(parent, returnTo.stepId, returnTo.iteration, returnTo.invocation, outputValues);
  }

  async finishInvocation(frame, stepId, iteration, invocation, outputs) {
    const train = this.loadFrameTrain(frame);
    const step = train.definition.steps[stepId];
    const stepState = frame.steps[stepId];
    const accepted = step.repeat?.until ? Boolean(resolveReference(step.repeat.until.ref, frame.values, outputs, "repeat.until")) : true;
    const record = stepState.invocations.find((entry) => entry.invocation === invocation);
    if (record) Object.assign(record, { status: accepted ? "completed" : "repeating", finishedAt: now(), outputs: clone(outputs) });
    frame.values[stepId] = clone(outputs);
    if (accepted) {
      stepState.status = "completed";
      stepState.outputs = clone(outputs);
      delete stepState.activeInvocation;
      delete stepState.lastOutputs;
    } else {
      if (iteration >= this.maxIterations) throw new Error(`Car ${stepId} exceeded maxIterations=${this.maxIterations}`);
      stepState.status = "pending";
      stepState.iteration = iteration + 1;
      stepState.lastOutputs = clone(outputs);
      delete stepState.activeInvocation;
    }
    this.state.history.push({ type: "car_handoff", trainId: train.definition.id, step: stepId, invocation, iteration, accepted, outputs: clone(outputs), at: now() });
    this.persist();
  }

  async startCar(train, frame, stepId, step, inputs) {
    const prompt = [
      `You are executing car ${frame.scope}.${stepId} of train ${train.definition.id}.`,
      "This is a fresh Pi context. Work only from the declared inputs below; do not assume sibling conversation context.",
      "",
      "Declared inputs (JSON):",
      safeJson(inputs),
      "",
      "Procedure:",
      renderProcedure(step.procedure),
      "",
      "Declared outputs and acceptance contracts:",
      renderOutputs(step.outputs),
      "",
      `When the car is complete, call ${HANDOFF_TOOL} exactly once. The arguments must have this top-level shape:`,
      '{"outputs":{"<declared-output>":"<value>"},"summary":"<concise summary>","evidenceRefs":["<source reference>"],"claimsNotMade":["<uncertainty or claim not made>"]}',
      "Put every worker-produced doc output under outputs; ref outputs are derived by the runner. summary is a required top-level string, not an output. evidenceRefs and claimsNotMade are required top-level arrays.",
      "The handoff is the only completion signal. If you are blocked, explain the blocker and do not fabricate outputs.",
    ].join("\n");
    const current = this.ctx;
    if (!current?.newSession) throw new Error("Pi command context does not support newSession; run the train from an interactive Pi extension context");
    const parentSession = current.sessionManager.getSessionFile?.();
    this.state.status = "starting";
    this.persist();
    const result = await current.newSession({
      parentSession,
      setup: async (manager) => {
        this.persistTo(manager);
      },
      withSession: async (nextCtx) => {
        this.attachContext(nextCtx);
        this.state.status = "running";
        this.state.active.sessionId = nextCtx.sessionManager.getSessionId();
        this.persist();
        await nextCtx.sendUserMessage(prompt, { expandPromptTemplates: false });
      },
    });
    if (result.cancelled) {
      this.state.active = null;
      this.markBlocked("Pi cancelled creation of the next car session");
    }
  }

  notifyHumanRequest() {
    const active = this.state?.active;
    if (!active || !Object.prototype.hasOwnProperty.call(active, "humanPrompt")) return;
    this.notify([
      `Human input required for ${active.stepId}.`,
      "",
      "Teaching/context:",
      renderHumanPrompt(active.humanPrompt),
      "",
      `Reply with your judgement, or use /train-answer <answer>. Expected output: ${active.humanOutputNames.join(", ")}.`,
    ].join("\n"), "info");
  }

  async startHuman(train, frame, stepId, step) {
    const prompt = resolveReference(step.human.prompt.ref, frame.values, null, `human prompt ${stepId}`);
    this.state.status = "waiting_human";
    this.state.active.mode = "human";
    this.state.active.humanPrompt = clone(prompt);
    this.state.active.humanOutputNames = Object.keys(step.outputs);
    this.persist();
    this.notifyHumanRequest();
  }

  async acceptHumanInput(value, ctx = this.ctx, { deferAdvance = false } = {}) {
    this.attachContext(ctx);
    if (ctx) this.restore(ctx);
    if (!this.state?.active || this.state.status !== "waiting_human" || this.state.active.mode !== "human") {
      throw new Error("No human node is waiting for an answer");
    }
    const outputNames = this.state.active.humanOutputNames ?? [];
    const outputs = outputNames.length === 1
      && (!isObject(value) || !Object.prototype.hasOwnProperty.call(value, outputNames[0]))
      ? { [outputNames[0]]: value }
      : value;
    return this.acceptHuman(outputs, { deferAdvance });
  }

  async acceptHuman(outputs, { deferAdvance = false } = {}) {
    if (!this.state?.active || this.state.status !== "waiting_human" || this.state.active.mode !== "human") {
      throw new Error("No human node is waiting for an answer");
    }
    if (!isObject(outputs)) throw new Error("Human answer must be an object when the node has multiple outputs");
    const active = this.state.active;
    const frame = this.state.frames[active.frameIndex];
    const train = this.loadFrameTrain(frame);
    const step = train.definition.steps[active.stepId];
    const declared = Object.keys(step.outputs);
    const missing = declared.filter((name) => !Object.prototype.hasOwnProperty.call(outputs, name));
    const extra = Object.keys(outputs).filter((name) => !declared.includes(name));
    if (missing.length || extra.length) {
      throw new Error(`Human answer outputs must exactly match declared outputs (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`);
    }
    this.state.active = null;
    this.state.status = "running";
    this.state.history.push({
      type: "human_answer",
      trainId: train.definition.id,
      step: active.stepId,
      invocation: active.invocation,
      iteration: active.iteration,
      outputs: clone(outputs),
      at: now(),
    });
    await this.finishInvocation(frame, active.stepId, active.iteration, active.invocation, outputs);
    if (!deferAdvance) await this.drive();
    return `Human answer recorded for ${active.stepId}; Pi will continue.`;
  }

  async acceptHandoff(params) {
    // The handoff tool may be served by the replacement-session instance,
    // whose startup snapshot predates the withSession running transition.
    if (this.ctx) this.restore(this.ctx);
    if (!this.state?.active || !["running", "starting"].includes(this.state.status)) throw new Error("No running car is waiting for a handoff");
    if (this.state.active.sessionId && this.ctx?.sessionManager?.getSessionId?.() !== this.state.active.sessionId) throw new Error("Handoff came from a stale Pi session");
    if (!isObject(params?.outputs)) throw new Error("outputs must be an object");
    const frame = this.state.frames[this.state.active.frameIndex];
    const step = this.loadFrameTrain(frame).definition.steps[this.state.active.stepId];
    const declared = Object.keys(step.outputs);
    const produced = Object.entries(step.outputs)
      .filter(([, binding]) => outputBindingKind(binding) === "doc")
      .map(([name]) => name);
    const missing = produced.filter((name) => !Object.prototype.hasOwnProperty.call(params.outputs, name));
    const extra = Object.keys(params.outputs).filter((name) => !declared.includes(name));
    if (missing.length || extra.length) throw new Error(`Handoff outputs must exactly match declared outputs (missing: ${missing.join(",") || "none"}; extra: ${extra.join(",") || "none"})`);
    if (!Array.isArray(params.evidenceRefs) || !Array.isArray(params.claimsNotMade) || typeof params.summary !== "string") {
      throw new Error("Handoff requires summary, evidenceRefs[], and claimsNotMade[]");
    }
    if (this.state.active.handoff) throw new Error("This car already has a handoff; steer or resume it instead");
    this.state.active.handoff = clone(params);
    this.state.history.push({ type: "handoff_recorded", step: this.state.active.stepId, invocation: this.state.active.invocation, at: now() });
    this.persist();
    return `Handoff recorded for ${this.state.active.stepId}; Pi will advance after agent_settled.`;
  }

  async onSettled(ctx = this.ctx) {
    // Pi replacement runtimes can observe setup and withSession through
    // different extension instances. Always take the latest durable snapshot
    // before consuming the completion boundary.
    if (ctx) {
      this.attachContext(ctx);
      this.restore(ctx);
    }
    if (!this.state?.active || this.state.status !== "running") return;
    if (!this.state.active.handoff) {
      this.markBlocked(`car ${this.state.active.stepId} settled without calling ${HANDOFF_TOOL}`);
      return;
    }
    const active = this.state.active;
    const frame = this.state.frames[active.frameIndex];
    this.state.active = null;
    const train = this.loadFrameTrain(frame);
    const outputs = mapLeafOutputs(train, frame, active.stepId, active.handoff.outputs);
    await this.finishInvocation(frame, active.stepId, active.iteration, active.invocation, outputs);
    await this.drive();
  }

  queueAdvance({ requireActive = true } = {}) {
    if (!this.state || this.advanceQueued) return;
    if (requireActive && !this.state.active) return;
    if (!requireActive && this.state.status !== "running") return;
    this.advanceQueued = true;
    if (typeof this.pi?.sendUserMessage !== "function") {
      this.advanceQueued = false;
      if (requireActive) void this.onSettled(this.ctx);
      else void this.drive();
      return;
    }
    try {
      this.pi.sendUserMessage("/train-advance", { expandPromptTemplates: true });
    } catch (error) {
      this.advanceQueued = false;
      this.markBlocked("Unable to queue train advancement: " + error.message);
    }
  }

  async advance(ctx) {
    this.advanceQueued = false;
    if (!this.state?.active && this.state?.status === "running") {
      this.attachContext(ctx);
      await this.drive();
      return;
    }
    await this.onSettled(ctx);
  }

  async steer(text) {
    if (!this.state?.active) throw new Error("No active car to steer");
    if (this.state.active.mode === "human") throw new Error("Human nodes accept answers with /train-answer or plain text; they cannot be steered");
    if (typeof text !== "string" || !text.trim()) throw new Error("Steering text is required");
    this.state.status = "running";
    this.state.active.handoff = null;
    this.state.history.push({ type: "steer", step: this.state.active.stepId, text, at: now() });
    this.persist();
    if (typeof this.ctx?.sendUserMessage === "function") await this.ctx.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
    else this.pi.sendUserMessage(text, { deliverAs: "steer", expandPromptTemplates: false });
  }

  pause() {
    if (!this.state?.active) throw new Error("No active train");
    this.state.status = "paused";
    this.persist();
    if (this.state.active.mode !== "human") this.ctx?.abort?.();
    this.notify("Train paused", "info");
  }

  async retryActiveCar(reason) {
    const active = this.state.active;
    const frame = this.state.frames[active.frameIndex];
    const stepState = frame.steps[active.stepId];
    const invocation = stepState.invocations.find((entry) => entry.invocation === active.invocation);
    if (invocation) Object.assign(invocation, { status: "retrying", finishedAt: now(), error: reason });
    stepState.status = "pending";
    delete stepState.activeInvocation;
    this.state.active = null;
    this.state.status = "running";
    delete this.state.blockedReason;
    this.persist();
    await this.drive();
  }

  async resume() {
    if (!this.state || !["paused", "blocked"].includes(this.state.status)) throw new Error("Train is not paused or blocked");
    if (!this.state.active) throw new Error("Train has no active car");
    this.state.status = "running";
    if (this.state.active.mode === "human") {
      this.state.status = "waiting_human";
      this.persist();
      this.notifyHumanRequest();
      return;
    }
    if (!this.state.active.sessionId) {
      await this.retryActiveCar("The previous attempt did not create a worker session");
      return;
    }
    this.state.active.handoff = null;
    this.persist();
    const message = "Resume this car from the current state. Re-check the work, then call train_handoff when complete.";
    if (typeof this.ctx?.sendUserMessage === "function") await this.ctx.sendUserMessage(message, { expandPromptTemplates: false });
    else this.pi.sendUserMessage(message, { expandPromptTemplates: false });
  }

  cancel() {
    if (!this.state || ["completed", "cancelled"].includes(this.state.status)) throw new Error("No active train");
    this.state.status = "cancelled";
    this.persist();
    this.ctx?.abort?.();
    this.notify(`Train cancelled: ${this.state.trainId}`, "warning");
  }

  status() {
    if (!this.state) return { status: "idle" };
    return {
      runId: this.state.runId,
      trainId: this.state.trainId,
      status: this.state.status,
      active: this.state.active ? {
        step: this.state.active.stepId,
        mode: this.state.active.mode ?? "agent",
        invocation: this.state.active.invocation,
        iteration: this.state.active.iteration,
        handoffRecorded: Boolean(this.state.active.handoff),
      } : null,
      frames: this.state.frames.map((frame) => ({ trainId: frame.trainId, scope: frame.scope })),
      history: this.state.history.length,
    };
  }
}

const HANDOFF_SCHEMA = {
  type: "object",
  properties: {
    outputs: { type: "object", additionalProperties: true },
    summary: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    claimsNotMade: { type: "array", items: { type: "string" } },
  },
  required: ["outputs", "summary", "evidenceRefs", "claimsNotMade"],
  additionalProperties: false,
};

export function createTrainExtension(options = {}) {
  return function trainExtension(pi) {
    const machine = new TrainMachine({ pi, ...options });

    pi.on("session_start", async (_event, ctx) => {
      machine.attachContext(ctx);
      if (machine.restore(ctx)) {
        machine.notify(`Train ${machine.state.trainId}: ${machine.state.status}`, "info");
        if (machine.state.status === "waiting_human") machine.notifyHumanRequest();
      }
    });

    pi.on("input", async (event, ctx) => {
      machine.attachContext(ctx);
      if (typeof event?.text !== "string" || event.text.trim().startsWith("/")) return { action: "continue" };
      if (machine.state?.status !== "waiting_human") return { action: "continue" };
      await machine.acceptHumanInput(event.text, ctx, { deferAdvance: true });
      machine.queueAdvance({ requireActive: false });
      return { action: "handled" };
    });

    pi.on("agent_settled", async () => machine.queueAdvance());

    pi.registerTool({
      name: HANDOFF_TOOL,
      label: "Train handoff",
      description: "Finish the current Trains car with its declared outputs and evidence boundary.",
      promptSnippet: "Complete the current train car with a structured handoff",
      promptGuidelines: ["Call this exactly once when the car is complete. Put worker-produced doc values under outputs; ref outputs are resolved by the runner. Provide top-level summary, evidenceRefs, and claimsNotMade. Do not invent undeclared outputs."],
      parameters: HANDOFF_SCHEMA,
      async execute(_toolCallId, params) {
        const message = await machine.acceptHandoff(params);
        return {
          content: [{ type: "text", text: message }],
          details: { trainId: machine.state?.trainId, step: machine.state?.active?.stepId },
          terminate: true,
        };
      },
    });

    pi.registerCommand("train", {
      description: "Start a Pi-native Trains state machine: /train path/to/train.yaml {\"input\": ...}",
      handler: async (args, ctx) => {
        machine.attachContext(ctx);
        if (ctx.isIdle && !ctx.isIdle()) throw new Error("Pause or steer the current Pi turn before starting a train");
        const split = args.trim().split(/\s+/);
        const trainPath = split.shift();
        if (!trainPath) throw new Error("Usage: /train path/to/train.yaml [JSON inputs]");
        const inputText = split.join(" ");
        let inputs = {};
        if (inputText) {
          try { inputs = JSON.parse(inputText); } catch (error) { throw new Error(`Train inputs must be JSON: ${error.message}`); }
        }
        await machine.start(trainPath, inputs);
      },
    });

    pi.registerCommand("train-status", {
      description: "Show the Pi-native Trains state machine status",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        ctx.ui.notify(JSON.stringify(machine.status()), "info");
      },
    });

    pi.registerCommand("train-answer", {
      description: "Submit an answer to the waiting human train node",
      handler: async (args, ctx) => {
        machine.attachContext(ctx);
        const text = args.trim();
        if (!text) throw new Error("Usage: /train-answer <answer> or /train-answer {\"output\": ...}");
        let value = text;
        try {
          value = JSON.parse(text);
        } catch {
          // A plain answer is valid when the human node declares one output.
        }
        await machine.acceptHumanInput(value, ctx);
      },
    });

    pi.registerCommand("train-advance", {
      description: "Advance the active train after the current Pi car settles",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        await machine.advance(ctx);
      },
    });

    pi.registerCommand("train-steer", {
      description: "Steer the active train car and continue its current context",
      handler: async (args, ctx) => {
        machine.attachContext(ctx);
        await machine.steer(args);
      },
    });

    pi.registerCommand("train-pause", {
      description: "Pause the active train after the current operation",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        machine.pause();
      },
    });

    pi.registerCommand("train-resume", {
      description: "Resume a paused or blocked train car",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        machine.resume();
      },
    });

    pi.registerCommand("train-cancel", {
      description: "Cancel the active train",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        machine.cancel();
      },
    });

    pi.registerCommand("train-debug-schema", {
      description: "Show the declared outputs for the active car",
      handler: async (_args, ctx) => {
        machine.attachContext(ctx);
        if (!machine.state?.active) throw new Error("No active car");
        const frame = machine.state.frames[machine.state.active.frameIndex];
        const step = machine.loadFrameTrain(frame).definition.steps[machine.state.active.stepId];
        ctx.ui.notify(JSON.stringify(outputSchema(step)), "info");
      },
    });
  };
}

export default createTrainExtension();
