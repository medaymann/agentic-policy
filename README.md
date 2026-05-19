# BasiraAI

> Trust infrastructure for autonomous agent execution on Solana.

## What is Basira?

AI agents on Solana can already transact. What they cannot do is prove
they should have.

Basira is the trust and policy enforcement layer that sits between an
agent receiving a task and an agent executing it. Every action is
validated against a configurable on-chain policy engine before it touches
the chain. Every execution produces an immutable on-chain receipt that
proves what happened, when, and why it was allowed.

No more black-box agent decisions. No more unauditable autonomous
transactions. Just provable, policy-gated execution.

## Architecture

| Layer | Purpose |
|---|---|
| Policy Engine (on-chain) | Configurable rules — value thresholds, action whitelists |
| Trust Validator (in-program) | Evaluates each `submit_intent` against the active policy |
| Execution Receipt | Immutable on-chain proof that an approved intent ran |
| Guard | Blocks `execute_intent` unless the intent is in `Approved` state |
| SDK | TypeScript wrapper around the program (used by CLI + web demo) |
| Demo | CLI walkthrough + web UI |

## Repo layout

```
programs/basira/   # Anchor program — AgentAccount, IntentRequest, ExecutionReceipt
sdk/src/           # TypeScript SDK wrapping the program
demo/run.ts        # End-to-end CLI walkthrough (5 scenarios)
web/               # Express server + static UI for live demoing
tests/basira.ts    # Anchor test suite (5 passing scenarios)
```

## Quick start — full demo in 4 commands

Requires: `anchor` 0.32+, `solana` CLI, `node` 20+, `yarn`.

```bash
# 1. install deps + build the program
yarn install
anchor build

# 2. start a local validator (in another terminal, or background it)
solana-test-validator --reset

# 3. fund the keypair and deploy
solana airdrop 100 -u http://127.0.0.1:8899 -k ~/.config/solana/id.json
anchor deploy --provider.cluster localnet

# 4. run the scripted CLI demo
yarn demo
```

You'll see five scenarios run live against the chain:

1. Register an agent + on-chain risk policy
2. In-policy transfer → **APPROVED** → executed → on-chain receipt
3. Over-limit transfer → **REJECTED** (`value exceeds policy limit`)
4. Forbidden action → **REJECTED** (`action type not permitted`)
5. Attempt to execute the rejected intent → blocked by `IntentNotApproved`

## Web demo

After steps 1-3 above:

```bash
yarn web
# → http://localhost:4000
```

The UI shows the agent and its policy, lets you submit arbitrary intents,
auto-executes approved ones, and lists all on-chain intents and receipts
in real time. Each row links out to Solana Explorer.

## Test the program

```bash
anchor test
```

Runs the suite against an ephemeral validator. Five scenarios, all green.

## Targeting devnet

The program is **live on devnet** at `2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu`
([explorer](https://explorer.solana.com/address/2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu?cluster=devnet)).
No deploy needed — point any client at devnet and it works:

```bash
yarn demo:devnet
yarn web:devnet
```

## On-chain accounts

| Account | Purpose |
|---|---|
| `AgentAccount` | Agent identity + inline `RiskPolicy` (max value, allowed-actions bitmask). One per authority — PDA seeded `["agent", authority]`. |
| `IntentRequest` | A proposed action. Status is `Approved` or `Rejected` *before the instruction returns*. PDA seeded `["intent", agent, seq_le]`. |
| `ExecutionReceipt` | Immutable proof an approved intent ran. PDA seeded `["receipt", agent, seq_le]`. |

Events: `AgentRegistered`, `IntentEvaluated`, `ReceiptWritten`.

## Built On

- [Solana](https://solana.com)
- [Anchor](https://anchor-lang.com)
- [Solana Attestation Service](https://attest.solana.com)
- [Solana Agent Registry](https://solana.com/agent-registry)
