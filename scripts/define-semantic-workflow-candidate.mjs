#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function slugify(input) {
  return String(input)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function stepId(step) {
  const concise = String(step.name)
    .replace(/^(frame|inspect|execute|observe|classify|intervene|update|repeat)\b.*$/i, "$1");
  return `${String(step.step).padStart(2, "0")}-${slugify(concise || step.name)}`;
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function yamlKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

function compactBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1 || !["doc", "ref"].includes(entries[0][0])) return null;
  const [key, item] = entries[0];
  if (item !== null && typeof item === "object") {
    if (!Array.isArray(item) && Object.keys(item).length === 0) return `{${key}: {}}`;
    return null;
  }
  return `{${key}: ${scalar(item)}}`;
}

function yamlLines(value, indent = 0) {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object") {
        const nested = yamlLines(item, indent + 2);
        return [`${prefix}-`, ...nested];
      }
      return [`${prefix}- ${scalar(item)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      if (item !== null && typeof item === "object") {
        const compact = compactBinding(item);
        if (compact) return [`${prefix}${yamlKey(key)}: ${compact}`];
        const empty = Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0;
        if (empty) return [`${prefix}${yamlKey(key)}: ${Array.isArray(item) ? "[]" : "{}"}`];
        return [`${prefix}${yamlKey(key)}:`, ...yamlLines(item, indent + 2)];
      }
      return [`${prefix}${yamlKey(key)}: ${scalar(item)}`];
    });
  }
  return [`${prefix}${scalar(value)}`];
}

export function renderCandidateYaml(candidate) {
  return `${yamlLines(candidate).join("\n")}\n`;
}

export function buildCandidateDefinition(report) {
  const extracted = report.extractedWorkflow;
  if (!report.topic?.name || !Array.isArray(extracted?.steps) || extracted.steps.length === 0) {
    throw new Error("semantic extraction report does not contain a workflow candidate");
  }
  if (extracted.status !== "candidate_observed_not_validated") {
    throw new Error(`unsupported extracted workflow status: ${extracted.status}`);
  }

  const workflowSteps = extracted.steps.filter((step) => !/^(Update durable evidence and state|Repeat, stop, or accept only a scoped claim at the evidence gate)$/i.test(step.name));
  const ids = workflowSteps.map(stepId).map((id, index) => index === 5 ? "resolve" : id.replace(/^\d+-/, ""));
  const outputNames = ["frame", "next_action", "scoped_result", "verification", "classification", "result"];
  const outputDocs = [
    "Intent, constraints, uncertainty, work mode, and evidence boundary.",
    "Bounded next action and stop conditions.",
    "Result of the scoped execution.",
    "Observed evidence from the relevant boundaries.",
    "Classified result, mismatch, or failure.",
    "Concrete result or reference supported by the available evidence.",
  ];
  const acceptance = [
    "Intent, constraints, uncertainty, work mode, and evidence boundary are explicit.",
    "The next action is bounded and its stop conditions are explicit.",
    "Execution stays within scope and preserves required provenance and rollback.",
    "Relevant positive, negative, runtime, and external boundaries are checked without broadening the claim.",
    "Blocked, partial, interrupted, and failed results retain their actual classification.",
    "The result is accepted only when the scoped claim is supported or an explicit stop condition is reached.",
  ];
  const steps = Object.fromEntries(workflowSteps.map((step, index) => {
    const supportCount = step.supportCount ?? step.iterationOrBoundedFollowUpSupportCount;
    if (!Number.isInteger(supportCount) || supportCount < 1) throw new Error(`invalid support count for extracted step ${step.step}`);
    const previousOutput = index === 0 ? null : outputNames[index - 1];
    const inputs = index === 0
      ? {
          intent: { doc: "Requested outcome." },
          constraints: { doc: "Optional safety, scope, and environment constraints." },
          evidence_boundary: { doc: "Evidence that may be inspected and claims it may support." },
        }
      : { [previousOutput]: { ref: `${ids[index - 1]}.${previousOutput}` } };
    const outputs = {
      [outputNames[index]]: {
        doc: outputDocs[index],
        acceptance: [acceptance[index]],
      },
    };
    const procedure = index === 1
      ? "Inspect the work and choose a bounded next probe or decision."
      : index === 5
        ? "Make the smallest evidence-backed change, route, or conclusion."
      : `${step.name.replace(/\.$/, "")}.`;
    return [ids[index], {
      inputs,
      procedure: [procedure],
      outputs,
    }];
  }));

  const cycleSteps = Object.fromEntries(Object.entries(steps).filter(([id]) => id !== ids[0]).map(([id, step], index) => {
    if (index === 0) {
      return [id, {
        ...step,
        inputs: {
          frame: { doc: "Intent, constraints, uncertainty, work mode, and evidence boundary." },
          previous: { doc: "Optional result from the previous improvement iteration." },
        },
      }];
    }
    return [id, step];
  }));
  const candidate = {
    id: slugify(report.topic.name),
    steps: {
      [ids[0]]: steps[ids[0]],
      improve: {
        inputs: { frame: { ref: `${ids[0]}.frame` } },
        procedure: { ref: "./candidate-cycle.yaml" },
        repeat: {
          inputs: { previous: { ref: "result" } },
          until: { ref: "result.accepted" },
        },
        outputs: { result: { ref: `${ids.at(-1)}.result` } },
      },
    },
  };
  Object.defineProperty(candidate, "cycleSteps", { value: cycleSteps, enumerable: false });
  return candidate;
}

export function defineCandidateFromReport({ projectDir, reportPath, outputPath }) {
  const absoluteReport = path.resolve(reportPath);
  const bytes = fs.readFileSync(absoluteReport);
  const report = JSON.parse(bytes.toString("utf8"));
  const candidate = buildCandidateDefinition(report);
  const rendered = renderCandidateYaml(candidate);
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, rendered, "utf8");
  const cycleOutputPath = path.join(path.dirname(outputPath), "candidate-cycle.yaml");
  fs.writeFileSync(cycleOutputPath, renderCandidateYaml({ id: `${candidate.id}-cycle`, steps: candidate.cycleSteps }), "utf8");
  return { candidate, rendered, cycleOutputPath };
}

function main() {
  const argv = process.argv.slice(2);
  const reportPath = value(argv, "--report", null);
  const outputPath = value(argv, "--output", null);
  const registryOutput = value(argv, "--registry-output", null);
  const replaceRegistry = value(argv, "--replace-registry", "false") === "true";
  const projectDir = path.resolve(value(argv, "--project-dir", process.cwd()));
  if (!reportPath || !outputPath) {
    throw new Error("Usage: define-semantic-workflow-candidate.mjs --report <workflow-extraction.json> --output <candidate-train.yaml> [--registry-output <workflows/candidates/name.yaml>]");
  }
  const result = defineCandidateFromReport({ projectDir, reportPath, outputPath: path.resolve(outputPath) });
  if (registryOutput) {
    const absoluteRegistryOutput = path.resolve(registryOutput);
    ensureDir(path.dirname(absoluteRegistryOutput));
    if (fs.existsSync(absoluteRegistryOutput)) {
      const existing = fs.readFileSync(absoluteRegistryOutput, "utf8");
      if (existing !== result.rendered && !replaceRegistry) {
        throw new Error(`candidate registry collision; choose a new version/path or pass --replace-registry true explicitly: ${absoluteRegistryOutput}`);
      }
    }
    fs.writeFileSync(absoluteRegistryOutput, result.rendered, "utf8");
    fs.copyFileSync(result.cycleOutputPath, path.join(path.dirname(absoluteRegistryOutput), "candidate-cycle.yaml"));
  }
  console.log(JSON.stringify({
    ok: true,
    candidateId: result.candidate.id,
    status: result.candidate.status,
    maturity: result.candidate.maturity,
    output: path.resolve(outputPath),
    registryOutput: registryOutput ? path.resolve(registryOutput) : null,
  }, null, 2));
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
