#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const METRICS = [
  "task_success",
  "outcome_fidelity",
  "human_intervention_rate",
  "unnecessary_steps",
  "safety_violations",
  "unhandled_branches",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resolve(projectDir, relativePath) {
  const resolved = path.resolve(projectDir, relativePath);
  assert(fs.existsSync(resolved), `missing artifact: ${resolved}`);
  return resolved;
}

function eventTypes(events) {
  return events.map((event) => event.type ?? event.payload?.type);
}

function validateCase(projectDir, result, caseResult) {
  assert(caseResult.supervisorStatus === "needs_verification", `case supervisor did not finish cleanly: ${caseResult.sessionId}`);
  assert(caseResult.handoffStatus === "ready_for_verification", `case handoff is not ready: ${caseResult.sessionId}`);
  const casePath = resolve(projectDir, caseResult.case);
  const handoffPath = resolve(projectDir, caseResult.handoff);
  const caseReport = readJson(casePath);
  const handoff = readJson(handoffPath);
  for (const field of ["schemaVersion", "caseId", "candidate", "baseline", "comparison", "unknowns"]) assert(field in caseReport, `case missing ${field}: ${casePath}`);
  assert(caseReport.schemaVersion === 1, `unexpected case schema: ${casePath}`);
  assert(caseReport.evaluationMode === "observational_trace_not_replay" || /not (?:causal|semantic) replay/i.test(caseReport.evaluationBoundary ?? ""), `case overclaims replay: ${casePath}`);
  assert(caseReport.sessionId === caseResult.sessionId || String(caseReport.caseId).includes(caseResult.sessionId), `case session mismatch: ${casePath}`);
  for (const side of ["candidate", "baseline"]) {
    assert(caseReport[side] && typeof caseReport[side] === "object", `case missing ${side}: ${casePath}`);
    if (Array.isArray(caseReport.metrics)) {
      assert(caseReport.metrics.length > 0, `case has no metrics: ${casePath}`);
      for (const metric of caseReport.metrics) assert(metric[side] && ["supported", "unsupported", "mixed", "unknown"].includes(metric[side].status), `case metric lacks ${side} status: ${casePath}`);
    } else if (Array.isArray(caseReport[side].metrics)) {
      assert(caseReport[side].metrics.length > 0, `case has no ${side} metrics: ${casePath}`);
      for (const metric of caseReport[side].metrics) assert(["supported", "unsupported", "mixed", "unknown"].includes(metric.status), `case metric lacks ${side} status: ${casePath}`);
    } else {
      for (const metric of METRICS) assert(caseReport[side].metrics?.[metric], `case missing ${side}.${metric}: ${casePath}`);
    }
  }
  if (Array.isArray(caseReport.metrics)) {
    for (const metric of caseReport.metrics) assert(metric.comparison && ["supported", "unsupported", "mixed", "unknown"].includes(metric.comparison.status), `case metric lacks comparison status: ${casePath}`);
  } else if (Array.isArray(caseReport.comparison?.metrics)) {
    for (const metric of caseReport.comparison.metrics) assert(["supported", "unsupported", "mixed", "unknown"].includes(metric.status), `case metric lacks comparison status: ${casePath}`);
  } else {
    for (const metric of METRICS) assert(caseReport.comparison?.metrics?.[metric], `case missing comparison.${metric}: ${casePath}`);
  }
  const boundary = handoff.boundaryChecks ?? handoff.boundary ?? {};
  assert(handoff.schemaVersion === 1 && ["observational-semantic-backtest-case-handoff", "observational_backtest_case_handoff"].includes(handoff.handoffType), `invalid case handoff: ${handoffPath}`);
  assert((handoff.status === "ready_for_verification" || handoff.resultStatus === "ready_for_verification") && (handoff.evaluationMode === "observational_trace_not_replay" || boundary.observationalOnly === true || boundary.observationalTraceOnly === true || boundary.directTraceSupportOnly === true || boundary.type === "observational_trace_not_replay"), `invalid case handoff state: ${handoffPath}`);
  for (const key of ["rawSessionOpened", "otherHistoricalSessionsOpened", "siblingWorkerArtifactsOpened", "fullTranscriptCopied", "secretsCopied", "rawTranscriptOpened", "otherCasesOpened", "workerArtifactsOpened", "causalReplay", "semanticReplay", "counterfactualEvaluation"]) assert(boundary[key] !== true, `unsafe case boundary ${key}: ${handoffPath}`);
  const packetPath = handoff.evidencePacketPath ?? caseReport.inputs?.evidencePacket;
  assert(packetPath, `case does not identify its evidence packet: ${casePath}`);
  const packet = readJson(resolve(projectDir, packetPath));
  assert(packet.packetType === "bounded-session-evidence" && packet.privacy?.fullTranscriptIncluded === false && packet.privacy?.secretsRedacted === true, `invalid case packet: ${handoff.evidencePacketPath}`);
  assert(packet.statistics?.packetCharacters < 300_000, `case packet is not bounded: ${handoff.evidencePacketPath}`);
  const eventsPath = path.join(path.dirname(casePath), "events.ndjson");
  const events = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert(events.find((event) => event.type === "supervisor_started")?.payload?.args?.includes("--no-session"), `case did not use --no-session: ${eventsPath}`);
  assert(eventTypes(events).includes("worker_finished") && eventTypes(events).includes("supervisor_finished"), `case lifecycle incomplete: ${eventsPath}`);
  return { casePath, handoffPath, eventCount: events.length };
}

function validateAggregator(projectDir, result) {
  assert(result.aggregator?.status === "needs_verification", "aggregator did not finish cleanly");
  const reportPath = resolve(projectDir, result.aggregator.reportJson);
  const markdownPath = resolve(projectDir, result.aggregator.reportMarkdown);
  const handoffPath = resolve(projectDir, result.aggregator.handoff);
  const contractPath = resolve(projectDir, result.aggregator.contract);
  const report = readJson(reportPath);
  const handoff = readJson(handoffPath);
  const contract = readJson(contractPath);
  for (const field of ["evaluationMode", "split", "candidate", "baseline", "perCase", "aggregate", "decision", "limitations", "unknowns"]) assert(field in report, `backtest report missing ${field}`);
  assert(report.evaluationMode === "observational_trace_not_replay", "backtest report overclaims replay");
  assert(report.split === result.split, "backtest split mismatch");
  assert(Array.isArray(report.perCase) && report.perCase.length === result.caseCount, "backtest per-case count mismatch");
  assert(report.aggregate?.candidate && report.aggregate?.baseline && report.aggregate?.comparison, "backtest aggregate comparison missing");
  for (const side of ["candidate", "baseline", "comparison"]) for (const metric of METRICS) assert(report.aggregate[side][metric], `backtest aggregate missing ${side}.${metric}`);
  assert(handoff.schemaVersion === 1 && handoff.handoffType === "semantic-backtest-aggregation-handoff", "invalid aggregator handoff");
  assert(handoff.status === "ready_for_verification" && handoff.caseCount === result.caseCount, "invalid aggregator handoff state");
  assert(handoff.evaluationMode === "observational_trace_not_replay", "aggregator handoff overclaims replay");
  assert(handoff.convergence?.status !== "converged", "aggregator handoff claims convergence");
  assert(JSON.stringify(handoff).toLowerCase().includes("unknown"), "aggregator handoff drops unknowns");
  assert(fs.readFileSync(markdownPath, "utf8").includes("Observational trace evaluation"), "Markdown report lacks observational boundary");
  const eventsPath = path.join(path.dirname(contractPath), "events.ndjson");
  const events = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert(events.find((event) => event.type === "supervisor_started")?.payload?.args?.includes("--no-session"), `aggregator did not use --no-session: ${eventsPath}`);
  assert(eventTypes(events).includes("supervisor_finished"), `aggregator lifecycle incomplete: ${eventsPath}`);
  return { reportPath, markdownPath, handoffPath, contractPath, eventCount: events.length };
}

function main() {
  const projectDir = path.resolve(process.argv[2] ?? ".");
  const resultPath = path.resolve(process.argv[3] ?? "latest-result.json");
  const result = readJson(resultPath);
  assert(result.status === "backtest_complete_observational", `unexpected backtest status: ${result.status}`);
  assert(result.evaluationMode === "observational_trace_not_replay", "run overclaims replay");
  assert(result.caseCount === result.caseResults?.length && result.caseCount > 0, "invalid backtest case count");
  const cases = result.caseResults.map((caseResult) => validateCase(projectDir, result, caseResult));
  const aggregator = validateAggregator(projectDir, result);
  console.log(JSON.stringify({ ok: true, runId: result.runId, attempt: result.attempt, split: result.split, evaluationMode: result.evaluationMode, caseCount: result.caseCount, cases, aggregator }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
