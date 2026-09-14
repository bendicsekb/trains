#!/usr/bin/env bash
set -euo pipefail

contract=/home/bendi/trains/.factory/runs/session-pattern-extraction-full-4-20260914/contract.json
runner=/home/bendi/trains/scripts/run-session-pattern-extraction-chain.mjs
node=/home/bendi/.nvm/versions/node/v22.22.0/bin/node
slot=$(date -u +%Y-%m-%dT%H:%M)
idempotency_key="trains-session-pattern-extraction:${slot}"

if [[ ! -f "$contract" ]]; then
  echo "missing full-run contract: $contract" >&2
  exit 1
fi

params=$(printf '%s' "{\"argv\":[\"$node\",\"$runner\",\"--contract\",\"$contract\",\"--stall-ms\",\"300000\",\"--stage-runtime-ms\",\"1800000\"],\"cwd\":\"/home/bendi/trains\",\"env\":{\"PI_CODING_AGENT_DIR\":\"/home/bendi/.pi/agent\"}}")

# The resident worker is not shell-enabled. --follow creates a scoped Minion
# worker for this scheduled run, while the Pi supervisor keeps the durable
# contract/events ledger in the trains repository.
exec env GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \
  --params "$params" \
  --follow \
  --timeout-ms 21600000 \
  --max-attempts 1 \
  --max-stalled 3 \
  --idempotency-key "$idempotency_key" \
  --redact-secrets
