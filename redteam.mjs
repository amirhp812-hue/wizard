#!/usr/bin/env node
// Red-team the WizardOfCoin intelligent contract with the LLMs that run inside GenLayer Studio Dev's validator nodes.
//
//   node redteam.mjs                      # fund test accounts, deploy wizard + attacker, run the attack sessions, report
//   node redteam.mjs --sessions all --rounds 6 --concurrency 4
//   node redteam.mjs --replay breaches-<time>.json     # re-fire earlier winning messages (e.g. after editing guard.txt)
//   node redteam.mjs --help
//
// How it works: WizardAttacker.forge_attack() makes the current leader node's LLM write ONE message, from an angle
// (tactics.mjs), optionally the wizard's own rules, and what the wizard answered to the earlier tries. This script
// sends that message to WizardOfCoin.ask_for_coin(), reads the wizard's reply and the verdict, hands both back to the
// attacker for the next round, and records everything. A round that makes the wizard give the coin is a BREACH.

import { parseArgs } from "node:util";
import fs from "node:fs";
import { TACTICS, selectTactics } from "./tactics.mjs";
import { makeSessions, runArena, runReplay, buildReport, breachFile } from "./arena.mjs";
import { connect, wizardPromptText, SetupError, DEFAULT_RPC } from "./chain.mjs";

// Turn a prior report-*.json or breaches-*.json into { [tacticId]: string[] }, so a new run can push harder
// on exactly the tactics that came closest instead of starting cold again. report-*.json keeps only rounds
// that breached or whose closeness (the attacker's own 0-10 self-rating) met the threshold, best first;
// breaches-*.json (no closeness field) keeps every breach. Both are the exact files this script already writes.
function loadSeeds(file, minCloseness, perTactic) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new SetupError(`--seed-from ${file}: ${e.message}`);
  }
  const out = {};
  const add = (tactic, text) => {
    if (!tactic || typeof text !== "string" || !text.trim()) return;
    const arr = (out[tactic] ??= []);
    if (arr.length < perTactic && !arr.includes(text)) arr.push(text);
  };
  if (Array.isArray(raw)) {
    for (const r of raw) add(r?.tactic, r?.text); // breaches-*.json
  } else if (raw && Array.isArray(raw.rounds)) {
    const picked = raw.rounds // report-*.json
      .filter((r) => r?.type === "round" && r.attack && (r.verdict === "BREACH" || (r.closeness ?? -1) >= minCloseness))
      .sort((a, b) => (b.verdict === "BREACH") - (a.verdict === "BREACH") || (b.closeness ?? 10) - (a.closeness ?? 10));
    for (const r of picked) add(r.tactic, r.attack);
  } else {
    throw new SetupError(`${file} is not a report-*.json or breaches-*.json produced by this script.`);
  }
  return out;
}

// Turn a report-*.json's evolutions (see arena.mjs's buildReport, filled by wizard_attacker.py's
// evolved_angle) into { [tacticId]: angle }, keeping only the LAST — most-compounded — proposal per
// tactic. Also accepts an evolved-angles-*.json this script already writes, which is already in that shape.
function loadEvolved(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new SetupError(`--evolve-from ${file}: ${e.message}`);
  }
  if (raw && Array.isArray(raw.evolutions)) {
    const out = {};
    for (const e of raw.evolutions) if (e?.tactic && typeof e.angle === "string" && e.angle.trim()) out[e.tactic] = e.angle;
    return out; // report-*.json: array is in round order, so the last write per tactic is the latest
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw; // evolved-angles-*.json
  throw new SetupError(`${file} has no "evolutions" array and isn't an evolved-angles-*.json produced by this script.`);
}

const HELP = `Usage: node redteam.mjs [options]

Attack
  --sessions <n|all>      parallel attack lines, each with its own angle        (default 8)
  --rounds <n>            rounds per session; the attacker sees earlier replies  (default 5)
  --tactics <ids|all>     comma-separated angle ids or prefixes                  (default all, in order)
  --list-tactics          print the angle ids and exit
  --knowledge rules|blind rules = the attacker reads the wizard's full prompt and guard (hardest test)
                          blind = it only sees the wizard's replies              (default rules)
  --window <n>            earlier rounds shown to the attacker                   (default 4)
  --seed-from <file>      report-*.json or breaches-*.json from an earlier run: push harder on
                          whatever tactic came closest there, by feeding its real near-miss
                          message(s) as round-1 inspiration (never resent verbatim)
  --seed-min-closeness <n> report-*.json rounds need this attacker-rated closeness to seed (default 6)
  --seed-per-tactic <n>   max seed messages kept per tactic                       (default 2)
  --evolve-from <file>    report-*.json or evolved-angles-*.json: start a tactic from the attacker's own
                          improved angle (see "Tactic evolutions" in the report) instead of tactics.mjs's,
                          for every tactic that evolved. Every run already does this live, within its own
                          sessions, with no flag needed (the attacker rewrites its own angle mid-session
                          whenever it judges real hesitation); this flag carries that improvement into a
                          brand NEW run instead of starting the tactic cold again.
  --keep-going            continue a session after it wins (default: it stops)
  --stop-all              stop every session after the first breach
  --forge-retries <n>     re-ask when the attacker model refuses or fails        (default 3)
  --replay <file.json>    fire fixed messages [{id,text}] at the wizard instead of running the attacker
  --no-nonce              replay: send the text unchanged (a message that already won is burned)
  --resume <file.jsonl>   continue an interrupted run from its results log
  --fail-on-breach        exit with code 2 if the wizard gave the coin

Chain
  --concurrency <n>       funded accounts working in parallel                    (default 2)
  --address 0x...         attack an already deployed WizardOfCoin   (env CONTRACT_ADDRESS)
  --attacker 0x...        use an already deployed WizardAttacker    (env ATTACKER_ADDRESS)
  --deploy                deploy a fresh WizardOfCoin (e.g. after editing wizard_of_coin.py)
  --deploy-attacker       deploy a fresh WizardAttacker
  --guard-file <file>     deploy with this guard / set_guard on an existing wizard (default guard.txt on deploy)
  --contract <file>       wizard source                                          (default ./wizard_of_coin.py)
  --attacker-contract <f> attacker source                                        (default ./wizard_attacker.py)
  --runner <hash>         replace the py-genlayer runner hash in both contract headers
  --fund auto|manual|none faucet RPC, wait for you to send GEN, or skip          (default auto)
  --fund-amount <n>       GEN requested from the faucet RPC                      (default 1000)
  --leader-tu <n> --validator-tu <n> --rotations 0,0   fee estimate knobs        (default 100 / 200 / 0)
  --fresh                 ignore saved keys and addresses
  --rpc <url>             (env RPC_URL)                                          (default ${DEFAULT_RPC})
  --retries <n> --interval <ms>   receipt polling                                (default 120 / 3000)

Env: RPC_URL, CONTRACT_ADDRESS, ATTACKER_ADDRESS, PRIVATE_KEY (owner key for account #0)
`;

let opt;
try {
  ({ values: opt } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      address: { type: "string", default: process.env.CONTRACT_ADDRESS },
      attacker: { type: "string", default: process.env.ATTACKER_ADDRESS },
      rpc: { type: "string", default: process.env.RPC_URL || DEFAULT_RPC },
      sessions: { type: "string", default: "8" },
      rounds: { type: "string", default: "5" },
      window: { type: "string", default: "4" },
      "seed-from": { type: "string" },
      "seed-min-closeness": { type: "string", default: "6" },
      "seed-per-tactic": { type: "string", default: "2" },
      "evolve-from": { type: "string" },
      tactics: { type: "string" },
      "list-tactics": { type: "boolean", default: false },
      knowledge: { type: "string", default: "rules" },
      "keep-going": { type: "boolean", default: false },
      "stop-all": { type: "boolean", default: false },
      "forge-retries": { type: "string", default: "3" },
      replay: { type: "string" },
      "no-nonce": { type: "boolean", default: false },
      resume: { type: "string" },
      "fail-on-breach": { type: "boolean", default: false },
      concurrency: { type: "string", default: "2" },
      deploy: { type: "boolean", default: false },
      "deploy-attacker": { type: "boolean", default: false },
      contract: { type: "string", default: "./wizard_of_coin.py" },
      "attacker-contract": { type: "string", default: "./wizard_attacker.py" },
      runner: { type: "string" },
      "guard-file": { type: "string" },
      fund: { type: "string", default: "auto" },
      "fund-amount": { type: "string", default: "1000" },
      "leader-tu": { type: "string", default: "100" },
      "validator-tu": { type: "string", default: "200" },
      rotations: { type: "string", default: "0" },
      fresh: { type: "boolean", default: false },
      retries: { type: "string", default: "120" },
      interval: { type: "string", default: "3000" },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(1);
}

if (opt.help) {
  console.log(HELP);
  process.exit(0);
}
if (opt["list-tactics"]) {
  for (const t of TACTICS) console.log(`${t.id.padEnd(22)} ${t.angle ? t.angle.slice(0, 110) + "…" : "(no suggested angle: the model invents its own)"}`);
  process.exit(0);
}
if (!["rules", "blind"].includes(opt.knowledge)) {
  console.error(`--knowledge must be "rules" or "blind"\n`);
  process.exit(1);
}

const int = (v, d) => Math.max(1, parseInt(v, 10) || d);
const ROUNDS = int(opt.rounds, 5);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG = opt.resume || `results-${stamp}.jsonl`; // one JSON line per finished round (crash-safe)
const log = (m) => console.log(m);

try {
  let tactics;
  try { tactics = selectTactics(opt.tactics); } catch (e) { throw new SetupError(e.message); }
  if (opt["evolve-from"]) {
    const evolved = loadEvolved(opt["evolve-from"]);
    const applied = [];
    tactics = tactics.map((t) => {
      if (!evolved[t.id]) return t;
      applied.push(t.id);
      return { ...t, angle: evolved[t.id] };
    });
    log(
      applied.length
        ? `Starting ${applied.length} tactic(s) from their evolved angle (${opt["evolve-from"]}): ${applied.join(", ")}.\n`
        : `--evolve-from ${opt["evolve-from"]} had nothing matching the tactics in this run.\n`,
    );
  }
  const sessionCount = opt.sessions === "all" ? tactics.length : int(opt.sessions, 8);

  const conn = await connect(opt, { needAttacker: !opt.replay, log, warn: console.warn });
  const onRecord = (rec) => fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");

  let outcome;
  if (opt.replay) {
    const items = JSON.parse(fs.readFileSync(opt.replay, "utf8"));
    if (!Array.isArray(items) || !items.every((x) => x && typeof x.text === "string"))
      throw new SetupError(`${opt.replay} must be a JSON array of {id, text} objects`);
    log(`Replaying ${items.length} message(s) at ${conn.wizard}; log: ${LOG}\n`);
    outcome = await runReplay({ backend: conn.backend, items, nonce: !opt["no-nonce"], onRecord, log });
  } else {
    let wizardRules = "";
    if (opt.knowledge === "rules") {
      wizardRules = wizardPromptText(fs.readFileSync(opt.contract, "utf8"), conn.guard) ?? "";
      if (!wizardRules) console.warn(`! could not read STYLE/FORMAT out of ${opt.contract}; the attacker will play blind.`);
    }
    let seeds;
    if (opt["seed-from"]) {
      seeds = loadSeeds(opt["seed-from"], int(opt["seed-min-closeness"], 6), int(opt["seed-per-tactic"], 2));
      const n = Object.values(seeds).reduce((sum, a) => sum + a.length, 0);
      log(`Seeded ${n} message(s) from ${opt["seed-from"]} across ${Object.keys(seeds).length} tactic(s).\n`);
    }
    const sessions = makeSessions(tactics, sessionCount, seeds);
    let resume = [];
    if (opt.resume) {
      for (const line of fs.readFileSync(opt.resume, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { resume.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
      }
    }
    log(
      `${sessions.length} session(s) x ${ROUNDS} round(s) = up to ${sessions.length * ROUNDS} wizard attempts ` +
        `(2 transactions each), ${conn.backend.workers} worker(s), attacker knowledge: ${opt.knowledge}; log: ${LOG}\n`,
    );
    outcome = await runArena({
      backend: conn.backend,
      sessions,
      rounds: ROUNDS,
      window: int(opt.window, 4),
      wizardRules,
      maxChars: 900,
      forgeRetries: int(opt["forge-retries"], 3),
      keepGoing: opt["keep-going"],
      stopAll: opt["stop-all"],
      resume,
      onRecord,
      log,
    });
  }

  const { md, data } = buildReport(outcome.records, {
    wizard: conn.wizard,
    attacker: conn.attacker,
    chain: conn.chainName,
    knowledge: opt.replay ? "replay (fixed messages)" : opt.knowledge,
    ended: outcome.ended,
  });
  fs.writeFileSync(`report-${stamp}.md`, md);
  fs.writeFileSync(`report-${stamp}.json`, JSON.stringify(data, null, 2));
  const won = breachFile(outcome.records);
  if (won.length) fs.writeFileSync(`breaches-${stamp}.json`, JSON.stringify(won, null, 2));

  // Keep only the LAST (most-compounded) evolved angle per tactic, as a small file --evolve-from can
  // point at directly without re-parsing a whole report.
  let evolvedFile = "";
  if (data.evolutions?.length) {
    const latest = {};
    for (const e of data.evolutions) latest[e.tactic] = e.angle; // data.evolutions is already in round order
    evolvedFile = `evolved-angles-${stamp}.json`;
    fs.writeFileSync(evolvedFile, JSON.stringify(latest, null, 2));
  }

  console.log("\n" + md);
  console.log(
    `\nSaved report-${stamp}.md, report-${stamp}.json` +
      `${won.length ? `, breaches-${stamp}.json (replay with --replay)` : ""}` +
      `${evolvedFile ? `, ${evolvedFile} (next run: --evolve-from ${evolvedFile})` : ""}`,
  );
  if (data.totals.rounds && (data.totals.errors + data.totals.forgeFailed) / data.totals.rounds > 0.5) {
    console.log("\nMost rounds failed technically. Check balances (fees are paid in GEN); test account(s):");
    for (const a of conn.accounts) console.log(`  ${a.address}`);
    console.log("If the error says out of budget/time units, raise --leader-tu / --validator-tu (e.g. 300 / 600).");
  }
  if (opt["fail-on-breach"] && won.length) process.exit(2);
} catch (e) {
  if (e instanceof SetupError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
