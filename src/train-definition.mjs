import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

export class TrainValidationError extends Error {
  constructor(filePath, errors) {
    super(`Invalid train ${filePath}:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    this.name = "TrainValidationError";
    this.filePath = filePath;
    this.errors = errors;
  }
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function bindingKind(binding) {
  if (!isObject(binding)) return null;
  const keys = Object.keys(binding);
  return keys.length === 1 && (keys[0] === "doc" || keys[0] === "ref") ? keys[0] : null;
}

export function outputBindingKind(binding) {
  if (!isObject(binding)) return null;
  const primary = ["doc", "ref"].filter((key) => Object.prototype.hasOwnProperty.call(binding, key));
  return primary.length === 1 && Object.keys(binding).every((key) => key === primary[0] || key === "acceptance") ? primary[0] : null;
}

export function refParts(ref, { localOutput = false } = {}) {
  if (!nonEmptyString(ref)) return null;
  const parts = ref.split(".");
  if (parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(part))) return null;
  if (localOutput ? parts.length < 1 : parts.length < 2) return null;
  return parts;
}

function bindingEntries(bindings, label, errors) {
  if (!isObject(bindings)) {
    errors.push(`${label} must be an object`);
    return [];
  }
  return Object.entries(bindings);
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

function validateOutput(output, label, errors) {
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

function finalOutputs(definition) {
  const consumed = new Set();
  for (const step of Object.values(definition.steps)) {
    for (const binding of Object.values(step.inputs)) {
      if (bindingKind(binding) === "ref") {
        const parts = refParts(binding.ref);
        if (parts) consumed.add(`${parts[0]}.${parts[1]}`);
      }
    }
  }
  return Object.entries(definition.steps).flatMap(([stepId, step]) => Object.keys(step.outputs)
    .filter((outputId) => !consumed.has(`${stepId}.${outputId}`))
    .map((outputId) => ({ stepId, outputId })));
}

function validateDefinition(definition, filePath, stack = []) {
  const errors = [];
  if (!isObject(definition)) return { valid: false, errors: ["root must be an object"] };
  const allowed = new Set(["id", "steps"]);
  for (const key of Object.keys(definition)) if (!allowed.has(key)) errors.push(`unknown root field ${key}; state belongs to Pi`);
  if (!nonEmptyString(definition.id)) errors.push("id must be a non-empty string");
  if (!isObject(definition.steps) || Object.keys(definition.steps).length === 0) errors.push("steps must be a non-empty object");
  if (!isObject(definition.steps)) return { valid: errors.length === 0, errors, nested: new Map(), finalOutputs: [] };

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
        else if (parts[0] === stepId) errors.push(`${label}.inputs.${inputId} cannot depend on its own output; use repeat.inputs for feedback`);
        else findOutput(definition, parts[0], parts[1], errors, `${label}.inputs.${inputId}`);
      }
    }

    const procedure = step.procedure;
    if (Array.isArray(procedure)) {
      if (procedure.length === 0 || !procedure.every(nonEmptyString)) errors.push(`${label}.procedure must contain non-empty instruction strings`);
    } else if (isObject(procedure) && Object.keys(procedure).length === 1 && nonEmptyString(procedure.ref)) {
      if (path.isAbsolute(procedure.ref) || procedure.ref.split(/[\\/]/).includes("..")) errors.push(`${label}.procedure.ref must be a contained relative path`);
      else {
        const nestedPath = path.resolve(path.dirname(filePath), procedure.ref);
        if (stack.includes(nestedPath)) errors.push(`${label}.procedure.ref creates recursive train inclusion`);
        else if (!fs.existsSync(nestedPath)) errors.push(`${label}.procedure.ref does not exist: ${nestedPath}`);
        else {
          try {
            nested.set(stepId, loadTrain(nestedPath, [...stack, filePath]));
          } catch (error) {
            errors.push(`${label}.procedure.ref is invalid: ${error.message}`);
          }
        }
      }
    } else errors.push(`${label}.procedure must be an instruction array or {ref: ./train.yaml}`);

    const outputs = bindingEntries(step.outputs, `${label}.outputs`, errors);
    if (outputs.length === 0) errors.push(`${label}.outputs must contain at least one output`);
    for (const [outputId, output] of outputs) {
      validateOutput(output, `${label}.outputs.${outputId}`, errors);
      if (outputBindingKind(output) === "ref") {
        const parts = refParts(output.ref);
        if (!parts) errors.push(`${label}.outputs.${outputId}.ref must be step.output or nested output reference`);
        else if (definition.steps[parts[0]]) findOutput(definition, parts[0], parts[1], errors, `${label}.outputs.${outputId}`);
        else if (nested.has(stepId)) findOutput(nested.get(stepId).definition, parts[0], parts[1], errors, `${label}.outputs.${outputId}`);
        else errors.push(`${label}.outputs.${outputId} cannot resolve ${output.ref}`);
      }
    }

    if (step.repeat !== undefined) {
      if (!isObject(step.repeat)) errors.push(`${label}.repeat must be an object`);
      else {
        if (Object.keys(step.repeat).some((key) => !["inputs", "until"].includes(key))) errors.push(`${label}.repeat may contain only inputs and until`);
        if (!isObject(step.repeat.inputs)) errors.push(`${label}.repeat.inputs must be an object`);
        else for (const [inputId, binding] of Object.entries(step.repeat.inputs)) {
          if (inputNames.has(inputId)) errors.push(`${label}.repeat.inputs.${inputId} would overwrite an ordinary input`);
          if (bindingKind(binding) !== "ref") errors.push(`${label}.repeat.inputs.${inputId} must be a ref`);
          else if (!refParts(binding.ref, { localOutput: true })) errors.push(`${label}.repeat.inputs.${inputId}.ref is invalid`);
        }
        if (!isObject(step.repeat.until) || bindingKind(step.repeat.until) !== "ref") errors.push(`${label}.repeat.until must be a ref`);
        else if (!refParts(step.repeat.until.ref, { localOutput: true })) errors.push(`${label}.repeat.until.ref is invalid`);
      }
    }
  }

  const docNames = new Set();
  for (const step of Object.values(definition.steps)) for (const [name, binding] of Object.entries(step.inputs)) {
    if (bindingKind(binding) === "doc") {
      if (docNames.has(name)) errors.push(`unbound doc input ${name} is declared more than once`);
      docNames.add(name);
    }
  }
  return { valid: errors.length === 0, errors, nested, interfaceInputs: [...docNames], finalOutputs: finalOutputs(definition) };
}

export function loadTrain(filePath, stack = []) {
  const absolutePath = path.resolve(filePath);
  const definition = YAML.parse(fs.readFileSync(absolutePath, "utf8"));
  const result = validateDefinition(definition, absolutePath, stack);
  if (!result.valid) throw new TrainValidationError(absolutePath, result.errors);
  return {
    definition,
    filePath: absolutePath,
    interfaceInputs: result.interfaceInputs,
    finalOutputs: result.finalOutputs,
    nested: result.nested,
  };
}
