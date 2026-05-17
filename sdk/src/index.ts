/**
 * Basira SDK — thin wrapper around the on-chain `basira` Anchor program.
 *
 * Exposes the primitives a demo or client needs:
 *   - registerAgent, submitIntent, executeIntent, updatePolicy, fundVault
 *   - PDA derivations (agent, intent, receipt, vault)
 *   - fetch helpers for agents / intents / receipts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorProvider, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { Basira } from "../../target/types/basira";
import idl from "../../target/idl/basira.json";

// ── Action types & helpers ────────────────────────────────────────────────────

export const ActionType = {
  Transfer: 0,
  Swap: 1,
  Stake: 2,
  ContractCall: 3,
} as const;

export type ActionTypeName = keyof typeof ActionType;

/** Anchor encodes enums as `{ variantName: {} }`. */
export const ActionVariant: Record<ActionTypeName, any> = {
  Transfer: { transfer: {} },
  Swap: { swap: {} },
  Stake: { stake: {} },
  ContractCall: { contractCall: {} },
};

/** Build an allowed-actions bitmask from a list of action names. */
export function maskFor(actions: ActionTypeName[]): number {
  return actions.reduce((acc, name) => acc | (1 << ActionType[name]), 0);
}

/** Decode an allowed-actions bitmask back into an array of action names. */
export function actionsFromMask(mask: number): ActionTypeName[] {
  const out: ActionTypeName[] = [];
  (Object.keys(ActionType) as ActionTypeName[]).forEach((k) => {
    if (mask & (1 << ActionType[k])) out.push(k);
  });
  return out;
}

/** Status helpers — intent / receipt status names. */
export type IntentStatusName = "Pending" | "Approved" | "Rejected" | "Executed";

export function statusName(status: any): IntentStatusName {
  const k = Object.keys(status)[0];
  return (k.charAt(0).toUpperCase() + k.slice(1)) as IntentStatusName;
}

/** Known program error names — useful for clients that want to detect specific failures. */
export const BasiraErrorName = {
  ValueExceedsLimit: "ValueExceedsLimit",
  ActionNotPermitted: "ActionNotPermitted",
  IntentNotApproved: "IntentNotApproved",
  IntentAlreadyFinalised: "IntentAlreadyFinalised",
  RateLimitExceeded: "RateLimitExceeded",
  UnauthorizedPolicyUpdate: "UnauthorizedPolicyUpdate",
  UnsupportedActionCpi: "UnsupportedActionCpi",
  RecipientRequired: "RecipientRequired",
  RecipientMismatch: "RecipientMismatch",
} as const;

// ── PDA helpers ───────────────────────────────────────────────────────────────

export function agentPda(authority: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    programId
  );
}

export function vaultPda(agent: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agent.toBuffer()],
    programId
  );
}

function seqBuf(seq: BN | number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(seq.toString()));
  return buf;
}

export function intentPda(agent: PublicKey, seq: BN | number, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

export function receiptPda(agent: PublicKey, seq: BN | number, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

// ── Client ────────────────────────────────────────────────────────────────────

export const PROGRAM_ID = new PublicKey(
  "2oYHgAYscSG4JvQcKcUq4oFGsDFU2SRBtFYFnHxpzgtu"
);

export interface BasiraClientOpts {
  rpcUrl?: string;          // default: http://127.0.0.1:8899
  keypairPath?: string;     // default: ~/.config/solana/id.json
  keypair?: Keypair;        // overrides keypairPath
}

export interface RegisterAgentArgs {
  name: string;
  maxValueLamports: BN | number;
  allowedActions: ActionTypeName[];
  /** Rolling rate-limit window in seconds. 0 disables rate limiting. */
  windowSeconds?: BN | number;
  /** Max approved intents per window. Ignored when windowSeconds == 0. */
  maxPerWindow?: number;
  /** Separate signer for policy updates. Defaults to the agent's authority. */
  policyAuthority?: PublicKey | null;
}

export interface SubmitIntentArgs {
  action: ActionTypeName;
  valueLamports: BN | number;
  /** Required for Transfer; ignored (defaults to Pubkey::default) otherwise. */
  recipient?: PublicKey | null;
}

export interface UpdatePolicyArgs {
  maxValueLamports: BN | number;
  allowedActions: ActionTypeName[];
  windowSeconds: BN | number;
  maxPerWindow: number;
}

export class BasiraClient {
  readonly connection: Connection;
  readonly wallet: anchor.Wallet;
  readonly provider: AnchorProvider;
  readonly program: Program<Basira>;
  readonly programId: PublicKey;

  constructor(opts: BasiraClientOpts = {}) {
    const rpcUrl = opts.rpcUrl ?? "http://127.0.0.1:8899";
    this.connection = new Connection(rpcUrl, "confirmed");

    const kp =
      opts.keypair ??
      loadKeypair(opts.keypairPath ?? defaultKeypairPath());

    this.wallet = new anchor.Wallet(kp);
    this.provider = new AnchorProvider(this.connection, this.wallet, {
      commitment: "confirmed",
    });
    this.program = new Program<Basira>(idl as Idl as Basira, this.provider);
    this.programId = this.program.programId;
  }

  authority(): PublicKey {
    return this.wallet.publicKey;
  }

  agentPda(authority: PublicKey = this.authority()) {
    return agentPda(authority, this.programId)[0];
  }

  vaultPda(agent: PublicKey = this.agentPda()) {
    return vaultPda(agent, this.programId)[0];
  }

  // ── instructions ──────────────────────────────────────────────────────────

  async registerAgent(args: RegisterAgentArgs): Promise<string> {
    const mask = maskFor(args.allowedActions);
    const windowSeconds = new BN(args.windowSeconds ?? 0);
    const maxPerWindow = args.maxPerWindow ?? 0;
    return this.program.methods
      .registerAgent(
        args.name,
        new BN(args.maxValueLamports),
        mask,
        windowSeconds,
        maxPerWindow,
        args.policyAuthority ?? null
      )
      .accounts({ authority: this.authority() })
      .rpc();
  }

  async submitIntent(
    args: SubmitIntentArgs
  ): Promise<{ tx: string; intent: PublicKey; seq: BN }> {
    if (args.action === "Transfer" && !args.recipient) {
      throw new Error("submitIntent: Transfer intents require a recipient");
    }
    const agent = this.agentPda();
    const agentAccount = await this.program.account.agentAccount.fetch(agent);
    const seq = agentAccount.intentCount as BN;
    const [intent] = intentPda(agent, seq, this.programId);

    const tx = await this.program.methods
      .submitIntent(
        ActionVariant[args.action],
        new BN(args.valueLamports),
        args.recipient ?? null
      )
      .accounts({ authority: this.authority() })
      .rpc();

    return { tx, intent, seq };
  }

  /**
   * Execute an approved intent. The recipient is looked up from the on-chain
   * intent if not provided, so callers usually just pass `seq`.
   */
  async executeIntent(
    seq: BN | number,
    recipient?: PublicKey
  ): Promise<{ tx: string; receipt: PublicKey }> {
    const agent = this.agentPda();
    const [intent] = intentPda(agent, seq, this.programId);
    const [receipt] = receiptPda(agent, seq, this.programId);
    const vault = this.vaultPda(agent);

    let to = recipient;
    if (!to) {
      const intentAcc = await this.program.account.intentRequest.fetch(intent);
      to = intentAcc.recipient as PublicKey;
    }

    const tx = await this.program.methods
      .executeIntent()
      .accountsPartial({
        intentRequest: intent,
        agent,
        agentAccount: agent,
        vault,
        recipient: to,
        executionReceipt: receipt,
        authority: this.authority(),
      })
      .rpc();

    return { tx, receipt };
  }

  /**
   * Replace the agent's risk policy. Must be signed by the agent's
   * `policy_authority`. Pass that keypair as the second argument when it
   * differs from the wallet on this client.
   */
  async updatePolicy(
    args: UpdatePolicyArgs,
    policyAuthority?: Keypair
  ): Promise<string> {
    const agent = this.agentPda();
    const signerKey = policyAuthority?.publicKey ?? this.authority();
    const builder = this.program.methods
      .updatePolicy(
        new BN(args.maxValueLamports),
        maskFor(args.allowedActions),
        new BN(args.windowSeconds),
        args.maxPerWindow
      )
      .accounts({
        agentAccount: agent,
        policyAuthority: signerKey,
      });

    if (policyAuthority) {
      return builder.signers([policyAuthority]).rpc();
    }
    return builder.rpc();
  }

  /** Fund the agent's vault PDA with `lamports` from the wallet. */
  async fundVault(lamports: BN | number): Promise<string> {
    const vault = this.vaultPda();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.authority(),
        toPubkey: vault,
        lamports: BigInt(new BN(lamports).toString()),
      })
    );
    return this.provider.sendAndConfirm(tx);
  }

  async vaultBalance(agent: PublicKey = this.agentPda()): Promise<number> {
    return this.connection.getBalance(this.vaultPda(agent));
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async fetchAgent(authority: PublicKey = this.authority()) {
    return this.program.account.agentAccount.fetch(this.agentPda(authority));
  }

  async fetchAgentOrNull(authority: PublicKey = this.authority()) {
    try {
      return await this.fetchAgent(authority);
    } catch {
      return null;
    }
  }

  async fetchIntent(seq: BN | number, agent?: PublicKey) {
    const [pda] = intentPda(agent ?? this.agentPda(), seq, this.programId);
    return this.program.account.intentRequest.fetch(pda);
  }

  async fetchReceipt(seq: BN | number, agent?: PublicKey) {
    const [pda] = receiptPda(agent ?? this.agentPda(), seq, this.programId);
    return this.program.account.executionReceipt.fetch(pda);
  }

  async listIntents(agent?: PublicKey) {
    const a = agent ?? this.agentPda();
    const all = await this.program.account.intentRequest.all([
      { memcmp: { offset: 8, bytes: a.toBase58() } },
    ]);
    return all
      .map((x) => ({ pubkey: x.publicKey, account: x.account }))
      .sort((l, r) =>
        (l.account.seq as BN).cmp(r.account.seq as BN)
      );
  }

  async listReceipts(agent?: PublicKey) {
    const a = agent ?? this.agentPda();
    const all = await this.program.account.executionReceipt.all([
      { memcmp: { offset: 8, bytes: a.toBase58() } },
    ]);
    return all
      .map((x) => ({ pubkey: x.publicKey, account: x.account }))
      .sort((l, r) =>
        (l.account.intentSeq as BN).cmp(r.account.intentSeq as BN)
      );
  }
}

// ── keypair loading ───────────────────────────────────────────────────────────

export function defaultKeypairPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "solana", "id.json");
}

export function loadKeypair(filepath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function rpcUrlForCluster(
  cluster: "localnet" | "devnet" | "mainnet-beta"
): string {
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

// ── re-exports ────────────────────────────────────────────────────────────────

export { BN, PublicKey, Keypair };
export type { Basira };
