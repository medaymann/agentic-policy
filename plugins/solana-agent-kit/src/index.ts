/**
 * @basira/agent-kit — Solana Agent Kit plugin for the Basira trust layer.
 *
 * Drops Basira's policy-gated execution into a Solana Agent Kit agent.
 * Instead of signing transfers directly, the agent calls `basira_transfer`,
 * which routes through Basira's on-chain policy engine: every action is
 * evaluated against the agent's rule list before any lamports move, and
 * approved actions produce an immutable on-chain receipt.
 *
 * Usage:
 *
 *   import { SolanaAgentKit } from "solana-agent-kit";
 *   import { BasiraPlugin } from "@basira/agent-kit";
 *
 *   const agent = new SolanaAgentKit(wallet, rpcUrl, cfg)
 *     .use(new BasiraPlugin());
 *
 *   // exposed to the agent's LLM tool surface:
 *   //   basira_register, basira_transfer, basira_replace_policy, basira_status
 *
 * NOTE: while developing inside the Basira monorepo this imports a minimal
 * local SAK interface (`./sak-types`). When publishing to npm, replace those
 * imports with `solana-agent-kit` — see sak-types.ts for instructions.
 */

import type { Plugin, Action, SolanaAgentKit } from "./sak-types";
import {
  BasiraClient,
  Rule,
  RuleArg,
  PublicKey,
  basiraRegister,
  basiraSubmitAndExecute,
  basiraReplacePolicy,
  basiraStatus,
} from "../../core/src";

export interface BasiraPluginOpts {
  /** Optional RPC override; by default the agent's own connection is used. */
  rpcUrl?: string;
}

/**
 * Translate a friendly rule descriptor (the shape an LLM or agent author
 * passes) into the SDK's Anchor-encoded RuleArg.
 *
 *   { type: "MaxValue", valueSol: 2 }
 *   { type: "AllowedActions", actions: ["Transfer"] }
 *   { type: "RatePerWindow", windowSeconds: 60, max: 3 }
 */
export function ruleFromDescriptor(d: any): RuleArg {
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

export class BasiraPlugin implements Plugin {
  readonly name = "basira";
  private client!: BasiraClient;

  constructor(private opts: BasiraPluginOpts = {}) {}

  /** Called by SAK when the plugin is registered via `.use()`. */
  initialize(agent: SolanaAgentKit): void {
    this.client = new BasiraClient({
      wallet: agent.wallet,
      connection: agent.connection,
    });
  }

  /** Direct programmatic access for agent authors who skip the LLM layer. */
  get basira() {
    return {
      register: (args: { name: string; rules: any[]; policyAuthority?: string }) =>
        basiraRegister(this.client, {
          name: args.name,
          rules: args.rules.map(ruleFromDescriptor),
          policyAuthority: args.policyAuthority
            ? new PublicKey(args.policyAuthority)
            : null,
        }),
      transfer: (args: { recipient: string; valueSol: number }) =>
        basiraSubmitAndExecute(this.client, {
          action: "Transfer",
          valueSol: args.valueSol,
          recipient: new PublicKey(args.recipient),
        }),
      replacePolicy: (args: { rules: any[] }) =>
        basiraReplacePolicy(this.client, {
          rules: args.rules.map(ruleFromDescriptor),
        }),
      status: () => basiraStatus(this.client),
    };
  }

  /** LLM-callable tool descriptors registered with the agent. */
  actions: Action[] = [
    {
      name: "basira_register",
      description:
        "Register this agent with Basira and set its initial on-chain policy. " +
        "`rules` is a list of rule descriptors: " +
        '{type:"MaxValue",valueSol:N}, {type:"AllowedActions",actions:["Transfer","Swap"]}, ' +
        '{type:"RatePerWindow",windowSeconds:N,max:N}. Call this once before basira_transfer.',
      handler: async (_agent, input) =>
        basiraRegister(this.client, {
          name: input.name,
          rules: (input.rules ?? []).map(ruleFromDescriptor),
          policyAuthority: input.policyAuthority
            ? new PublicKey(input.policyAuthority)
            : null,
        }),
    },
    {
      name: "basira_transfer",
      description:
        "Send SOL through Basira's policy-gated trust layer. Real lamports " +
        "move from the agent's vault to `recipient` only if every policy rule " +
        "passes; a rejected transfer returns an on-chain reason naming the " +
        "failing rule. Inputs: recipient (base58 pubkey), valueSol (number).",
      handler: async (_agent, input) =>
        basiraSubmitAndExecute(this.client, {
          action: "Transfer",
          valueSol: Number(input.valueSol),
          recipient: new PublicKey(input.recipient),
        }),
    },
    {
      name: "basira_replace_policy",
      description:
        "Replace the agent's Basira policy with a new rule list. Must be " +
        "signed by the agent's policy authority. Inputs: rules (list of rule " +
        "descriptors, same shape as basira_register).",
      handler: async (_agent, input) =>
        basiraReplacePolicy(this.client, {
          rules: (input.rules ?? []).map(ruleFromDescriptor),
        }),
    },
    {
      name: "basira_status",
      description:
        "Read the agent's Basira state: policy version, the active rule list " +
        "with human-readable summaries, vault balance, and rate-limit window " +
        "counters. Takes no inputs.",
      handler: async () => basiraStatus(this.client),
    },
  ];
}

export default BasiraPlugin;
export { Rule } from "../../core/src";
