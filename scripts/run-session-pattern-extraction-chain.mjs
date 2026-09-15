#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { loadContract, supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";
import { runExecutiveSummary } from "./run-session-pattern-extraction-summary.mjs";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function usage() {
  console.error(`Usage:
  run-session-pattern-extraction-chain.mjs --contract <contract.json>
    [--stall-ms 300000] [--stage-runtime-ms 1800000]
    [--chain-dir <dir>] [--artifact-dir <dir>]
    [--no-analyst] [--analyst-runtime-ms 900000]
    [--node <node>] [--pi-cli <cli.js>] [--agent-dir <dir>]
    [--provider openai-codex] [--model gpt-5.6-luna] [--thinking xhigh]`);
}

const argv = process.argv.slice(2);
const contractPath = value(argv, "--contract");
if (!contractPath) {
  usage();
  process.exitCode = 2;
} else {
  const masterContractPath = path.resolve(contractPath);
  const master = loadContract(masterContractPath);
  const runDir = path.dirname(masterContractPath);
  const projectDir = master.projectDir;
  const artifactDir = path.resolve(value(
    argv,
    "--artifact-dir",
    path.join(projectDir, "artifacts/session-pattern-extraction/full-4-20260914"),
  ));
  const chainDir = path.resolve(value(argv, "--chain-dir", path.join(runDir, "chain")));
  const stepsDir = path.join(chainDir, "steps");
  const chainEventsPath = path.join(chainDir, "chain-events.ndjson");
  const chainResultPath = path.join(chainDir, "chain-result.json");
  const node = value(argv, "--node", "/home/bendi/.nvm/versions/node/v22.22.0/bin/node");
  const piCli = value(argv, "--pi-cli", "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const agentDir = value(argv, "--agent-dir", "/home/bendi/.pi/agent");
  const extension = "/home/bendi/pi-product-factory/extensions/factory.js";
  const stallMs = Number(value(argv, "--stall-ms", "300000"));
  const stageRuntimeMs = Number(value(argv, "--stage-runtime-ms", "1800000"));
  const analystRuntimeMs = Number(value(argv, "--analyst-runtime-ms", "900000"));
  const maxIterations = Number(master.metadata?.maxIterations ?? 6);

  const stages = [
    {
      id: "identify-sessions",
      number: 1,
      title: "Identify sessions",
      action: "Build the complete session inventory and fixed development/tuning/holdout split from the frozen structural index.",
      inputs: [],
      outputs: ["01-session-inventory.json"],
      next: "extract-workflow",
    },
    {
      id: "extract-workflow",
      number: 2,
      title: "Extract workflow patterns",
      action: "Extract structural pattern cards from the development inventory, preserving support, uncertainty, contradictions, and rejected patterns.",
      inputs: ["01-session-inventory.json"],
      outputs: ["02-pattern-catalog.json"],
      next: "define-workflow",
    },
    {
      id: "define-workflow",
      number: 3,
      title: "Define the candidate train",
      action: "Define the baseline and the first candidate train from the pattern catalog, with explicit handoffs, checks, and safety boundaries.",
      inputs: ["02-pattern-catalog.json"],
      outputs: ["03-baseline-definition.json", "04-candidate-train-v1.json"],
      next: "backtest",
    },
    {
      id: "backtest",
      number: 4,
      title: "Backtest the candidate",
      action: "Run a trace-level candidate-versus-baseline backtest on the fixed tuning group without opening raw sessions or using holdout evidence.",
      inputs: ["03-baseline-definition.json", "04-candidate-train-v1.json"],
      outputs: [],
      next: "compare-adjust",
    },
    {
      id: "compare-adjust",
      number: 5,
      title: "Compare and adjust",
      action: "Compare candidate, baseline, and prior iteration; make at most the declared small, evidence-backed adjustment and record its expected effect.",
      inputs: ["03-baseline-definition.json", "04-candidate-train-v1.json"],
      outputs: [],
      next: "loop-until-converged",
    },
    {
      id: "loop-until-converged",
      number: 6,
      title: "Decide convergence",
      action: "Decide whether to loop to backtest with the adjusted candidate, or freeze and evaluate the untouched holdout; return insufficient_evidence when the structural boundary cannot support convergence.",
      inputs: [],
      outputs: [],
      next: "backtest or complete",
    },
  ];

  const ensureDir = (directory) => fs.mkdirSync(directory, { recursive: true });
  const writeJson = (filePath, payload) => {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  };
  const appendEvent = (type, payload = {}) => {
    ensureDir(chainDir);
    fs.appendFileSync(chainEventsPath, `${JSON.stringify({
      at: new Date().toISOString(),
      runId: master.runId,
      source: "chain-orchestrator",
      type,
      payload,
    })}\n`, "utf8");
  };
  const relative = (filePath) => path.relative(projectDir, filePath) || ".";

  const initialHandoffPath = path.join(chainDir, "00-initial-handoff.json");
  writeJson(initialHandoffPath, {
    schemaVersion: 1,
    runId: master.runId,
    step: "initial-input",
    status: "ready",
    sourceOfTruth: [relative(masterContractPath), relative(path.join(projectDir, "workflows/session-pattern-extraction.yaml")), relative(path.join(projectDir, "artifacts/session-pattern-extraction/full-20260914/corpus-index.json"))],
    targetBehavior: "structural cross-session agent workflow behavior",
    reasoning: [],
    nextStep: "identify-sessions",
  });

  const stepContract = ({ stage, iteration, stepDir, inputHandoffPath, priorArtifacts, outputArtifacts }) => {
    const stepRunId = `${master.runId}-step-${String(stage.number).padStart(2, "0")}-${stage.id}${iteration ? `-i${iteration}` : ""}`;
    const handoffPath = path.join(stepDir, "handoff.json");
    const sourceOfTruth = [
      masterContractPath,
      path.join(projectDir, "workflows/session-pattern-extraction.yaml"),
      path.join(projectDir, "docs/session-pattern-extraction.md"),
      path.join(projectDir, "artifacts/session-pattern-extraction/full-20260914/corpus-index.json"),
      inputHandoffPath,
      ...priorArtifacts,
    ].filter(Boolean);
    const mayClaim = stage.id === "loop-until-converged"
      ? ["the explicit structural convergence decision recorded in the handoff and convergence artifact"]
      : [`the ${stage.title.toLowerCase()} artifact and handoff were written and satisfy their explicit structural checks`];
    return {
      schemaVersion: 1,
      runId: stepRunId,
      package: master.package,
      createdAt: new Date().toISOString(),
      goal: [
        `You are stage ${stage.number} of ${stages.length} in the session-pattern-extraction chain: ${stage.title}.`,
        "This is a fresh Pi context. Read only the declared input handoff and the declared source-of-truth files for this stage.",
        "Do not read prior Pi events, another step's contract, another step's handoff, or any raw historical session file.",
        stage.action,
        `Write only the declared artifacts and then write the required JSON handoff to ${handoffPath}.`,
        "The handoff must contain schemaVersion, runId, step, status, inputsRead, outputsWritten, evidenceRefs, decisions, openQuestions, nextStep, and claimsNotMade.",
        stage.id === "loop-until-converged"
          ? "The handoff must also contain convergence: {status: continue|converged|insufficient_evidence|max_iterations_exceeded|unsafe|overfit, iteration, reason}; use continue only when the next backtest has a justified adjustment."
          : "Use status complete when the stage work is done even if a measured result is unknown; preserve unknowns in openQuestions and claimsNotMade.",
      ].join(" "),
      projectDir,
      claimBoundary: {
        mayClaim,
        mayNotClaim: [
          "semantic workflow truth from structural metadata",
          "task correctness, user value, or executable runtime success",
          "that a clean Pi exit is independent verification",
          "that any unknown metric is a pass",
        ],
      },
      acceptance: [
        {
          id: "H1",
          statement: `The stage writes a valid JSON handoff at ${handoffPath} with the required fields and only declared input/output references.`,
          verify: `Read ${handoffPath} and validate its schema, step id, run id, and declared paths.`,
        },
        {
          id: "S1",
          statement: "The stage writes its declared structural artifacts without opening, copying, or emitting raw historical session text.",
          verify: "Inspect the artifact manifest and run the independent chain verifier after the stage completes.",
        },
      ],
      sourceOfTruth,
      nonGoals: [
        "Do not read, modify, delete, or copy any historical session file.",
        "Do not read another stage's reasoning or events; the handoff is the only inter-stage context.",
        "Do not modify workflow source, documentation, or sibling repositories.",
        "Do not claim semantic, outcome, runtime, or user-value evidence from structural metadata.",
      ],
      escalationPolicy: [
        "Escalate if the declared handoff or structural input is missing, inconsistent, or ambiguous.",
        "Escalate rather than opening raw sessions or reading another stage's private context.",
        "Escalate if provider authentication, model access, or factory tools are unavailable.",
        "Escalate if the requested stage would require a product decision or a scope change.",
      ],
      metadata: {
        workflowMode: "session-pattern-extraction-step",
        freshContext: true,
        stage: stage.id,
        iteration,
        inputHandoff: inputHandoffPath ? relative(inputHandoffPath) : null,
        outputHandoff: relative(handoffPath),
        priorArtifacts: priorArtifacts.map(relative),
        outputArtifacts: outputArtifacts.map(relative),
        requiredEvidence: [
          "Use factory_checkpoint at the stage start and after the main artifact is written.",
          "Use factory_handoff with the same concise status recorded in the handoff file.",
          "Record unknown metrics and rejected or contradictory patterns instead of smoothing them away.",
        ],
      },
    };
  };

  const validateHandoff = (handoffPath, stageContract, stage) => {
    if (!fs.existsSync(handoffPath)) throw new Error(`missing handoff: ${handoffPath}`);
    let handoff;
    try {
      handoff = JSON.parse(fs.readFileSync(handoffPath, "utf8"));
    } catch (error) {
      throw new Error(`invalid handoff JSON at ${handoffPath}: ${error.message}`);
    }
    const required = ["schemaVersion", "runId", "step", "status", "inputsRead", "outputsWritten", "evidenceRefs", "decisions", "openQuestions", "nextStep", "claimsNotMade"];
    const missing = required.filter((key) => !(key in handoff));
    if (missing.length > 0) throw new Error(`handoff missing fields: ${missing.join(", ")}`);
    if (handoff.schemaVersion !== 1) throw new Error("handoff schemaVersion must be 1");
    if (handoff.runId !== stageContract.runId) throw new Error(`handoff runId mismatch: ${handoff.runId}`);
    if (handoff.step !== stage.id) throw new Error(`handoff step mismatch: ${handoff.step}`);
    if (!Array.isArray(handoff.outputsWritten) || !Array.isArray(handoff.evidenceRefs)) throw new Error("handoff outputsWritten and evidenceRefs must be arrays");
    if (stage.id === "loop-until-converged" && !handoff.convergence?.status) throw new Error("convergence handoff must include convergence.status");
    return handoff;
  };

  const piArgs = [
    piCli,
    "--mode", "rpc",
    "--no-session",
    "--provider", value(argv, "--provider", "openai-codex"),
    "--model", value(argv, "--model", "gpt-5.6-luna"),
    "--thinking", value(argv, "--thinking", "xhigh"),
    "--extension", extension,
  ];

  const results = [];
  let previousHandoffPath = initialHandoffPath;
  let status = "needs_verification";
  let iteration = 0;
  let iterationsRun = 0;
  let failed = false;

  ensureDir(stepsDir);
  writeJson(path.join(chainDir, "chain-manifest.json"), {
    schemaVersion: 1,
    runId: master.runId,
    contextBoundary: "one fresh Pi --no-session process per train step; only declared JSON handoffs cross steps",
    stages: stages.map(({ id, number, title }) => ({ id, number, title })),
    maxIterations,
    sourceIndex: relative(path.join(projectDir, "artifacts/session-pattern-extraction/full-20260914/corpus-index.json")),
  });
  appendEvent("chain_started", { contextBoundary: "fresh_context_per_step", maxIterations });

  const runStage = async (stage, stageIteration, inputHandoffPath, priorArtifacts, outputArtifacts) => {
    const stageDir = path.join(stepsDir, `${String(stage.number).padStart(2, "0")}-${stage.id}${stageIteration ? `-i${stageIteration}` : ""}`);
    const stepContractPath = path.join(stageDir, "contract.json");
    const contract = stepContract({ stage, iteration: stageIteration, stepDir: stageDir, inputHandoffPath, priorArtifacts, outputArtifacts });
    writeJson(stepContractPath, contract);
    appendEvent("step_started", { step: stage.id, iteration: stageIteration, runId: contract.runId, inputHandoff: relative(inputHandoffPath), outputHandoff: relative(path.join(stageDir, "handoff.json")) });
    const supervisorResult = await supervisePi({
      contract,
      contractPath: stepContractPath,
      command: node,
      args: piArgs,
      cwd: projectDir,
      env: { PI_CODING_AGENT_DIR: agentDir },
      stallMs,
      maxRuntimeMs: stageRuntimeMs,
    });
    const handoffPath = path.join(stageDir, "handoff.json");
    if (supervisorResult.status === "escalated") {
      appendEvent("step_escalated", { step: stage.id, iteration: stageIteration, reason: supervisorResult.reason });
      return { stage, iteration: stageIteration, contractPath: stepContractPath, handoffPath, supervisorResult, handoff: null };
    }
    let handoff;
    try {
      handoff = validateHandoff(handoffPath, contract, stage);
    } catch (error) {
      appendEvent("step_handoff_invalid", { step: stage.id, iteration: stageIteration, error: error.message });
      return { stage, iteration: stageIteration, contractPath: stepContractPath, handoffPath, supervisorResult: { ...supervisorResult, status: "escalated", reason: "invalid_step_handoff", error: error.message }, handoff: null };
    }
    appendEvent("step_finished", { step: stage.id, iteration: stageIteration, status: supervisorResult.status, handoffStatus: handoff.status, convergence: handoff.convergence?.status ?? null });
    return { stage, iteration: stageIteration, contractPath: stepContractPath, handoffPath, supervisorResult, handoff };
  };

  const record = (result) => {
    results.push({
      step: result.stage.id,
      iteration: result.iteration,
      runId: result.supervisorResult?.runId ?? null,
      supervisorStatus: result.supervisorResult.status,
      reason: result.supervisorResult.reason ?? null,
      handoff: result.handoffPath ? relative(result.handoffPath) : null,
      convergence: result.handoff?.convergence?.status ?? null,
    });
  };

  for (const stage of stages.slice(0, 3)) {
    const outputArtifacts = stage.outputs.map((name) => path.join(artifactDir, name));
    const result = await runStage(stage, 0, previousHandoffPath, [], outputArtifacts);
    record(result);
    if (result.supervisorResult.status === "escalated") {
      failed = true;
      break;
    }
    previousHandoffPath = result.handoffPath;
  }

  if (!failed) {
    for (iteration = 1; iteration <= maxIterations; iteration += 1) {
      iterationsRun = iteration;
      const backtest = stages[3];
      const candidateArtifact = path.join(artifactDir, `04-candidate-train-v${iteration}.json`);
      const baselineArtifact = path.join(artifactDir, "03-baseline-definition.json");
      const inventoryArtifact = path.join(artifactDir, "01-session-inventory.json");
      const backtestResult = await runStage(
        backtest,
        iteration,
        previousHandoffPath,
        [baselineArtifact, candidateArtifact, inventoryArtifact],
        [path.join(artifactDir, `05-backtest-i${iteration}.json`)],
      );
      record(backtestResult);
      if (backtestResult.supervisorResult.status === "escalated") { failed = true; break; }

      const compare = stages[4];
      const compareResult = await runStage(
        compare,
        iteration,
        backtestResult.handoffPath,
        [baselineArtifact, candidateArtifact, path.join(artifactDir, `05-backtest-i${iteration}.json`)],
        [path.join(artifactDir, `06-comparison-adjustment-i${iteration}.json`), path.join(artifactDir, `04-candidate-train-v${iteration + 1}.json`)],
      );
      record(compareResult);
      if (compareResult.supervisorResult.status === "escalated") { failed = true; break; }

      const converge = stages[5];
      const convergeResult = await runStage(
        converge,
        iteration,
        compareResult.handoffPath,
        [path.join(artifactDir, `05-backtest-i${iteration}.json`), path.join(artifactDir, `06-comparison-adjustment-i${iteration}.json`), path.join(artifactDir, `04-candidate-train-v${iteration + 1}.json`)],
        [path.join(artifactDir, `08-convergence-record-i${iteration}.json`), path.join(artifactDir, `09-holdout-evaluation-i${iteration}.json`)],
      );
      record(convergeResult);
      if (convergeResult.supervisorResult.status === "escalated") { failed = true; break; }

      const convergenceStatus = convergeResult.handoff.convergence.status;
      previousHandoffPath = convergeResult.handoffPath;
      if (convergenceStatus !== "continue") {
        status = convergenceStatus;
        break;
      }
      if (iteration === maxIterations) status = "max_iterations_exceeded";
    }
  }

  if (failed) status = "escalated";
  const result = {
    runId: master.runId,
    status,
    contextBoundary: "fresh Pi --no-session process per stage; inter-stage state crosses only through declared JSON handoffs",
    iterations: iterationsRun,
    stages: results,
    finalHandoff: previousHandoffPath ? relative(previousHandoffPath) : null,
    unknowns: [
      "semantic workflow truth, task correctness, user value, executable runtime success, and universal convergence remain outside the structural claim boundary",
    ],
  };
  writeJson(chainResultPath, result);
  appendEvent("chain_finished", { status, iterations: iterationsRun, stages: results.length, finalHandoff: relative(previousHandoffPath) });

  if (!argv.includes("--no-analyst")) {
    appendEvent("post_run_analysis_started", { input: relative(chainResultPath) });
    try {
      const analysis = await runExecutiveSummary({
        masterContractPath,
        chainDir,
        artifactDir,
        node,
        piCli,
        agentDir,
        provider: value(argv, "--provider", "openai-codex"),
        model: value(argv, "--model", "gpt-5.6-luna"),
        thinking: value(argv, "--thinking", "xhigh"),
        stallMs,
        runtimeMs: analystRuntimeMs,
      });
      result.postRunAnalysis = {
        status: analysis.status,
        reason: analysis.reason,
        contract: relative(analysis.contractPath),
        handoff: relative(analysis.handoffPath),
        summaryJson: relative(analysis.summaryJsonPath),
        summaryMarkdown: relative(analysis.summaryMarkdownPath),
      };
      appendEvent("post_run_analysis_finished", result.postRunAnalysis);
    } catch (error) {
      result.postRunAnalysis = {
        status: "escalated",
        reason: error.message,
      };
      appendEvent("post_run_analysis_escalated", result.postRunAnalysis);
    }
    writeJson(chainResultPath, result);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = status === "escalated" || result.postRunAnalysis?.status === "escalated" ? 1 : 0;
}
