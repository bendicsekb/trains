import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { createRunContract } from "/home/bendi/pi-product-factory/src/contract.mjs";
import { supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";

const RUNNER_VERSION = "0.1.0";
const TRAIN_SCHEMA_VERSION = 1;
const HANDOFF_SCHEMA_VERSION = 1;

export class TrainValidationError extends Error {
  constructor(filePath, errors) {
    super(`Invalid train ${filePath}:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "TrainValidationError";
    this.filePath = filePath;
    this.errors = errors;
  }
}

export class TrainExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TrainExecutionError";
    Object.assign(this, details);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function now() {
  return new Date().toISOString();
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function bindingEntries(bindings, label, errors) {
  if (!isObject(bindings)) {
    errors.push(`${label} must be an object`);
    return [];
  }
  return Object.entries(bindings);
}

function bindingKind(binding) {
  if (!isObject(binding)) return null;
  const keys = Object.keys(binding);
  return keys.length === 1 && (keys[0] === "doc" || keys[0] === "ref") ? keys[0] : null;
}

function outputBindingKind(binding) {
  if (!isObject(binding)) return null;
  const primary = ["doc", "ref"].filter((key) => Object.prototype.hasOwnProperty.call(binding, key));
  return primary.length === 1 && Object.keys(binding).every((key) => key === primary[0] || key === "acceptance") ? primary[0] : null;
}

function refParts(ref, { localOutput = false } = {}) {
  if (!nonEmptyString(ref)) return null;
  const parts = ref.split(".");
  if (parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part))) return null;
  if (localOutput ? parts.length < 1 : parts.length < 2) return null;
  return parts;
}

function resolvePath(value, parts, description) {
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined || !(part in Object(current))) {
      throw new TrainExecutionError(`Unable to resolve ${description}: missing ${part}`, { ref: parts.join(".") });
    }
    current = current[part];
  }
  return current;
}

function findOutput(definition, stepId, outputId, errors, label) {
  const step = definition.steps[stepId];
  if (!step) {
    errors.push(`${label} references unknown step ${stepId}`);
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(step.outputs, outputId)) {
    errors.push(`${label} references unknown output ${stepId}.${outputId}`);
    return null;
  }
  return step.outputs[outputId];
}

function validateOutputAcceptance(output, label, errors) {
  const kind = outputBindingKind(output);
  if (!kind) {
    errors.push(`${label} must contain exactly one of doc or ref`);
    return;
  }
  if (kind === "doc") {
    if (!nonEmptyString(output.doc)) errors.push(`${label}.doc must be a non-empty string`);
    if (!Array.isArray(output.acceptance) || output.acceptance.length === 0 || !output.acceptance.every(nonEmptyString)) {
      errors.push(`${label} with doc must contain a non-empty acceptance string array`);
    }
  } else if (output.acceptance !== undefined && (!Array.isArray(output.acceptance) || !output.acceptance.every(nonEmptyString))) {
    errors.push(`${label}.acceptance must be a string array when provided`);
  }
}

function collectDocInputs(definition) {
  const inputs = [];
  for (const [stepId, step] of Object.entries(definition.steps)) {
    for (const [inputId, binding] of Object.entries(step.inputs)) {
      if (bindingKind(binding) === "doc") inputs.push({ name: inputId, stepId, doc: binding.doc });
    }
  }
  return inputs;
}

function collectFinalOutputs(definition) {
  const consumed = new Set();
  for (const step of Object.values(definition.steps)) {
    for (const binding of Object.values(step.inputs)) {
      if (bindingKind(binding) === "ref") {
        const parts = refParts(binding.ref);
        if (parts) consumed.add(`${parts[0]}.${parts[1]}`);
      }
    }
  }
  const finalOutputs = [];
  for (const [stepId, step] of Object.entries(definition.steps)) {
    for (const outputId of Object.keys(step.outputs)) {
      if (!consumed.has(`${stepId}.${outputId}`)) finalOutputs.push({ stepId, outputId });
    }
  }
  return finalOutputs;
}

function validateTrainDefinition(definition, filePath, stack = []) {
  const errors = [];
  if (!isObject(definition)) return { valid: false, errors: ["root must be an object"] };
  const allowedRootKeys = new Set(["id", "steps"]);
  for (const key of Object.keys(definition)) if (!allowedRootKeys.has(key)) errors.push(`unknown root field ${key}; runner state and repeat belong below a car`);
  if (!nonEmptyString(definition.id)) errors.push("id must be a non-empty string");
  if (!isObject(definition.steps) || Object.keys(definition.steps).length === 0) errors.push("steps must be a non-empty object");
  if (!isObject(definition.steps)) return { valid: errors.length === 0, errors };

  const nested = new Map();
  for (const [stepId, step] of Object.entries(definition.steps)) {
    const label = `steps.${stepId}`;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(stepId)) errors.push(`${label} is not a valid identifier`);
    if (!isObject(step)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!("inputs" in step) || !("procedure" in step) || !("outputs" in step)) errors.push(`${label} must contain inputs, procedure, and outputs`);
    const inputs = bindingEntries(step.inputs, `${label}.inputs`, errors);
    const inputNames = new Set();
    for (const [inputId, binding] of inputs) {
      if (inputNames.has(inputId)) errors.push(`${label}.inputs duplicates ${inputId}`);
      inputNames.add(inputId);
      const kind = bindingKind(binding);
      if (!kind) errors.push(`${label}.inputs.${inputId} must contain exactly one of doc or ref`);
      if (kind === "doc" && !nonEmptyString(binding.doc)) errors.push(`${label}.inputs.${inputId}.doc must be a non-empty string`);
      if (kind === "ref") {
        const parts = refParts(binding.ref);
        if (!parts) errors.push(`${label}.inputs.${inputId}.ref must be step.output[.path]`);
        else {
          if (parts[0] === stepId) errors.push(`${label}.inputs.${inputId} cannot depend on its own output outside repeat feedback`);
          findOutput(definition, parts[0], parts[1], errors, `${label}.inputs.${inputId}`);
        }
      }
    }

    const procedure = step.procedure;
    if (Array.isArray(procedure)) {
      if (procedure.length === 0 || !procedure.every(nonEmptyString)) errors.push(`${label}.procedure must contain non-empty instruction strings`);
    } else if (isObject(procedure) && Object.keys(procedure).length === 1 && nonEmptyString(procedure.ref)) {
      if (path.isAbsolute(procedure.ref) || procedure.ref.split(/[\\/]/).includes("..")) {
        errors.push(`${label}.procedure.ref must be a contained relative path`);
        continue;
      }
      const nestedPath = path.resolve(path.dirname(filePath), procedure.ref);
      if (stack.includes(nestedPath)) errors.push(`${label}.procedure.ref creates recursive train inclusion`);
      else if (!fs.existsSync(nestedPath)) errors.push(`${label}.procedure.ref does not exist: ${nestedPath}`);
      else {
        try {
          const child = loadTrain(nestedPath, [...stack, filePath]);
          nested.set(stepId, child);
        } catch (error) {
          errors.push(`${label}.procedure.ref is invalid: ${error.message}`);
        }
      }
    } else errors.push(`${label}.procedure must be an instruction array or {ref: ./train.yaml}`);

    const outputs = bindingEntries(step.outputs, `${label}.outputs`, errors);
    if (outputs.length === 0) errors.push(`${label}.outputs must contain at least one output`);
    for (const [outputId, output] of outputs) {
      validateOutputAcceptance(output, `${label}.outputs.${outputId}`, errors);
      if (outputBindingKind(output) === "ref") {
        const parts = refParts(output.ref);
        if (!parts) errors.push(`${label}.outputs.${outputId}.ref must be step.output[.path] or a nested output reference`);
        else if (definition.steps[parts[0]]) findOutput(definition, parts[0], parts[1], errors, `${label}.outputs.${outputId}`);
        else if (nested.has(stepId)) {
          const child = nested.get(stepId);
          findOutput(child.definition, parts[0], parts[1], errors, `${label}.outputs.${outputId}`);
        } else errors.push(`${label}.outputs.${outputId} cannot resolve ${output.ref}`);
      }
    }

    if (step.repeat !== undefined) {
      if (!isObject(step.repeat)) errors.push(`${label}.repeat must be an object`);
      else {
        const repeatKeys = Object.keys(step.repeat);
        if (!repeatKeys.every((key) => ["inputs", "until"].includes(key))) errors.push(`${label}.repeat may contain only inputs and until`);
        if (!isObject(step.repeat.inputs)) errors.push(`${label}.repeat.inputs must be an object`);
        else {
          for (const [inputId, binding] of Object.entries(step.repeat.inputs)) {
            if (inputNames.has(inputId)) errors.push(`${label}.repeat.inputs.${inputId} would overwrite an ordinary input`);
            if (bindingKind(binding) !== "ref") errors.push(`${label}.repeat.inputs.${inputId} must be a ref`);
            else if (!refParts(binding.ref, { localOutput: true })) errors.push(`${label}.repeat.inputs.${inputId}.ref is invalid`);
          }
        }
        if (!isObject(step.repeat.until) || bindingKind(step.repeat.until) !== "ref") errors.push(`${label}.repeat.until must be a ref`);
        else if (!refParts(step.repeat.until.ref, { localOutput: true })) errors.push(`${label}.repeat.until.ref is invalid`);
      }
    }
  }

  const duplicateDocs = new Set();
  for (const input of collectDocInputs(definition)) {
    if (duplicateDocs.has(input.name)) errors.push(`unbound doc input ${input.name} is declared more than once`);
    duplicateDocs.add(input.name);
  }
  return { valid: errors.length === 0, errors, nested, interfaceInputs: [...duplicateDocs], finalOutputs: collectFinalOutputs(definition) };
}

export function loadTrain(filePath, stack = []) {
  const absolutePath = path.resolve(filePath);
  const definition = YAML.parse(fs.readFileSync(absolutePath, "utf8"));
  const result = validateTrainDefinition(definition, absolutePath, stack);
  if (!result.valid) throw new TrainValidationError(absolutePath, result.errors);
  return {
    definition,
    filePath: absolutePath,
    interfaceInputs: result.interfaceInputs,
    finalOutputs: result.finalOutputs,
    nested: result.nested,
  };
}

function buildDependencySet(train, stepId) {
  const step = train.definition.steps[stepId];
  const dependencies = new Set();
  for (const binding of Object.values(step.inputs)) {
    if (bindingKind(binding) === "ref") dependencies.add(refParts(binding.ref)[0]);
  }
  for (const binding of Object.values(step.outputs)) {
    if (bindingKind(binding) === "ref") {
      const parts = refParts(binding.ref);
      if (train.definition.steps[parts[0]]) dependencies.add(parts[0]);
    }
  }
  dependencies.delete(stepId);
  return dependencies;
}

function resolveReference(ref, { values, currentOutputs = null, description = "reference" }) {
  const parts = refParts(ref, { localOutput: true });
  if (!parts) throw new TrainExecutionError(`Invalid ${description}: ${ref}`);
  if (currentOutputs && Object.prototype.hasOwnProperty.call(currentOutputs, parts[0])) {
    return resolvePath(currentOutputs[parts[0]], parts.slice(1), description);
  }
  if (parts.length < 2 || !values[parts[0]]) throw new TrainExecutionError(`Unknown ${description}: ${ref}`, { ref });
  if (!Object.prototype.hasOwnProperty.call(values[parts[0]], parts[1])) throw new TrainExecutionError(`Unknown ${description}: ${ref}`, { ref });
  return resolvePath(values[parts[0]][parts[1]], parts.slice(2), description);
}

function resolveBindings(bindings, values, supplied, { optionalInputs = new Set() } = {}) {
  const resolved = {};
  for (const [inputId, binding] of Object.entries(bindings)) {
    if (bindingKind(binding) === "doc") {
      if (!Object.prototype.hasOwnProperty.call(supplied, inputId)) {
        if (optionalInputs.has(inputId)) continue;
        throw new TrainExecutionError(`Missing train input: ${inputId}`, { inputId });
      }
      resolved[inputId] = supplied[inputId];
    } else resolved[inputId] = resolveReference(binding.ref, { values, description: `input ${inputId}` });
  }
  return resolved;
}

function trainBoundaryOutputs(train, values) {
  const outputs = {};
  for (const { stepId, outputId } of train.finalOutputs) {
    if (!values[stepId] || !Object.prototype.hasOwnProperty.call(values[stepId], outputId)) continue;
    if (Object.prototype.hasOwnProperty.call(outputs, outputId)) throw new TrainExecutionError(`Nested train exposes duplicate final output name: ${outputId}`);
    outputs[outputId] = values[stepId][outputId];
  }
  return outputs;
}

function renderProcedure(procedure) {
  if (Array.isArray(procedure)) return procedure.map((line) => `- ${line}`).join("\n");
  return `Invoke nested train: ${procedure.ref}`;
}

function invocationId(train, stepId, iteration, attempt) {
  const hash = crypto.createHash("sha1").update(`${train.filePath}:${stepId}:${iteration}:${attempt}`).digest("hex").slice(0, 10);
  return `${safeName(train.definition.id)}-${safeName(stepId)}-i${iteration}-a${attempt}-${hash}`;
}

function handoffFor(handoffPath, contract, train, stepId, invocation) {
  if (!fs.existsSync(handoffPath)) throw new TrainExecutionError(`Pi completed without writing the declared handoff: ${handoffPath}`, { contract, stepId, invocation });
  let handoff;
  try {
    handoff = readJson(handoffPath);
  } catch (error) {
    throw new TrainExecutionError(`Invalid JSON handoff at ${handoffPath}: ${error.message}`, { contract, stepId, invocation });
  }
  const errors = [];
  if (handoff.schemaVersion !== HANDOFF_SCHEMA_VERSION) errors.push(`schemaVersion must be ${HANDOFF_SCHEMA_VERSION}`);
  if (handoff.runId !== contract.runId) errors.push("runId does not match the Pi contract");
  if (handoff.trainId !== train.definition.id) errors.push("trainId does not match the train");
  if (handoff.step !== stepId) errors.push("step does not match the car");
  if (handoff.invocationId !== invocation) errors.push("invocationId does not match the invocation");
  if (handoff.status !== "ready_for_verification") errors.push("status must be ready_for_verification");
  if (!isObject(handoff.outputs)) errors.push("outputs must be an object");
  for (const outputId of Object.keys(train.definition.steps[stepId].outputs)) {
    if (!Object.prototype.hasOwnProperty.call(handoff.outputs ?? {}, outputId)) errors.push(`missing output ${outputId}`);
  }
  if (!Array.isArray(handoff.evidenceRefs)) errors.push("evidenceRefs must be an array");
  if (!Array.isArray(handoff.claimsNotMade)) errors.push("claimsNotMade must be an array");
  if (errors.length > 0) throw new TrainExecutionError(`Invalid Pi handoff at ${handoffPath}: ${errors.join("; ")}`, { contract, stepId, invocation, handoff });
  return handoff;
}

export class TrainRunner {
  constructor({
    trainPath,
    inputs = {},
    runDir,
    workerCommand = "pi",
    workerArgs,
    workerEnv = {},
    cwd,
    provider,
    model,
    thinking,
    piCli,
    stallMs = 120_000,
    maxRuntimeMs = 15 * 60 * 1000,
    maxIterations = 8,
    supervise = supervisePi,
    packageVersion = RUNNER_VERSION,
  } = {}) {
    if (!trainPath) throw new Error("trainPath is required");
    this.train = typeof trainPath === "string" ? loadTrain(trainPath) : trainPath;
    this.inputs = inputs;
    this.runDir = path.resolve(runDir ?? path.join(path.dirname(this.train.filePath), ".trains", "runs", `${safeName(this.train.definition.id)}-${Date.now()}`));
    this.workerCommand = workerCommand;
    this.workerArgs = workerArgs ?? this.defaultWorkerArgs({ provider, model, thinking, piCli });
    this.workerEnv = workerEnv;
    this.cwd = cwd ? path.resolve(cwd) : path.dirname(this.train.filePath);
    this.stallMs = stallMs;
    this.maxRuntimeMs = maxRuntimeMs;
    this.maxIterations = maxIterations;
    this.supervise = supervise;
    this.packageVersion = packageVersion;
    this.statePath = path.join(this.runDir, "state.json");
    this.eventsPath = path.join(this.runDir, "events.ndjson");
  }

  defaultWorkerArgs({ provider, model, thinking, piCli }) {
    if (piCli) {
      const args = [piCli, "--mode", "rpc", "--no-session"];
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      if (thinking) args.push("--thinking", thinking);
      return args;
    }
    const args = ["--mode", "rpc", "--no-session"];
    if (provider) args.push("--provider", provider);
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    return args;
  }

  event(type, payload = {}, eventsPath = this.eventsPath) {
    appendJsonLine(eventsPath, { schemaVersion: 1, eventId: crypto.randomUUID(), at: now(), type, payload });
  }

  saveState(state, statePath = this.statePath) {
    state.updatedAt = now();
    writeJson(statePath, state);
  }

  loadOrCreateState() {
    if (fs.existsSync(this.statePath)) {
      const state = readJson(this.statePath);
      if (state.trainPath !== this.train.filePath || state.trainId !== this.train.definition.id) throw new TrainExecutionError("Run state belongs to a different train", { statePath: this.statePath });
      if (stableJson(state.inputs) !== stableJson(this.inputs)) throw new TrainExecutionError("Run state inputs do not match the requested inputs", { statePath: this.statePath });
      return state;
    }
    const state = {
      schemaVersion: 1,
      runnerVersion: RUNNER_VERSION,
      runId: safeName(path.basename(this.runDir)),
      trainId: this.train.definition.id,
      trainPath: this.train.filePath,
      inputs: this.inputs,
      status: "running",
      stepValues: {},
      steps: {},
      history: [],
      createdAt: now(),
      updatedAt: now(),
    };
    this.saveState(state);
    this.event("run_started", { runId: state.runId, trainId: state.trainId, trainPath: state.trainPath });
    return state;
  }

  async run() {
    ensureDir(this.runDir);
    const state = this.loadOrCreateState();
    if (state.status === "completed") return { state, outputs: state.outputs, runDir: this.runDir };
    state.status = "running";
    this.saveState(state);
    try {
      const result = await this.executeTrain(this.train, this.inputs, this.runDir, state, "root");
      state.outputs = result.outputs;
      state.status = "completed";
      this.saveState(state);
      this.event("run_completed", { outputs: Object.keys(result.outputs), status: "needs_verification" });
      return { state, outputs: result.outputs, runDir: this.runDir };
    } catch (error) {
      state.status = "failed";
      state.error = { name: error.name, message: error.message, stepId: error.stepId, invocation: error.invocation };
      this.saveState(state);
      this.event("run_failed", state.error);
      throw error;
    }
  }

  async executeTrain(train, suppliedInputs, runDir, state, scope, optionalInputs = new Set()) {
    const localStatePath = path.join(runDir, "state.json");
    const localEventsPath = path.join(runDir, "events.ndjson");
    const saveLocalState = () => this.saveState(state, localStatePath);
    const emitLocal = (type, payload = {}) => this.event(type, payload, localEventsPath);
    const values = state.stepValues ?? {};
    const stepIds = Object.keys(train.definition.steps);
    const maxSteps = stepIds.length + 1;
    let passes = 0;
    while (stepIds.some((stepId) => state.steps[stepId]?.status !== "completed")) {
      if (++passes > maxSteps * 2) throw new TrainExecutionError(`Train ${train.definition.id} has an unsatisfied dependency cycle`, { scope });
      const ready = stepIds.find((stepId) => {
        if (state.steps[stepId]?.status === "completed") return false;
        return [...buildDependencySet(train, stepId)].every((dependency) => state.steps[dependency]?.status === "completed");
      });
      if (!ready) throw new TrainExecutionError(`No runnable car remains in train ${train.definition.id}; dependency cycle or missing handoff`, { scope });
      const step = train.definition.steps[ready];
      state.steps[ready] = state.steps[ready] ?? { status: "pending", attempts: 0, invocations: [] };
      state.steps[ready].attempts ??= 0;
      state.steps[ready].invocations ??= [];
      state.steps[ready].status = "running";
      saveLocalState();
      emitLocal("car_started", { scope, trainId: train.definition.id, step: ready });
      try {
        const ordinaryInputs = resolveBindings(step.inputs, values, suppliedInputs, { optionalInputs });
        const outputValues = await this.executeCar(train, ready, step, ordinaryInputs, values, runDir, state, scope, localStatePath, localEventsPath);
        values[ready] = outputValues;
        state.stepValues = values;
        state.steps[ready].status = "completed";
        state.steps[ready].outputs = outputValues;
        saveLocalState();
        emitLocal("car_completed", { scope, trainId: train.definition.id, step: ready, outputs: Object.keys(outputValues) });
      } catch (error) {
        state.steps[ready].status = "pending";
        state.steps[ready].lastError = { name: error.name, message: error.message };
        saveLocalState();
        emitLocal("car_failed", { scope, trainId: train.definition.id, step: ready, error: error.message });
        error.stepId ??= ready;
        throw error;
      }
    }
    const outputs = trainBoundaryOutputs(train, values);
    state.outputs = outputs;
    state.status = "completed";
    saveLocalState();
    return { values, outputs };
  }

  async executeCar(train, stepId, step, ordinaryInputs, values, runDir, state, scope, localStatePath, localEventsPath) {
    const saveLocalState = () => this.saveState(state, localStatePath);
    const emitLocal = (type, payload = {}) => this.event(type, payload, localEventsPath);
    let iteration = 1;
    let previousOutputs = null;
    while (true) {
      if (iteration > this.maxIterations) throw new TrainExecutionError(`Car ${stepId} exceeded maxIterations=${this.maxIterations}`, { stepId, invocation: iteration });
      const invocationInputs = { ...ordinaryInputs };
      if (iteration > 1) {
        for (const [inputId, binding] of Object.entries(step.repeat.inputs)) {
          invocationInputs[inputId] = resolveReference(binding.ref, { values, currentOutputs: previousOutputs, description: `repeat input ${inputId}` });
        }
      }
      const attempt = (state.steps[stepId]?.attempts ?? 0) + 1;
      state.steps[stepId].attempts = attempt;
      const invocation = invocationId(train, stepId, iteration, attempt);
      state.steps[stepId].invocations.push({ invocation, iteration, attempt, status: "running" });
      saveLocalState();
      emitLocal("invocation_started", { scope, trainId: train.definition.id, step: stepId, invocation, iteration, attempt });
      let outputValues;
      let nestedBoundaryOutputs = null;
      if (isObject(step.procedure) && step.procedure.ref) {
        const child = train.nested.get(stepId);
        const nestedDir = path.join(runDir, "nested", safeName(stepId), `iteration-${iteration}`);
        const childStatePath = path.join(nestedDir, "state.json");
        let childState;
        if (fs.existsSync(childStatePath)) childState = readJson(childStatePath);
        else childState = {
          schemaVersion: 1,
          runnerVersion: RUNNER_VERSION,
          runId: safeName(path.basename(nestedDir)),
          trainId: child.definition.id,
          trainPath: child.filePath,
          inputs: invocationInputs,
          status: "running",
          stepValues: {},
          steps: {},
          history: [],
          createdAt: now(),
          updatedAt: now(),
        };
        if (!fs.existsSync(childStatePath)) writeJson(childStatePath, childState);
        const nestedOptionalInputs = iteration === 1 ? new Set(Object.keys(step.repeat?.inputs ?? {})) : new Set();
        const nestedResult = await this.executeTrain(child, invocationInputs, nestedDir, childState, `${scope}.${stepId}`, nestedOptionalInputs);
        outputValues = nestedResult.values;
        nestedBoundaryOutputs = nestedResult.outputs;
      } else {
        outputValues = (await this.executePiCar(train, stepId, step, invocationInputs, runDir, invocation, scope)).outputs;
      }
      const record = state.steps[stepId].invocations.at(-1);
      record.status = "needs_verification";
      saveLocalState();
      emitLocal("invocation_needs_verification", { scope, trainId: train.definition.id, step: stepId, invocation, iteration });
      record.status = "completed";
      record.outputs = outputValues;
      state.history.push({ scope, trainId: train.definition.id, step: stepId, invocation, iteration, outputs: outputValues, resultStatus: "needs_verification" });
      saveLocalState();
      emitLocal("invocation_completed", { scope, trainId: train.definition.id, step: stepId, invocation, iteration });
      if (!step.repeat) return this.resolveCarOutputs(train, stepId, step, outputValues, values, nestedBoundaryOutputs);
      const resolvedOutputs = this.resolveCarOutputs(train, stepId, step, outputValues, values, nestedBoundaryOutputs);
      const accepted = Boolean(resolveReference(step.repeat.until.ref, { values, currentOutputs: resolvedOutputs, description: "repeat.until" }));
      if (accepted) return resolvedOutputs;
      previousOutputs = resolvedOutputs;
      iteration += 1;
    }
  }

  resolveCarOutputs(train, stepId, step, producedValues, values, nestedBoundaryOutputs = null) {
    const nested = train.nested.get(stepId);
    const outputValues = {};
    for (const [outputId, binding] of Object.entries(step.outputs)) {
      if (outputBindingKind(binding) === "doc") {
        const source = nestedBoundaryOutputs ?? producedValues;
        if (!Object.prototype.hasOwnProperty.call(source, outputId)) throw new TrainExecutionError(`Pi did not produce output ${stepId}.${outputId}`, { stepId });
        outputValues[outputId] = source[outputId];
      } else if (nested) {
        outputValues[outputId] = resolveReference(binding.ref, { values: producedValues, description: `output ${outputId}` });
      } else {
        outputValues[outputId] = resolveReference(binding.ref, { values: { ...values, [stepId]: producedValues }, description: `output ${outputId}` });
      }
    }
    return outputValues;
  }

  async executePiCar(train, stepId, step, inputs, runDir, invocation, scope) {
    const stepDir = path.join(runDir, "cars", safeName(stepId), invocation);
    ensureDir(stepDir);
    const handoffPath = path.join(stepDir, "handoff.json");
    const contract = createRunContract({
      runId: `${safeName(train.definition.id)}-${safeName(stepId)}-${invocation}`,
      packageName: "@bendicsek/trains",
      packageVersion: this.packageVersion,
      goal: [
        `Execute car ${stepId} of train ${train.definition.id} in a fresh Pi context.`,
        `Procedure:\n${renderProcedure(step.procedure)}`,
        `Inputs (JSON):\n${JSON.stringify(inputs, null, 2)}`,
        `Write exactly one JSON handoff to: ${handoffPath}`,
        `Invocation: ${invocation}`,
        `Expected output names: ${Object.keys(step.outputs).join(", ")}`,
        "The handoff must contain schemaVersion=1, this runId, trainId, step, invocationId, status=ready_for_verification, outputs, evidenceRefs, and claimsNotMade.",
        "Only the declared inputs and source-of-truth files may be used. Do not read sibling car contexts or undeclared state.",
      ].join("\n\n"),
      projectDir: this.cwd,
      acceptance: Object.entries(step.outputs).map(([outputId, output]) => ({
        id: `output-${outputId}`,
        statement: output.doc ?? `Produce the referenced output ${output.ref}`,
        verify: `Read the declared handoff and confirm outputs.${outputId} exists at ${handoffPath}.`,
      })),
      sourceOfTruth: [train.filePath, handoffPath, ...Object.keys(inputs).map((inputId) => `declared input: ${inputId}`)],
      nonGoals: ["Do not claim the overall train is complete or that later cars have succeeded."],
      escalationPolicy: ["Escalate when a declared input or handoff is missing or ambiguous.", "Escalate when the procedure requires undeclared context or a product decision."],
      metadata: { workflowMode: "train-car", freshContext: true, handoffOnlyContextTransfer: true, trainId: train.definition.id, stepId, invocation, scope },
    });
    const supervisorResult = await this.supervise({
      contract,
      runDir: stepDir,
      command: this.workerCommand,
      args: this.workerArgs,
      cwd: this.cwd,
      env: { ...this.workerEnv, PI_TRAIN_RUN_DIR: this.runDir, PI_TRAIN_HANDOFF: handoffPath },
      stallMs: this.stallMs,
      maxRuntimeMs: this.maxRuntimeMs,
    });
    if (supervisorResult.status !== "needs_verification") throw new TrainExecutionError(`Pi car ${stepId} did not complete: ${supervisorResult.reason ?? supervisorResult.status}`, { stepId, invocation, supervisorResult });
    const handoff = handoffFor(handoffPath, contract, train, stepId, invocation);
    return { outputs: handoff.outputs, handoffPath, supervisorResult };
  }
}

export async function runTrain(options) {
  return new TrainRunner(options).run();
}
