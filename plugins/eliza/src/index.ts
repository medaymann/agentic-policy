/**
 * @basira/eliza-plugin — ElizaOS plugin for the Basira trust layer.
 *
 * Gives an ElizaOS character policy-gated, receipted on-chain execution.
 * When the character decides to move SOL it fires the BASIRA_TRANSFER
 * action, which routes through Basira's on-chain policy engine instead of
 * signing a raw transfer — every action is checked against the agent's rule
 * list and approved actions produce an immutable on-chain receipt.
 *
 * Wire it into a character:
 *
 *   import { basiraPlugin } from "@basira/eliza-plugin";
 *   const character = { ..., plugins: [basiraPlugin] };
 *
 * Runtime settings the plugin reads:
 *   - SOLANA_RPC_URL      (default: http://127.0.0.1:8899)
 *   - SOLANA_PRIVATE_KEY  (JSON array or base58 secret key of the agent)
 *
 * NOTE: while developing inside the Basira monorepo this imports a minimal
 * local Eliza interface (`./eliza-types`). When publishing, replace those
 * imports with `@elizaos/core` — see eliza-types.ts for instructions.
 */

import { Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import type {
  Plugin,
  Action,
  Provider,
  IAgentRuntime,
  Memory,
} from "./eliza-types";
import {
  BasiraClient,
  Rule,
  RuleArg,
  Keypair,
  PublicKey,
  basiraRegister,
  basiraSubmitAndExecute,
  basiraReplacePolicy,
  basiraStatus,
} from "../../core/src";

// ── runtime → BasiraClient ────────────────────────────────────────────────────

function parseSecretKey(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // base58 — decode via PublicKey's bs58 dependency path is not exposed, so
  // require a JSON array. Keep the error explicit.
  throw new Error(
    "SOLANA_PRIVATE_KEY must be a JSON byte array (e.g. [12,34,...])"
  );
}

/** Build a BasiraClient from the Eliza runtime's Solana settings. */
export function clientFromRuntime(runtime: IAgentRuntime): BasiraClient {
  const rpc = runtime.getSetting("SOLANA_RPC_URL") ?? "http://127.0.0.1:8899";
  const sk = runtime.getSetting("SOLANA_PRIVATE_KEY");
  if (!sk) {
    throw new Error("SOLANA_PRIVATE_KEY runtime setting is required");
  }
  const wallet = new anchor.Wallet(parseSecretKey(sk));
  return new BasiraClient({ wallet, connection: new Connection(rpc, "confirmed") });
}

function ruleFromDescriptor(d: any): RuleArg {
  switch (d?.type) {
    case "MaxValue":
      return Rule.maxValue(Math.floor(Number(d.valueSol) * 1_000_000_000));
    case "AllowedActions":
      return Rule.allowedActions(d.actions);
    case "RatePerWindow":
      return Rule.ratePerWindow(Number(d.windowSeconds), Number(d.max));
    default:
      throw new Error(`unknown rule type: ${d?.type}`);
  }
}

// ── actions ───────────────────────────────────────────────────────────────────

const transferAction: Action = {
  name: "BASIRA_TRANSFER",
  similes: ["SEND_SOL_GATED", "POLICY_TRANSFER", "GUARDED_TRANSFER"],
  description:
    "Send SOL through Basira's on-chain policy engine. The transfer only " +
    "settles if every policy rule passes; otherwise it is rejected on-chain " +
    "with the failing rule named. Use this instead of a raw transfer whenever " +
    "the agent moves funds. Options: { recipient: string, valueSol: number }.",
  examples: [
    [
      { name: "{{user}}", content: { text: "send 0.1 SOL to 9xQ…abc" } },
      {
        name: "{{agent}}",
        content: {
          text: "Submitting that through Basira's policy engine…",
          action: "BASIRA_TRANSFER",
        },
      },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const client = clientFromRuntime(runtime);
    const recipient = String(options?.recipient ?? "");
    const valueSol = Number(options?.valueSol ?? 0);
    if (!recipient) throw new Error("BASIRA_TRANSFER requires `recipient`");
    const result = await basiraSubmitAndExecute(client, {
      action: "Transfer",
      valueSol,
      recipient: new PublicKey(recipient),
    });
    if (callback) await callback({ text: result.summary, data: result });
    return result;
  },
};

const registerAction: Action = {
  name: "BASIRA_REGISTER",
  similes: ["REGISTER_AGENT", "SET_POLICY"],
  description:
    "Register this agent with Basira and set its initial on-chain policy. " +
    "Call once before BASIRA_TRANSFER. Options: { name: string, rules: " +
    "RuleDescriptor[], policyAuthority?: string }.",
  examples: [
    [
      { name: "{{user}}", content: { text: "set up the agent's spending policy" } },
      {
        name: "{{agent}}",
        content: {
          text: "Registering the agent with Basira…",
          action: "BASIRA_REGISTER",
        },
      },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const client = clientFromRuntime(runtime);
    const result = await basiraRegister(client, {
      name: String(options?.name ?? "eliza-agent"),
      rules: (options?.rules ?? []).map(ruleFromDescriptor),
      policyAuthority: options?.policyAuthority
        ? new PublicKey(String(options.policyAuthority))
        : null,
    });
    if (callback) await callback({ text: result.summary, data: result });
    return result;
  },
};

const replacePolicyAction: Action = {
  name: "BASIRA_REPLACE_POLICY",
  similes: ["UPDATE_POLICY", "CHANGE_RULES"],
  description:
    "Replace the agent's Basira policy with a new rule list. Must be signed " +
    "by the agent's policy authority. Options: { rules: RuleDescriptor[] }.",
  examples: [
    [
      { name: "{{user}}", content: { text: "tighten the spending limit" } },
      {
        name: "{{agent}}",
        content: {
          text: "Updating the on-chain policy…",
          action: "BASIRA_REPLACE_POLICY",
        },
      },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, options, callback) => {
    const client = clientFromRuntime(runtime);
    const result = await basiraReplacePolicy(client, {
      rules: (options?.rules ?? []).map(ruleFromDescriptor),
    });
    if (callback) await callback({ text: result.summary, data: result });
    return result;
  },
};

const statusAction: Action = {
  name: "BASIRA_STATUS",
  similes: ["CHECK_POLICY", "AGENT_STATUS"],
  description:
    "Report the agent's Basira state: policy version, active rule list, " +
    "vault balance, and rate-limit counters. Takes no options.",
  examples: [
    [
      { name: "{{user}}", content: { text: "what's the agent's current policy?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking the on-chain policy…",
          action: "BASIRA_STATUS",
        },
      },
    ],
  ],
  validate: async () => true,
  handler: async (runtime, _message, _state, _options, callback) => {
    const client = clientFromRuntime(runtime);
    const result = await basiraStatus(client);
    if (callback) await callback({ text: result.summary, data: result });
    return result;
  },
};

// ── provider — injects the live policy into the model's context ──────────────

const policyProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message: Memory) => {
    try {
      const client = clientFromRuntime(runtime);
      const status = await basiraStatus(client);
      if (!status.exists) {
        return "Basira: this agent is not yet registered. Use BASIRA_REGISTER before moving funds.";
      }
      const rules = (status.rules ?? [])
        .map((r) => `  - rule ${r.index}: ${r.summary}`)
        .join("\n");
      return [
        `Basira policy (version ${status.policyVersion}):`,
        rules || "  (no rules)",
        `Vault balance: ${status.vaultBalanceSol?.toFixed(4)} SOL.`,
        "All fund movements must go through BASIRA_TRANSFER, which enforces this policy on-chain.",
      ].join("\n");
    } catch {
      return "";
    }
  },
};

// ── plugin ────────────────────────────────────────────────────────────────────

export const basiraPlugin: Plugin = {
  name: "basira",
  description:
    "On-chain trust layer for autonomous Solana agents: policy-gated, " +
    "receipted execution. Routes the agent's fund movements through an " +
    "on-chain policy engine.",
  actions: [transferAction, registerAction, replacePolicyAction, statusAction],
  providers: [policyProvider],
};

export default basiraPlugin;
export { Rule } from "../../core/src";
