/**
 * Basira SDK — thin wrapper around the on-chain `basira` Anchor program.
 *
 * Exposes the few primitives a demo or client needs:
 *   - registerAgent, submitIntent, executeIntent
 *   - PDA derivations
 *   - fetch helpers for agents / intents / receipts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN, AnchorProvider, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
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

// ── PDA helpers ───────────────────────────────────────────────────────────────

export function agentPda(authority: PublicKey, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
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

  // ── instructions ──────────────────────────────────────────────────────────

  async registerAgent(
    name: string,
    maxValueLamports: BN | number,
    allowedActions: ActionTypeName[]
  ): Promise<string> {
    const mask = maskFor(allowedActions);
    return this.program.methods
      .registerAgent(name, new BN(maxValueLamports), mask)
      .accounts({ authority: this.authority() })
      .rpc();
  }

  async submitIntent(
    action: ActionTypeName,
    valueLamports: BN | number
  ): Promise<{ tx: string; intent: PublicKey; seq: BN }> {
    const agent = this.agentPda();
    const agentAccount = await this.program.account.agentAccount.fetch(agent);
    const seq = agentAccount.intentCount as BN;
    const [intent] = intentPda(agent, seq, this.programId);

    const tx = await this.program.methods
      .submitIntent(ActionVariant[action], new BN(valueLamports))
      .accounts({ authority: this.authority() })
      .rpc();

    return { tx, intent, seq };
  }

  async executeIntent(
    seq: BN | number
  ): Promise<{ tx: string; receipt: PublicKey }> {
    const agent = this.agentPda();
    const [intent] = intentPda(agent, seq, this.programId);
    const [receipt] = receiptPda(agent, seq, this.programId);

    const tx = await this.program.methods
      .executeIntent()
      .accounts({
        intentRequest: intent,
        agent: agent,
        executionReceipt: receipt,
        authority: this.authority(),
      })
      .rpc();

    return { tx, receipt };
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
