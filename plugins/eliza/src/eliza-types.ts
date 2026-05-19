/**
 * Minimal local declaration of the slice of the ElizaOS (`@elizaos/core`)
 * plugin contract that the Basira plugin actually uses.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * While developing inside the Basira monorepo we do NOT depend on the
 * `@elizaos/core` npm package — it would drag heavy, version-pinned
 * transitive deps into the workspace just to typecheck.
 *
 * ── What to do when publishing ────────────────────────────────────────────
 * When `@basira/eliza-plugin` is published to npm, DELETE this file and
 * replace the imports in `index.ts` with the real types:
 *
 *     import type {
 *       Plugin, Action, Provider, IAgentRuntime, Memory, State,
 *       HandlerCallback,
 *     } from "@elizaos/core";
 *
 * The Basira plugin code itself does not change — only the import line.
 * These shapes mirror the ElizaOS plugin surface (actions with
 * validate/handler, providers with a get(), and a runtime exposing
 * getSetting()).
 */

/** A message in the agent's conversation. */
export interface Memory {
  content: { text?: string; [k: string]: any };
  [k: string]: any;
}

/** Composed conversation state passed to handlers. */
export interface State {
  [k: string]: any;
}

/** Callback a handler invokes to emit its result back to the conversation. */
export type HandlerCallback = (response: {
  text: string;
  [k: string]: any;
}) => Promise<void> | void;

/** The Eliza runtime. The Basira plugin only needs configuration access. */
export interface IAgentRuntime {
  /** Read a runtime setting (env var / character config), e.g. SOLANA_RPC_URL. */
  getSetting(key: string): string | undefined;
}

/** A single LLM-driven capability. */
export interface Action {
  name: string;
  /** Alternate names the model may use for this action. */
  similes: string[];
  description: string;
  /** Few-shot conversation examples teaching the model when to fire. */
  examples: any[];
  /** Whether this action is applicable to the current message. */
  validate: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  /** Perform the action and report back via `callback`. */
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: Record<string, any> | undefined,
    callback?: HandlerCallback
  ) => Promise<unknown>;
}

/** A read-only context contributor injected into the model's prompt. */
export interface Provider {
  get: (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State
  ) => Promise<string>;
}

/** An ElizaOS plugin: named bundle of actions + providers. */
export interface Plugin {
  name: string;
  description: string;
  actions: Action[];
  providers: Provider[];
}
