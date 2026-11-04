#!/usr/bin/env bash
# End-to-end smoke test in simulation: engine (SimFeed + PaperExecutor) and proof server on a scratch project.
# Usage: scripts/e2e-sim.sh [seconds]   (default 30). Requires `npm run build` first. No network needed.
set -euo pipefail
SECS="${1:-30}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E="${E2E_DIR:-/tmp/tenfold-e2e}"
rm -rf "$E2E" && mkdir -p "$E2E/projects" "$E2E/data"
export TENFOLD_PROJECTS_DIR="$E2E/projects" TENFOLD_DB_PATH="$E2E/data/tenfold.sqlite" TENFOLD_KEYSTORE_DIR="$E2E/data/keys"
export TENFOLD_KEYSTORE_PASSWORD="e2e-password-not-for-prod" TENFOLD_PROOF_PORT="${TENFOLD_PROOF_PORT:-8791}"
export TENFOLD_PROOF_SIGNING_SECRET="e2e-secret" TENFOLD_SIM=1 TENFOLD_LOG_LEVEL="${TENFOLD_LOG_LEVEL:-info}"
cd "$ROOT"
W=$(npm run -s wallet:new -- --label demo)
npm run -s project:add -- --id demo --name "Demo Token" --mint 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump --decimals 6 \
  --wallet "$W" --mode paper --cap 1 --budget 20 --budget-day 5 --delay 24 \
  --level 0.00019:8 --level 0.00017:8 --dist 0.6:strength --min-price 0.0001 --rebalance 0.3:0.1 --clip 0.1:0.6 >/dev/null
node --no-warnings apps/engine/dist/main.js >"$E2E/engine.log" 2>&1 &
ENGINE=$!
node --no-warnings apps/proof/dist/main.js >"$E2E/proof.log" 2>&1 &
PROOF=$!
trap 'kill $ENGINE $PROOF 2>/dev/null || true' EXIT
sleep "$SECS"
echo "--- proof API /api/project/demo"
curl -sf "localhost:$TENFOLD_PROOF_PORT/api/project/demo" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);
console.log("badge:",d.badge);console.log("today:",JSON.stringify(d.today));console.log("vault:",JSON.stringify(d.vault));
console.log("trades:",d.trades.length,d.trades.slice(0,10).map(t=>t.side+"/"+t.reason).join(" "));
console.log("volumeByReason30d:",JSON.stringify(d.volumeByReason30d));});'
echo "--- /verify"
curl -sf "localhost:$TENFOLD_PROOF_PORT/verify/9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump" | head -c 300; echo
echo "--- /p/demo"
curl -sf "localhost:$TENFOLD_PROOF_PORT/p/demo" | grep -o "<title>[^<]*</title>"
echo "--- events in ledger"
node --input-type=module -e '
import { Ledger } from "@tenfold/core";
const l = new Ledger(process.env.TENFOLD_DB_PATH);
const ev = l.listEvents("demo", { limit: 500 });
const by = {}; for (const e of ev) by[e.type] = (by[e.type] ?? 0) + 1;
console.log(JSON.stringify(by));
const fills = l.listFills("demo", { limit: 10000 });
console.log("fills:", fills.length, "sells:", fills.filter(f=>f.side==="sell").length, "buys:", fills.filter(f=>f.side==="buy").length);
const r = l.rollingState("demo"); console.log("soldLast24h:", r.soldLast24h.toString(), "defenseSpentTotal lamports:", r.defenseSpentTotalLamports.toString());
l.close();'
echo "--- engine log tail"
grep -c '"level":"error"' "$E2E/engine.log" | sed 's/^/error lines: /' || true
tail -5 "$E2E/engine.log"
