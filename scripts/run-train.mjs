#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { runTrain } from "../src/trains-runner.mjs";

function value(argv, flag, fallback = undefined) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function usage() {
  console.error(`Usage:
  run-train.mjs --train <train.yaml> --input-json <inputs.json>
    [--run-dir <dir>] [--worker-command <command>]
    [--worker-arg <arg>] [--pi-cli <cli.js>]
    [--provider <provider>] [--model <model>] [--thinking <level>]
    [--stall-ms <ms>] [--max-runtime-ms <ms>] [--max-iterations <n>]`);
}

const argv = process.argv.slice(2);
const trainPath = value(argv, "--train");
if (!trainPath) {
  usage();
  process.exitCode = 2;
} else {
  try {
    const inputPath = value(argv, "--input-json");
    const inputs = inputPath ? JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) : {};
    const workerArgs = argv.flatMap((arg, index) => arg === "--worker-arg" && argv[index + 1] ? [argv[index + 1]] : []);
    const piCli = value(argv, "--pi-cli");
    const result = await runTrain({
      trainPath,
      inputs,
      runDir: value(argv, "--run-dir"),
      workerCommand: value(argv, "--worker-command", piCli ? process.execPath : "pi"),
      workerArgs: workerArgs.length > 0 ? workerArgs : undefined,
      piCli,
      provider: value(argv, "--provider"),
      model: value(argv, "--model"),
      thinking: value(argv, "--thinking"),
      stallMs: Number(value(argv, "--stall-ms", "120000")),
      maxRuntimeMs: Number(value(argv, "--max-runtime-ms", String(15 * 60 * 1000))),
      maxIterations: Number(value(argv, "--max-iterations", "8")),
    });
    console.log(JSON.stringify({ ok: true, status: result.state.status, resultStatus: "needs_verification", runDir: result.runDir, outputs: result.outputs }, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
