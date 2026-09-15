#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { buildCandidateDefinition, renderCandidateYaml } from "./define-semantic-workflow-candidate.mjs";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function boundaryCheck(boundary, pattern, safeTextPattern) {
  const entries = Object.entries(boundary ?? {}).filter(([name]) => pattern.test(name));
  const allText = Array.isArray(boundary)
    ? boundary.map((value) => typeof value === "object" ? JSON.stringify(value) : String(value)).join("\n")
    : Object.entries(boundary ?? {}).map(([name, value]) => `${name}: ${String(value)}`).join("\n");
  const lines = allText.split(/[\n.;]+/).filter(Boolean);
  const positive = /\b(?:opened|read|copied|included|accessed|exposed)\b/i;
  const negative = /\b(?:no|not|never|without|did not|was not|were not)\b/i;
  return { hasSafe: entries.some(([, value]) => value === false) || safeTextPattern.test(allText) || lines.some((line) => pattern.test(line) && negative.test(line)), hasTrue: entries.some(([, value]) => value === true) || lines.some((line) => pattern.test(line) && positive.test(line) && !negative.test(line)) };
}

function file(projectDir, relativePath) {
  const resolved = path.resolve(projectDir, relativePath);
  assert(fs.existsSync(resolved), `missing artifact: ${resolved}`);
  return resolved;
}

function eventTypes(events) {
  return events.map((event) => event.type ?? event.payload?.type);
}

function validateDossier({ projectDir, result, dossierResult }) {
  assert(dossierResult.supervisorStatus === "needs_verification", `dossier supervisor did not finish cleanly: ${dossierResult.sessionId}`);
  assert(dossierResult.handoffStatus === "ready_for_verification", `dossier handoff is not ready: ${dossierResult.sessionId}`);
  const dossierPath = file(projectDir, dossierResult.dossier);
  const handoffPath = file(projectDir, dossierResult.handoff);
  const dossier = readJson(dossierPath);
  const handoff = readJson(handoffPath);
  for (const field of ["schemaVersion", "topic", "buildingAssessment", "workflowTrace", "evidence", "unknowns", "claimsNotMade"]) assert(field in dossier, `dossier missing ${field}: ${dossierPath}`);
  assert(dossier.schemaVersion === 1, `unexpected dossier schema: ${dossierPath}`);
  assert(!Object.keys(dossier).some((key) => /transcript|rawMessages|conversation/i.test(key)), `dossier has transcript-shaped top-level field: ${dossierPath}`);
  assert(fs.statSync(dossierPath).size < 100_000, `dossier is not bounded: ${dossierPath}`);
  assert(handoff.schemaVersion === 1 && handoff.handoffType === "semantic-session-dossier-handoff", `invalid dossier handoff type: ${handoffPath}`);
  assert(handoff.runId.endsWith(`-${dossierResult.sessionId}`), `dossier handoff run does not identify session: ${handoffPath}`);
  assert(handoff.status === "ready_for_verification", `dossier handoff status: ${handoffPath}`);
  const rawSession = boundaryCheck(handoff.boundaryChecks, /raw.*session|session.*raw/i, /only the declared evidence packet|raw(?:\s+\w+){0,3}\s+session[^\n.;]*\b(?:not|no|never)\b/i);
  const otherSession = boundaryCheck(handoff.boundaryChecks, /other.*historical.*session|historical.*session.*other|other.*session/i, /only the declared evidence packet|other\s+(?:historical\s+)?sessions?[^\n.;]*\b(?:not|no|never)\b/i);
  const siblingData = boundaryCheck(handoff.boundaryChecks, /sibling|other.*worker|worker.*artifact|other.*artifact/i, /only the declared evidence packet|(?:sibling|other workers?|worker artifacts?|sibling dossiers?)[^\n.;]*\b(?:not|no|never)\b/i);
  const transcript = boundaryCheck(handoff.boundaryChecks, /transcript/i, /(?:no|not|never)\b[^\n.;]*(?:full|raw) transcript|(?:full|raw) transcript[^\n.;]*\b(?:not|no|never)\b/i);
  const secrets = boundaryCheck(handoff.boundaryChecks, /secret/i, /(?:no|not|never)\b[^\n.;]*secret|secret[^\n.;]*\b(?:not|no|never)\b/i);
  assert(rawSession.hasSafe && !rawSession.hasTrue, `dossier handoff raw-session boundary is invalid: ${handoffPath}`);
  assert(otherSession.hasSafe && !otherSession.hasTrue, `dossier handoff other-session boundary is invalid: ${handoffPath}`);
  assert(siblingData.hasSafe && !siblingData.hasTrue, `dossier handoff sibling boundary is invalid: ${handoffPath}`);
  assert(transcript.hasSafe && !transcript.hasTrue, `dossier handoff transcript boundary is invalid: ${handoffPath}`);
  assert(secrets.hasSafe && !secrets.hasTrue, `dossier handoff secret boundary is invalid: ${handoffPath}`);

  const packetPath = file(projectDir, handoff.evidencePacketPath);
  const packet = readJson(packetPath);
  assert(packet.packetType === "bounded-session-evidence", `unexpected packet type: ${packetPath}`);
  assert(packet.privacy?.fullTranscriptIncluded === false, `packet includes full transcript: ${packetPath}`);
  assert(packet.privacy?.secretsRedacted === true, `packet is not marked redacted: ${packetPath}`);
  assert(packet.statistics?.packetCharacters < 300_000, `packet exceeds bounded size: ${packetPath}`);

  const eventsPath = path.join(path.dirname(file(projectDir, dossierResult.dossier)), "events.ndjson");
  const events = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const supervisorStart = events.find((event) => event.type === "supervisor_started");
  assert(supervisorStart?.payload?.args?.includes("--no-session"), `dossier was not launched with --no-session: ${eventsPath}`);
  assert(eventTypes(events).includes("worker_finished"), `dossier has no worker_finished event: ${eventsPath}`);
  assert(eventTypes(events).includes("supervisor_finished"), `dossier has no supervisor_finished event: ${eventsPath}`);
  return { dossierPath, handoffPath, packetPath, eventsPath, eventCount: events.length };
}

function validateAggregator({ projectDir, result }) {
  assert(result.aggregator?.status === "needs_verification", "aggregator supervisor did not finish cleanly");
  const reportJsonPath = file(projectDir, result.aggregator.reportJson);
  const reportMarkdownPath = file(projectDir, result.aggregator.reportMarkdown);
  const candidateTrainPath = file(projectDir, result.aggregator.candidateTrain);
  const handoffPath = file(projectDir, result.aggregator.handoff);
  const contractPath = file(projectDir, result.aggregator.contract);
  const report = readJson(reportJsonPath);
  const handoff = readJson(handoffPath);
  const contract = readJson(contractPath);
  for (const field of ["topic", "stats", "extractedWorkflow", "matchedPriorIdea", "newFromSessions", "contradictions", "backtestPlan", "unknowns"]) assert(field in report, `aggregator report missing ${field}`);
  const backtestStatus = String(report.backtestPlan.status ?? "").toLowerCase().replace(/[_-]+/g, " ");
  const convergenceClaim = String(report.backtestPlan.convergenceClaim ?? "").toLowerCase().replace(/[_-]+/g, " ");
  assert((backtestStatus === "pending" || backtestStatus.startsWith("pending ")) && (report.backtestPlan.convergenceClaim === false || convergenceClaim === "not converged" || convergenceClaim === "false"), "aggregator report overclaims convergence");
  const declaredDossierCount = report.stats.declaredDossierCount ?? report.stats.selection?.selectedDossiers ?? report.topic?.sourceDossierCount;
  assert(declaredDossierCount === result.dossierCount, "aggregator dossier count mismatch");
  for (const step of report.extractedWorkflow.steps ?? []) {
    const supportCount = step.supportCount ?? step.iterationOrBoundedFollowUpSupportCount;
    assert(Number.isInteger(supportCount) && supportCount >= 1 && supportCount <= result.dossierCount, `workflow support count is out of bounds for ${step.name}`);
  }
  assert(handoff.schemaVersion === 1 && handoff.handoffType === "semantic-workflow-aggregation-handoff", "invalid aggregator handoff type");
  assert(handoff.status === "ready_for_verification" && handoff.dossierCount === result.dossierCount, "invalid aggregator handoff state");
  const handoffClaimsPending = JSON.stringify(handoff).toLowerCase();
  const normalizedHandoffClaims = handoffClaimsPending.replace(/[_-]+/g, " ");
  assert(handoff.convergence?.status === "not_converged" || (/not (?:validated|converged)/.test(normalizedHandoffClaims) && /backtest[^\n]{0,100}pending/.test(normalizedHandoffClaims)), "aggregator handoff does not preserve non-convergence");
  assert(Array.isArray(contract.sourceOfTruth) && contract.sourceOfTruth.every((source) => !source.endsWith(".jsonl")), "aggregator contract exposes raw session source");
  assert(fs.readFileSync(reportMarkdownPath, "utf8").includes("## Backtest plan"), "Markdown report lacks backtest section");
  const reportBytes = fs.readFileSync(reportJsonPath);
  const expectedCandidate = buildCandidateDefinition(report);
  assert(fs.readFileSync(candidateTrainPath, "utf8") === renderCandidateYaml(expectedCandidate), "candidate train is not the deterministic definition of the verified extraction report");
  assert(Object.keys(expectedCandidate).join(",") === "id,steps", "candidate train contains duplicated interface or non-workflow metadata");
  assert(!Object.prototype.hasOwnProperty.call(expectedCandidate, "repeat") && expectedCandidate.steps.improve?.repeat, "candidate repeat must belong to one car");
  assert(Object.entries(expectedCandidate.steps).every(([stepId, step]) => {
    const keys = Object.keys(step);
    const lean = keys.filter((key) => key !== "repeat").join(",") === "inputs,procedure,outputs";
    return lean && (!step.repeat || stepId === "improve");
  }), "candidate steps are not lean workflow definitions");

  const eventsPath = path.join(path.dirname(contractPath), "events.ndjson");
  const events = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const supervisorStart = events.find((event) => event.type === "supervisor_started");
  assert(supervisorStart?.payload?.args?.includes("--no-session"), `aggregator was not launched with --no-session: ${eventsPath}`);
  assert(eventTypes(events).includes("supervisor_finished"), `aggregator has no supervisor_finished event: ${eventsPath}`);
  return { reportJsonPath, reportMarkdownPath, candidateTrainPath, handoffPath, contractPath, eventsPath, eventCount: events.length };
}

function main() {
  const projectDir = path.resolve(process.argv[2] ?? ".");
  const resultPath = path.resolve(process.argv[3] ?? "latest-result.json");
  const result = readJson(resultPath);
  assert(result.status === "extracted_pending_backtest", `run status is not extracted_pending_backtest: ${result.status}`);
  assert(result.convergence?.status === "pending_backtest", "run does not preserve pending backtest");
  assert(result.dossierCount === result.dossierResults?.length && result.dossierCount > 0, "run dossier result count is invalid");
  const dossiers = result.dossierResults.map((dossierResult) => validateDossier({ projectDir, result, dossierResult }));
  const aggregator = validateAggregator({ projectDir, result });
  const output = { ok: true, runId: result.runId, attempt: result.attempt, dossierCount: result.dossierCount, dossiers, aggregator };
  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
