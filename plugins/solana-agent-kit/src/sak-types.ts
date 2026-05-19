/**
 * Minimal local declaration of the slice of the Solana Agent Kit (SAK) v2
 * plugin contract that the Basira plugin actually uses.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * While developing in this repo we do NOT depend on the `solana-agent-kit`
 * npm package — pulling it in just to typecheck would drag heavy, version-
 * pinned transitive deps into the workspace.
 *
 * ── What to do when publishing ────────────────────────────────────────────
 * When `@basira/agent-kit` is published to npm, DELETE this file and replace
 * the imports in `index.ts` with the real types:
 *
 *     import type { SolanaAgentKit, Plugin, Action } from "solana-agent-kit";
 *
 * The Basira plugin code itself does not change — only the import line.
 * These shapes mirror SAK v2's public surface (the `.use(plugin)` lifecycle,
 * `agent.wallet`, `agent.connection`, and LangChain/Vercel-AI tool
 * descriptors).
 */

import type { Connection } from "@solana/web3.js";
import type * as anchor from "@coral-xyz/anchor";

/** The SAK agent instance handed to plugins and action handlers. */
export interface SolanaAgentKit {
  /** Anchor-compatible wallet wrapping the agent's signer. */
  wallet: anchor.Wallet;
  /** RPC connection the agent uses. */
  connection: Connection;
}

/** A single LLM-callable tool exposed by a plugin. */
export interface Action {
  /** Tool name surfaced to the LLM (snake_case by SAK convention). */
  name: string;
  /** Natural-language description the model uses to decide when to call it. */
  description: string;
  /**
   * Handler invoked when the LLM (or the agent author) calls the tool.
   * `input` is the already-parsed argument object.
   */
  handler: (agent: SolanaAgentKit, input: any) => Promise<any>;
}

/** A SAK plugin: a named bundle of actions registered via `agent.use(plugin)`. */
export interface Plugin {
  name: string;
  /** LLM-callable tools this plugin contributes. */
  actions: Action[];
  /**
   * Called once when the plugin is registered with `.use()`. Receives the
   * agent so the plugin can capture its wallet/connection.
   */
  initialize(agent: SolanaAgentKit): void;
}
