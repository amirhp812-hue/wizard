// Everything that talks to GenLayer Studio Dev (chain ID 61997, RPC https://studio-dev.genlayer.com/api):
// test accounts, funding, deploying WizardOfCoin + WizardAttacker, and the two transactions the loop needs:
//   forge_attack  (WizardAttacker)  -> a validator node's LLM writes the next attack
//   ask_for_coin  (WizardOfCoin)    -> the wizard's validators decide give_coin
//
// Studio Dev is a fee-charging Consensus v0.6 deployment: every deploy/write sends fees { distribution, feeValue }
// estimated by the SDK, paid from the test account's GEN balance. It needs the genlayer-js 2.x release candidate
// (it ships the `studioDevnet` preset). Test keys and deployed addresses live in .wizard-state.json (git-ignored).

import fs from "node:fs";
import readline from "node:readline/promises";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

export const CHAIN_ID = 61997;
export const DEFAULT_RPC = "https://studio-dev.genlayer.com/api";
export const EXPLORER = "https://explorer-studio-dev.genlayer.com";
export const STATE_FILE = ".wizard-state.json";

export class SetupError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export const errMsg = (e) => oneLine(e?.shortMessage || e?.message || e);
export const toObj = (v) => (v instanceof Map ? Object.fromEntries(v) : v && typeof v === "object" ? v : {});
const safeJson = (v, n = 1500) => clip(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) ?? "", n);

// ------------------------------------------------------------------------------------------- pure helpers

/** The text the wizard's model really receives (mirrors WizardOfCoin.ask_for_coin), used as the attacker's "white-box" view. */
export function wizardPromptText(code, guard) {
  const grab = (name) => code.match(new RegExp(`^${name} = """([\\s\\S]*?)"""`, "m"))?.[1] ?? "";
  const style = grab("STYLE");
  const format = grab("FORMAT");
  if (!style || !format) return null;
  return (
    style +
    (guard ? "\nADDITIONAL WIZARD RULES:\n" + guard + "\n" : "") +
    '\nADVENTURER MESSAGE START\n"<the attacker\'s message, JSON-encoded as one string>"\nADVENTURER MESSAGE END\n' +
    format
  );
}

function findString(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  if (typeof obj[key] === "string" && obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findString(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

/** "provider/model" from a validator's node_config, wherever the node keeps it. */
export function nodeName(cfg) {
  const model = findString(cfg, "model");
  if (!model) return null;
  const provider = findString(cfg, "provider");
  return provider ? `${provider}/${model}` : model;
}

/** Which LLMs were involved and whether the validators disagreed, read defensively from a transaction receipt. */
export function receiptInfo(receipt) {
  const cd = receipt?.consensus_data;
  const leaderModel = nodeName(cd?.leader_receipt?.[0]?.node_config);
  const validatorModels = [
    ...new Set((Array.isArray(cd?.validators) ? cd.validators : []).map((v) => nodeName(v?.node_config)).filter(Boolean)),
  ];
  const votes = [
    ...Object.values(cd?.votes && typeof cd.votes === "object" ? cd.votes : {}),
    ...(Array.isArray(receipt?.lastRound?.validatorVotesName) ? receipt.lastRound.validatorVotesName : []),
  ].map(String);
  const consensusRounds = Number(receipt?.numOfRounds) || 1;
  const badResult = ["DISAGREE", "NO_MAJORITY", "MAJORITY_DISAGREE"].includes(String(receipt?.resultName));
  const contested = consensusRounds > 1 || badResult || votes.some((v) => /NONDET_DISAGREE/i.test(v));
  return { leaderModel, validatorModels, consensusRounds, contested };
}

// ----------------------------------------------------------------------------------------------- connect

/**
 * opt: rpc, address, attacker, contract, "attacker-contract", runner, "guard-file", deploy, "deploy-attacker", fresh,
 *      concurrency, fund, "fund-amount", "leader-tu", "validator-tu", rotations, retries, interval
 * needAttacker: false for --replay (the wizard is attacked with fixed messages, no attacker contract needed)
 */
export async function connect(opt, { needAttacker = true, log = console.log, warn = console.warn } = {}) {
  const CONCURRENCY = Math.max(1, parseInt(opt.concurrency, 10) || 1);
  const RETRIES = parseInt(opt.retries, 10) || 120;
  const INTERVAL = parseInt(opt.interval, 10) || 3000;
  const LEADER_TU = BigInt(opt["leader-tu"]);
  const VALIDATOR_TU = BigInt(opt["validator-tu"]);
  const ROTATIONS = String(opt.rotations).split(",").map((s) => BigInt(s.trim()));

  if (!chains.studioDevnet) {
    throw new SetupError(
      "genlayer-js/chains has no `studioDevnet` preset. Studio Dev needs the 2.x release candidate:\n" +
        "  npm install genlayer-js@^2.0.0-rc.1",
    );
  }
  // Same override pattern the Studio Dev reports use: the id/name/RPC are pinned explicitly.
  const chain = {
    ...chains.studioDevnet,
    id: CHAIN_ID,
    name: "GenLayer Studio Dev",
    rpcUrls: { default: { http: [opt.rpc] } },
  };
  try {
    const res = await fetch(opt.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const id = parseInt((await res.json()).result, 16);
    if (id !== CHAIN_ID) throw new SetupError(`RPC ${opt.rpc} reports chain ID ${id}, expected ${CHAIN_ID} (Studio Dev).`);
    log(`RPC ok: ${opt.rpc} (chain ID ${id})`);
  } catch (e) {
    if (e instanceof SetupError) throw e;
    throw new SetupError(`Cannot reach ${opt.rpc}: ${errMsg(e)}${e?.cause?.code ? ` (${e.cause.code})` : ""}`);
  }

  const makeClient = (account) => createClient({ chain, account, endpoint: opt.rpc });

  // ---- state: test accounts + deployed addresses
  let state = {};
  if (!opt.fresh) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { state = {}; }
  }
  if (state.chainId !== CHAIN_ID) state = {};
  state.chainId = CHAIN_ID;
  state.keys = state.keys ?? [];
  while (state.keys.length < CONCURRENCY) state.keys.push(generatePrivateKey());
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  saveState();

  const accounts = state.keys.slice(0, CONCURRENCY).map((k) => createAccount(k));
  if (process.env.PRIVATE_KEY) accounts[0] = createAccount(process.env.PRIVATE_KEY); // use your own owner key
  const clients = accounts.map(makeClient);
  for (const c of clients) {
    try { if (typeof c.initializeConsensusSmartContract === "function") await c.initializeConsensusSmartContract(); }
    catch (e) { warn(`initializeConsensusSmartContract: ${errMsg(e)}`); }
  }

  // ---- tx helpers
  let cachedFees = null;
  const feesFor = async (client) => {
    if (cachedFees) return cachedFees;
    const est = await client.estimateTransactionFees({
      leaderTimeunitsAllocation: LEADER_TU,
      validatorTimeunitsAllocation: VALIDATOR_TU,
      rotations: ROTATIONS,
    });
    cachedFees = { distribution: est.distribution, feeValue: est.feeValue };
    return cachedFees;
  };
  const waitAccepted = (client, hash) =>
    client.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: RETRIES, interval: INTERVAL });
  const execFailed = (receipt) => receipt?.txExecutionResultName === "FINISHED_WITH_ERROR";
  const readAt = (client, address, functionName, args = []) =>
    client.readContract({ address, functionName, args, stateStatus: "accepted" });
  const statusOf = async (client, hash) => {
    try {
      const tx = await client.getTransaction({ hash });
      return String(tx?.statusName ?? tx?.status ?? "");
    } catch { return ""; }
  };

  // ---- funding (fees are paid in GEN)
  const balanceOf = async (i) => {
    try {
      if (typeof clients[i].getBalance === "function") return BigInt(await clients[i].getBalance({ address: accounts[i].address }));
    } catch { /* balance lookup is optional */ }
    return null;
  };

  async function fundAccounts() {
    const amount = parseInt(opt["fund-amount"], 10) || 1000;
    log(`\nTest account(s) on Studio Dev (chain ${CHAIN_ID}):`);
    const pending = [];
    let unknown = false;
    for (let i = 0; i < accounts.length; i++) {
      let note = "";
      if (opt.fund === "auto") {
        try {
          await clients[i].fundAccount({ address: accounts[i].address, amount });
          note = `faucet RPC: +${amount}; `;
        } catch (e) {
          note = `faucet RPC unavailable (${clip(errMsg(e), 70)}); `;
        }
      }
      const bal = await balanceOf(i);
      if (bal === null) unknown = true;
      else if (bal === 0n) pending.push(i);
      log(`  #${i} ${accounts[i].address}  ${note}balance=${bal === null ? "unknown" : bal}`);
    }

    if (pending.length) {
      log(
        "\nThese account(s) have 0 GEN and cannot pay transaction fees. Send test GEN on Studio Dev to them,\n" +
          "using the faucet in the Studio Dev web app (https://studio-dev.genlayer.com) or a transfer from\n" +
          "your wallet on the 'GenLayer Studio Dev' network (chain ID 61997).\nWaiting for the balance (Ctrl+C to abort)…",
      );
      const deadline = Date.now() + 20 * 60_000;
      while (pending.length && Date.now() < deadline) {
        await sleep(5000);
        for (const i of [...pending]) {
          const b = await balanceOf(i);
          if (b !== null && b > 0n) {
            log(`  #${i} funded: balance=${b}`);
            pending.splice(pending.indexOf(i), 1);
          }
        }
      }
      if (pending.length) throw new SetupError("Timed out waiting for funds.");
    } else if (opt.fund === "manual" && unknown) {
      log("\nCould not read balances. Send test GEN to the address(es) above, then press Enter.");
      if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await rl.question("");
        rl.close();
      }
    }
    log("");
  }
  if (opt.fund !== "none") await fundAccounts();

  // ---- deploy / locate the two contracts
  const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
  const sameAddr = (a, b) => String(a).toLowerCase().replace(/^0x/, "").endsWith(String(b).toLowerCase().replace(/^0x/, ""));
  const contractOwner = async (client, addr) => {
    try { return String(await readAt(client, addr, "get_owner")); } catch { return null; }
  };
  const isAttacker = async (client, addr) => {
    try { return toObj(await readAt(client, addr, "get_info")).name === "WizardAttacker"; } catch { return false; }
  };

  async function deployFrom({ label, file, args, probe }) {
    let code = fs.readFileSync(file, "utf8");
    if (opt.runner) code = code.replace(/py-genlayer:[A-Za-z0-9._-]+/, `py-genlayer:${opt.runner.replace(/^py-genlayer:/, "")}`);
    log(`Deploying ${label} (${file}) from ${accounts[0].address}…`);
    const fees = await feesFor(clients[0]);
    const hash = await clients[0].deployContract({ account: accounts[0], code, args, leaderOnly: false, fees });
    const receipt = await waitAccepted(clients[0], hash);
    if (execFailed(receipt)) throw new Error(`${label} deployment finished with an execution error; check tx ${hash} in the explorer`);

    const candidates = [
      receipt?.data?.contract_address, receipt?.txDataDecoded?.contractAddress, receipt?.contractAddress,
      receipt?.recipient, receipt?.to_address, receipt?.toAddress,
    ];
    try {
      const tx = await clients[0].getTransaction({ hash });
      candidates.push(tx?.data?.contract_address, tx?.contractAddress, tx?.recipient, tx?.to_address, tx?.toAddress);
    } catch { /* fallback only */ }
    for (const cand of [...new Set(candidates.filter((c) => typeof c === "string" && ADDR_RE.test(c)))]) {
      if (await probe(cand)) return cand;
    }
    throw new Error(
      `could not determine the ${label} address from the receipt. Receipt:\n${safeJson(receipt)}\nFind the address in the explorer, then rerun with ${label === "WizardOfCoin" ? "--address" : "--attacker"} 0x...`,
    );
  }

  async function ensure({ label, given, saved, force, probe, deploy, save }) {
    let address = given || null;
    let fromState = false;
    if (!address && !force && saved) { address = saved; fromState = true; }
    if (address && !(await probe(address))) {
      if (fromState) {
        log(`Saved ${label} ${address} not found (Studio Dev can be reset); deploying a new one.`);
        address = null;
      } else {
        throw new SetupError(`No ${label} answered at ${address} on Studio Dev.`);
      }
    }
    let deployed = false;
    if (!address) {
      try {
        address = await deploy();
      } catch (e) {
        const m = errMsg(e);
        let hint = "";
        if (/runner|invalid_contract|malformed|absent/i.test(m))
          hint += "\nHint: the py-genlayer runner hash in the contract header may not exist on Studio Dev's current runtime.\n" +
            "Take the hash from Studio Dev's own hello-world example and pass it: --runner <hash>";
        if (/fee|insufficient|balance|funds/i.test(m))
          hint += `\nHint: fund ${accounts[0].address} with GEN (faucet in the Studio Dev app), then rerun.`;
        throw new SetupError(`Deploy of ${label} failed: ${m}${hint}`);
      }
      deployed = true;
      log(`Deployed ${label} at ${address}`);
    }
    save(address);
    saveState();
    return { address, deployed };
  }

  const wiz = await ensure({
    label: "WizardOfCoin",
    given: opt.address,
    saved: state.address,
    force: opt.deploy,
    probe: async (addr) => Boolean(await contractOwner(clients[0], addr)),
    deploy: async () => {
      const guard = fs.readFileSync(opt["guard-file"] || "guard.txt", "utf8").trim();
      return deployFrom({
        label: "WizardOfCoin",
        file: opt.contract,
        args: [guard],
        probe: async (cand) => {
          const o = await contractOwner(clients[0], cand);
          return Boolean(o && sameAddr(o, accounts[0].address));
        },
      });
    },
    save: (a) => { state.address = a; },
  });
  const WIZARD = wiz.address;
  log(`Explorer: ${EXPLORER}/address/${WIZARD}`);

  // set_guard on an existing wizard (owner only: deployed by us in an earlier run, or PRIVATE_KEY)
  if (opt["guard-file"] && !wiz.deployed) {
    const guard = fs.readFileSync(opt["guard-file"], "utf8").trim();
    log(`Setting guard from ${opt["guard-file"]} (${guard.length} chars)…`);
    const fees = await feesFor(clients[0]);
    const hash = await clients[0].writeContract({ address: WIZARD, functionName: "set_guard", args: [guard], value: 0n, fees });
    const receipt = await waitAccepted(clients[0], hash);
    if (execFailed(receipt)) throw new SetupError("set_guard failed (account #0 must be the owner; guard <= 4000 chars).");
  }
  let guardOnChain = "";
  try {
    guardOnChain = String(await readAt(clients[0], WIZARD, "get_guard"));
    log(`Guard on chain: ${guardOnChain.length} chars`);
  } catch (e) {
    warn(`get_guard failed: ${errMsg(e)}`);
  }

  let ATTACKER = null;
  if (needAttacker) {
    const att = await ensure({
      label: "WizardAttacker",
      given: opt.attacker,
      saved: state.attacker,
      force: opt["deploy-attacker"],
      probe: (addr) => isAttacker(clients[0], addr),
      deploy: () =>
        deployFrom({ label: "WizardAttacker", file: opt["attacker-contract"], args: [], probe: (cand) => isAttacker(clients[0], cand) }),
      save: (a) => { state.attacker = a; },
    });
    ATTACKER = att.address;
    log(`Attacker: ${EXPLORER}/address/${ATTACKER}`);
  }
  log("");

  // ---- the backend the loop talks to
  const backend = {
    workers: CONCURRENCY,

    // A model inside a validator node writes the next attack.
    async forge(w, { forgeId, brief }) {
      const client = clients[w];
      const fees = await feesFor(client);
      const hash = await client.writeContract({ address: ATTACKER, functionName: "forge_attack", args: [forgeId, brief], value: 0n, fees });
      const receipt = await waitAccepted(client, hash);
      if (execFailed(receipt)) throw new Error("forge_attack finished with an execution error (see tx " + hash + " in the explorer)");
      const res = toObj(await readAt(client, ATTACKER, "get_attack", [accounts[w].address, forgeId]));
      const attack = String(res.attack ?? "");
      if (!attack) throw new Error("no attack stored (consensus not accepted / rolled back)");
      return {
        attack,
        analysis: String(res.analysis ?? ""),
        progress: Number(res.progress ?? 0) || 0,
        meta: { txHash: hash, ...receiptInfo(receipt) },
      };
    },

    // The wizard's validators decide. Never throws: a consensus failure is a finding, not a crash.
    async ask(w, { attemptId, text }) {
      const client = clients[w];
      let hash = null;
      try {
        const fees = await feesFor(client);
        hash = await client.writeContract({ address: WIZARD, functionName: "ask_for_coin", args: [attemptId, text], value: 0n, fees });
        let receipt;
        try {
          receipt = await waitAccepted(client, hash);
        } catch (e) {
          // a tx whose validators never agree never reaches ACCEPTED: ask the chain how it ended
          const st = await statusOf(client, hash);
          if (/UNDETERMINED|TIMEOUT|CANCELED/i.test(st))
            return { outcome: "", reply: "", kind: "no-verdict", error: `consensus ended as ${st}`, meta: { txHash: hash } };
          throw e;
        }
        const meta = { txHash: hash, ...receiptInfo(receipt) };
        if (execFailed(receipt))
          return { outcome: "", reply: "", kind: "no-verdict", error: "contract execution error (e.g. invalid consensus verdict)", meta };
        const res = toObj(await readAt(client, WIZARD, "get_result", [accounts[w].address, attemptId]));
        const outcome = String(res.outcome ?? "");
        if (!outcome)
          return { outcome: "", reply: "", kind: "no-verdict", error: "no result stored (consensus not accepted / rolled back)", meta };
        return { outcome, reply: String(res.reply ?? ""), kind: "", error: "", meta };
      } catch (e) {
        return { outcome: "", reply: "", kind: "infra", error: errMsg(e), meta: { txHash: hash } };
      }
    },
  };

  return {
    backend,
    wizard: WIZARD,
    attacker: ATTACKER,
    guard: guardOnChain,
    accounts,
    chainName: `Studio Dev, chain ${CHAIN_ID}`,
  };
}
