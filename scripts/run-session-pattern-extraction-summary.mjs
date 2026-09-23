#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadContract, supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else output.push(filePath);
    }
  };
  visit(directory);
  return output.sort();
}

function validateHandoff(handoffPath, contract) {
  if (!fs.existsSync(handoffPath)) throw new Error(`missing analyst handoff: ${handoffPath}`);
  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid analyst handoff JSON at ${handoffPath}: ${error.message}`);
  }
  const required = [
    "schemaVersion",
    "runId",
    "step",
    "status",
    "inputsRead",
    "outputsWritten",
    "evidenceRefs",
    "decisions",
    "openQuestions",
    "nextStep",
    "claimsNotMade",
  ];
  const missing = required.filter((key) => !(key in handoff));
  if (missing.length > 0) throw new Error(`analyst handoff missing fields: ${missing.join(", ")}`);
  if (handoff.schemaVersion !== 1) throw new Error("analyst handoff schemaVersion must be 1");
  if (handoff.runId !== contract.runId) throw new Error(`analyst handoff runId mismatch: ${handoff.runId}`);
  if (handoff.step !== "post-run-analysis") throw new Error(`analyst handoff step mismatch: ${handoff.step}`);
  if (!Array.isArray(handoff.outputsWritten) || !Array.isArray(handoff.evidenceRefs)) {
    throw new Error("analyst handoff outputsWritten and evidenceRefs must be arrays");
  }
  return handoff;
}

export async function runExecutiveSummary({
  masterContractPath,
  chainDir: chainDirOverride,
  artifactDir: artifactDirOverride,
  node = "/home/bendi/.nvm/versions/node/v22.22.0/bin/node",
  piCli = "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  agentDir = "/home/bendi/.pi/agent",
  provider = "openai-codex",
  model = "gpt-5.6-luna",
  thinking = "xhigh",
  stallMs = 300000,
  runtimeMs = 900000,
} = {}) {
  const masterPath = path.resolve(masterContractPath);
  const master = loadContract(masterPath);
  const projectDir = master.projectDir;
  const runDir = path.dirname(masterPath);
  const chainDir = path.resolve(chainDirOverride ?? path.join(runDir, "chain"));
  const artifactDir = path.resolve(artifactDirOverride ?? path.join(projectDir, "artifacts/session-pattern-extraction/full-4-20260914"));
  const analystDir = path.join(chainDir, "analyst");
  const analystContractPath = path.join(analystDir, "contract.json");
  const handoffPath = path.join(analystDir, "handoff.json");
  const summaryJsonPath = path.join(artifactDir, "executive-summary.json");
  const summaryMarkdownPath = path.join(artifactDir, "executive-summary.md");
  const chainResultPath = path.join(chainDir, "chain-result.json");
  const chainManifestPath = path.join(chainDir, "chain-manifest.json");
  const chainEventsPath = path.join(chainDir, "chain-events.ndjson");

  if (!fs.existsSync(chainResultPath)) throw new Error(`missing completed chain result: ${chainResultPath}`);
  if (!fs.existsSync(chainManifestPath)) throw new Error(`missing chain manifest: ${chainManifestPath}`);

  const excludedAnalystOutputs = new Set([summaryJsonPath, summaryMarkdownPath, analystContractPath, handoffPath]);
  const sourceOfTruth = [
    masterPath,
    path.join(projectDir, "trains/session-pattern-extraction/session-pattern-extraction.yaml"),
    path.join(projectDir, "docs/session-pattern-extraction.md"),
    chainManifestPath,
    chainResultPath,
    chainEventsPath,
    ...listFiles(path.join(chainDir, "steps")),
    ...listFiles(artifactDir),
  ].filter((filePath, index, files) => fs.existsSync(filePath)
    && !excludedAnalystOutputs.has(filePath)
    && files.indexOf(filePath) === index);

  const contract = {
    schemaVersion: 1,
    runId: `${master.runId}-analyst`,
    package: master.package,
    createdAt: new Date().toISOString(),
    goal: [
      "You are the independent post-run analysis subagent for a completed session-pattern-extraction train.",
      "This is a fresh Pi context. Inspect only the declared logs, handoffs, run artifacts, workflow definition, and chain result.",
      "Do not read raw historical session files, other Pi sessions, hidden agent state, or undeclared files.",
      "Produce an executive summary that a founder can understand without opening the ledgers.",
      "Write the required JSON report to the declared JSON output and a concise Markdown report to the declared Markdown output.",
      "The report must cover: the run/session topic, exact session and run statistics, the extracted workflow, what is new versus matched to existing workflow definitions, and convergence in iterations/stages.",
      "Treat structural-only evidence as structural-only. If task text, semantic topics, outcome quality, or workflow execution success is unavailable, write unknown rather than inferring it.",
      "Use evidence references that point to declared artifact paths and JSON fields. Distinguish observed, inferred, and unknown claims.",
      `Write the analyst handoff to ${handoffPath}; it must contain schemaVersion, runId, step, status, inputsRead, outputsWritten, evidenceRefs, decisions, openQuestions, nextStep, and claimsNotMade.`,
    ].join(" "),
    projectDir,
    claimBoundary: {
      mayClaim: [
        "exact counts and distributions present in the declared run artifacts",
        "the explicit target behavior and convergence decision recorded by the train",
        "structural workflow steps and pattern support when directly present in artifacts",
        "new or matched status only when compared against declared workflow definitions",
      ],
      mayNotClaim: [
        "semantic session topics when the source run is structural-only",
        "task correctness, user value, or executable runtime success from trace shape",
        "that a clean Pi exit is independent verification",
        "that unknown metrics are passing metrics",
      ],
    },
    acceptance: [
      {
        id: "R1",
        statement: `The JSON executive report exists at ${summaryJsonPath} and contains run, stats, extractedWorkflow, comparison, convergence, and unknowns sections.`,
        verify: `Read ${summaryJsonPath}; validate the required top-level fields and evidence references.`,
      },
      {
        id: "R2",
        statement: `The Markdown executive report exists at ${summaryMarkdownPath} and includes topic, stats, extracted workflow, new-versus-matched, and convergence sections.`,
        verify: `Read ${summaryMarkdownPath}; confirm all required headings and explicit unknowns are present.`,
      },
      {
        id: "R3",
        statement: `The analyst handoff exists at ${handoffPath} and records the report outputs and claims boundary.`,
        verify: `Validate the handoff schema, identity, and output paths after the Pi process exits.`,
      },
    ],
    sourceOfTruth,
    nonGoals: [
      "Do not alter workflow definitions, source transcripts, train artifacts, or sibling repositories.",
      "Do not perform a second backtest or open the sealed holdout.",
      "Do not fill unknown semantic fields with guesses based on filenames, tools, or timestamps.",
    ],
    escalationPolicy: [
      "Escalate if the completed chain result or required artifact set is missing or inconsistent.",
      "Escalate if the report cannot distinguish structural evidence from semantic evidence.",
      "Escalate if provider authentication, model access, or factory tools are unavailable.",
    ],
    metadata: {
      workflowMode: "session-pattern-extraction-post-run-analysis",
      freshContext: true,
      handoffOnlyContextTransfer: true,
      inputBoundary: "completed train logs, handoffs, and artifacts only",
      outputs: [summaryJsonPath, summaryMarkdownPath, handoffPath],
      reportFields: [
        "topic",
        "stats",
        "extractedWorkflow",
        "newPatterns",
        "matchedExisting",
        "convergence",
        "unknowns",
      ],
    },
  };
  writeJson(analystContractPath, contract);

  const args = [
    piCli,
    "--mode", "rpc",
    "--no-session",
    "--provider", provider,
    "--model", model,
    "--thinking", thinking,
    "--extension", "/home/bendi/pi-product-factory/extensions/factory.js",
  ];
  const supervisorResult = await supervisePi({
    contract,
    contractPath: analystContractPath,
    command: node,
    args,
    cwd: projectDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
    stallMs,
    maxRuntimeMs: runtimeMs,
  });

  let handoff = null;
  let status = supervisorResult.status;
  let reason = supervisorResult.reason ?? null;
  if (status !== "escalated") {
    try {
      handoff = validateHandoff(handoffPath, contract);
      for (const outputPath of [summaryJsonPath, summaryMarkdownPath]) {
        if (!fs.existsSync(outputPath)) throw new Error(`missing analyst output: ${outputPath}`);
      }
    } catch (error) {
      status = "escalated";
      reason = "invalid_analyst_handoff";
      supervisorResult.error = error.message;
    }
  }

  const chainResult = JSON.parse(fs.readFileSync(chainResultPath, "utf8"));
  chainResult.postRunAnalysis = {
    status,
    reason,
    contract: path.relative(projectDir, analystContractPath),
    handoff: path.relative(projectDir, handoffPath),
    summaryJson: path.relative(projectDir, summaryJsonPath),
    summaryMarkdown: path.relative(projectDir, summaryMarkdownPath),
  };
  writeJson(chainResultPath, chainResult);

  return {
    status,
    reason,
    supervisorResult,
    contractPath: analystContractPath,
    handoffPath,
    summaryJsonPath,
    summaryMarkdownPath,
    handoff,
  };
}

function usage() {
  console.error(`Usage:
  run-session-pattern-extraction-summary.mjs --contract <contract.json>
    [--chain-dir <dir>] [--artifact-dir <dir>]
    [--stall-ms 300000] [--runtime-ms 900000]
    [--node <node>] [--pi-cli <cli.js>] [--agent-dir <dir>]
    [--provider openai-codex] [--model gpt-5.6-luna] [--thinking xhigh]`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const masterContractPath = value(argv, "--contract");
  if (!masterContractPath) {
    usage();
    process.exitCode = 2;
  } else {
    try {
      const result = await runExecutiveSummary({
        masterContractPath,
        chainDir: value(argv, "--chain-dir"),
        artifactDir: value(argv, "--artifact-dir"),
        node: value(argv, "--node", "/home/bendi/.nvm/versions/node/v22.22.0/bin/node"),
        piCli: value(argv, "--pi-cli", "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        agentDir: value(argv, "--agent-dir", "/home/bendi/.pi/agent"),
        provider: value(argv, "--provider", "openai-codex"),
        model: value(argv, "--model", "gpt-5.6-luna"),
        thinking: value(argv, "--thinking", "xhigh"),
        stallMs: Number(value(argv, "--stall-ms", "300000")),
        runtimeMs: Number(value(argv, "--runtime-ms", "900000")),
      });
      console.log(JSON.stringify({
        status: result.status,
        reason: result.reason,
        contractPath: result.contractPath,
        handoffPath: result.handoffPath,
        summaryJsonPath: result.summaryJsonPath,
        summaryMarkdownPath: result.summaryMarkdownPath,
      }, null, 2));
      process.exitCode = result.status === "escalated" ? 1 : 0;
    } catch (error) {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    }
  }
}
