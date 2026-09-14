#!/usr/bin/env node

import path from "node:path";

import { loadContract, supervisePi } from "/home/bendi/pi-product-factory/src/supervisor.mjs";

function value(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1];
}

function usage() {
  console.error(`Usage:
  run-session-pattern-extraction.mjs --contract <contract.json>
    [--stall-ms 300000] [--max-runtime-ms 14400000]
    [--node <node>] [--pi-cli <cli.js>] [--agent-dir <dir>]
    [--provider openai-codex] [--model gpt-5.6-luna] [--thinking xhigh]`);
}

const argv = process.argv.slice(2);
const contractPath = value(argv, "--contract");
if (!contractPath) {
  usage();
  process.exitCode = 2;
} else {
  const contract = loadContract(path.resolve(contractPath));
  const node = value(argv, "--node", "/home/bendi/.nvm/versions/node/v22.22.0/bin/node");
  const piCli = value(argv, "--pi-cli", "/home/bendi/.npm/_npx/a54d9a87e5358117/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const agentDir = value(argv, "--agent-dir", "/home/bendi/.pi/agent");
  const extension = "/home/bendi/pi-product-factory/extensions/factory.js";
  const args = [
    piCli,
    "--mode", "rpc",
    "--no-session",
    "--provider", value(argv, "--provider", "openai-codex"),
    "--model", value(argv, "--model", "gpt-5.6-luna"),
    "--thinking", value(argv, "--thinking", "xhigh"),
    "--extension", extension,
  ];

  const result = await supervisePi({
    contract,
    contractPath: path.resolve(contractPath),
    command: node,
    args,
    cwd: contract.projectDir,
    env: { PI_CODING_AGENT_DIR: agentDir },
    stallMs: Number(value(argv, "--stall-ms", "300000")),
    maxRuntimeMs: Number(value(argv, "--max-runtime-ms", "14400000")),
  });

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "escalated" ? 1 : 0;
}
