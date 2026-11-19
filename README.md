# Wizard red-team: the validators' own LLMs attack the contract

Target: **GenLayer Studio Dev**, RPC `https://studio-dev.genlayer.com/api`, chain ID `61997`, currency GEN.
Uses the `studioDevnet` preset of the genlayer-js 2.x release candidate (NOT `studionet`, chain 61999).
Every deploy/write sends SDK-estimated fees paid in GEN from the test accounts.

## Why this exists

A fixed list of prompts (the old corpus of 310) is something the wizard's guard can simply be tuned against, and a
fixed prompt never sees the wizard's answer. Here the attacker is a language model that runs **inside the Studio Dev
validator nodes**, reads what the wizard replied, and writes a different attack each round.

```
            redteam.mjs (this script, the courier)
              |                         |
   1. forge_attack(brief)       3. ask_for_coin(message)
              v                         v
      WizardAttacker  ---- message ---> WizardOfCoin
   (leader node's LLM writes it)     (validators' LLMs decide give_coin)
              ^                         |
              +---- 4. reply + verdict -+   (fed into the next brief)
```

* `wizard_of_coin.py`: the contract under test (unchanged).
* `wizard_attacker.py`: new contract. `forge_attack(attack_id, brief)` makes the current leader node's LLM write ONE
  message from an angle, the wizard's own prompt (optional) and the earlier tries of that session. Validators only check
  that the result is well formed, so each attack is authored by whichever validator model led that transaction: different
  rounds, different models.
* `tactics.mjs`: 18 short attack *angles* (not prompts) that replace the old corpus. They carry what the old prompts
  taught: the scene-as-data pattern that beat the unguarded wizard, fake authority, output-field hijacks, delimiter
  spoofing, forged history, third-party recipients, languages, consensus splitting, and a `free-form` angle.
* `arena.mjs`: the loop (sessions x rounds) and the report. `chain.mjs`: all GenLayer I/O.
* A **breach** is a round where the wizard's stored outcome is `given`. A **no verdict** is a round where the wizard's
  validators could not agree and nothing was stored; a player gets no coin from it, but it is a real fault.
  A round is **contested** when validators disagreed or the leader rotated, which marks messages that sit close to the line.

## Run it (GitHub Codespaces or any machine with Node >= 18.3)

```bash
npm install
npm test                      # offline self-test of the loop and report, no GEN needed
node redteam.mjs              # fund test accounts, deploy wizard + attacker, 8 sessions x 5 rounds, report
```

Useful variations:

```bash
node redteam.mjs --sessions all --rounds 6 --concurrency 4   # every angle once, 4 funded accounts in parallel
node redteam.mjs --tactics scene-as-data,format-hijack --sessions 6 --rounds 8
node redteam.mjs --knowledge blind                           # attacker sees only the wizard's replies
node redteam.mjs --keep-going                                # do not stop a session after it wins
node redteam.mjs --guard-file guard.txt                      # set_guard (owner), then attack
node redteam.mjs --resume results-<time>.jsonl               # continue an interrupted run
node redteam.mjs --replay breaches-<time>.json               # re-fire winning messages after changing the guard
node redteam.mjs --help                                      # everything else
```

Long runs: a round is two LLM-consensus transactions, so expect it to take a while. Start it detached and follow it:

```bash
nohup node redteam.mjs --sessions all --rounds 6 --concurrency 4 > run.log 2>&1 &
tail -f run.log
```

## Output

* console + `report-<time>.md` / `.json`: breaches (full message, wizard reply, models), no-verdict rounds, closest calls,
  per-tactic table, models seen, per-session sequence.
* `results-<time>.jsonl`: one line per finished round (crash-safe, used by `--resume`).
* `breaches-<time>.json`: winning messages, ready for `--replay`.
* "closeness" is the attacker model's own 0-10 estimate of how near the previous reply came to giving the coin. It is a
  hint for reading the report, not a measurement.

## Loop for hardening the guard

1. `node redteam.mjs` and read `report-*.md`.
2. Edit `guard.txt` (<= 4000 chars).
3. `node redteam.mjs --guard-file guard.txt --replay breaches-<time>.json` (does the old win still work?), then a fresh
   attack run. A message that already won is burned on that deployment; replay adds a nonce so it counts as new.

## Notes

* The attacker model may decline to play. The loop re-forges those rounds (up to `--forge-retries`) and records which
  model refused; they never count as "the wizard held".
* Keys and deployed addresses are in `.wizard-state.json` (git-ignored, never commit it). Studio Dev can be reset; a
  vanished saved contract is redeployed automatically. `PRIVATE_KEY` makes account #0 your own owner key.
* If a round says out of budget or time units, raise `--leader-tu` / `--validator-tu` (e.g. 300 / 600).
  If deploy fails on the runner hash, pass the hash from Studio Dev's hello-world example: `--runner <hash>`.
* Env: `RPC_URL`, `CONTRACT_ADDRESS`, `ATTACKER_ADDRESS`, `PRIVATE_KEY`.

## Offline contract checks (optional)

```bash
pip install -r requirements-dev.txt
npm run lint:contracts        # genvm-lint check on both contracts
npm run test:contracts        # 13 direct-mode tests with mocked LLM calls (downloads the GenVM SDK once)
```
