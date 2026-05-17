import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Basira } from "../target/types/basira";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";

// ── helpers ───────────────────────────────────────────────────────────────────

const SOL = LAMPORTS_PER_SOL;

function agentPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    programId
  );
}

function vaultPda(agent: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agent.toBuffer()],
    programId
  );
}

function seqBuf(seq: BN): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(seq.toString()));
  return buf;
}

function intentPda(agent: PublicKey, seq: BN, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("intent"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

function receiptPda(agent: PublicKey, seq: BN, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agent.toBuffer(), seqBuf(seq)],
    programId
  );
}

// Anchor encodes enums as objects with a single key
const Action = {
  transfer:     { transfer: {} },
  swap:         { swap: {} },
  stake:        { stake: {} },
  contractCall: { contractCall: {} },
};

// Allowed actions bitmask: bit 0 = Transfer, 1 = Swap, 2 = Stake, 3 = ContractCall
function maskFor(...actions: number[]): number {
  return actions.reduce((acc, bit) => acc | (1 << bit), 0);
}

async function airdrop(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  sol: number
) {
  const sig = await provider.connection.requestAirdrop(to, sol * SOL);
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...bh });
}

async function fundVault(
  provider: anchor.AnchorProvider,
  vault: PublicKey,
  sol: number
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: vault,
      lamports: sol * SOL,
    })
  );
  await provider.sendAndConfirm(tx);
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("basira", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Basira as Program<Basira>;
  const provider = program.provider as anchor.AnchorProvider;
  const authority = provider.wallet.publicKey;

  const MAX_VALUE = new BN(5 * SOL);                    // 5 SOL ceiling
  const ALLOWED_MASK = maskFor(0, 1);                   // Transfer + Swap
  const WINDOW_SECONDS = new BN(0);                     // rate limit disabled for main agent
  const MAX_PER_WINDOW = 0;

  const [agentPubkey] = agentPda(authority, program.programId);
  const [vaultPubkey] = vaultPda(agentPubkey, program.programId);

  // ── 1. Registration ────────────────────────────────────────────────────────

  it("registers an agent with a risk policy", async () => {
    await program.methods
      .registerAgent(
        "demo-agent",
        MAX_VALUE,
        ALLOWED_MASK,
        WINDOW_SECONDS,
        MAX_PER_WINDOW,
        null
      )
      .accounts({ authority })
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPubkey);
    assert.equal(agent.name, "demo-agent");
    assert.equal(agent.policy.maxValueLamports.toNumber(), MAX_VALUE.toNumber());
    assert.equal(agent.policy.allowedActionsMask, ALLOWED_MASK);
    assert.equal(agent.policy.windowSeconds.toNumber(), 0);
    assert.equal(agent.policy.maxPerWindow, 0);
    assert.equal(agent.intentCount.toNumber(), 0);
    assert.equal(agent.countInWindow, 0);
    assert.ok(agent.policyAuthority.equals(authority), "policy_authority defaults to authority");
    assert.isAbove(agent.windowStartTs.toNumber(), 0);

    console.log(`  ✓ agent registered: ${agentPubkey.toBase58()}`);
    console.log(`  ✓ vault PDA:         ${vaultPubkey.toBase58()}`);
  });

  // ── 2. In-policy Transfer → Approved → Executed → real SOL moves ──────────

  it("approves and executes a transfer that actually moves SOL via CPI", async () => {
    const recipient = Keypair.generate().publicKey;
    const seq = new BN(0);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    // Fund vault before execution
    await fundVault(provider, vaultPubkey, 2);
    const vaultBefore = await provider.connection.getBalance(vaultPubkey);
    const recipientBefore = await provider.connection.getBalance(recipient);
    assert.equal(recipientBefore, 0, "fresh recipient should have 0 lamports");

    // submit
    await program.methods
      .submitIntent(Action.transfer, new BN(1 * SOL), recipient)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { approved: {} });
    assert.isNull(intent.rejectionReason);
    assert.ok(intent.recipient.equals(recipient));
    console.log(`  ✓ intent #${seq} approved (transfer, 1 SOL → ${recipient.toBase58().slice(0, 8)}…)`);

    // execute (CPI transfer)
    await program.methods
      .executeIntent()
      .accountsPartial({
        intentRequest: intentPubkey,
        agent: agentPubkey,
        agentAccount: agentPubkey,
        vault: vaultPubkey,
        recipient,
        executionReceipt: receiptPubkey,
        authority,
      })
      .rpc();

    const vaultAfter = await provider.connection.getBalance(vaultPubkey);
    const recipientAfter = await provider.connection.getBalance(recipient);
    assert.equal(recipientAfter, 1 * SOL, "recipient must receive exactly 1 SOL");
    assert.equal(vaultBefore - vaultAfter, 1 * SOL, "vault must debit exactly 1 SOL");

    const executed = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(executed.status, { executed: {} });
    assert.isNotNull(executed.finalisedAt);

    const receipt = await program.account.executionReceipt.fetch(receiptPubkey);
    assert.equal(receipt.intentSeq.toNumber(), 0);
    assert.equal(receipt.valueLamports.toNumber(), 1 * SOL);
    assert.ok(receipt.recipient.equals(recipient));
    console.log(`  ✓ vault → recipient: 1 SOL moved via SystemProgram CPI`);
    console.log(`  ✓ receipt written: intent #${seq} at ts=${receipt.executedAt}`);
  });

  // ── 3. Over-limit → Rejected ──────────────────────────────────────────────

  it("rejects a transfer that exceeds the value limit", async () => {
    const seq = new BN(1);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const recipient = Keypair.generate().publicKey;

    await program.methods
      .submitIntent(Action.transfer, new BN(10 * SOL), recipient)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} });
    assert.equal(intent.rejectionReason, "value exceeds policy limit");
    console.log(`  ✓ intent #${seq} rejected — value 10 SOL exceeds 5 SOL limit`);
  });

  // ── 4. Forbidden action → Rejected ────────────────────────────────────────

  it("rejects a contract call not permitted by policy", async () => {
    const seq = new BN(2);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.contractCall, new BN(1 * SOL), null)
      .accounts({ authority })
      .rpc();

    const intent = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(intent.status, { rejected: {} });
    assert.equal(intent.rejectionReason, "action type not permitted");
    console.log(`  ✓ intent #${seq} rejected — ContractCall not in policy`);
  });

  // ── 5. Cannot execute a rejected intent ───────────────────────────────────

  it("cannot execute a rejected intent", async () => {
    const seq = new BN(2);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);
    const dummyRecipient = Keypair.generate().publicKey;

    try {
      await program.methods
        .executeIntent()
        .accountsPartial({
          intentRequest: intentPubkey,
          agent: agentPubkey,
          agentAccount: agentPubkey,
          vault: vaultPubkey,
          recipient: dummyRecipient,
          executionReceipt: receiptPubkey,
          authority,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "IntentNotApproved");
      console.log(`  ✓ execute correctly blocked for rejected intent #${seq}`);
    }
  });

  // ── 6. Non-Transfer execute → UnsupportedActionCpi (no receipt) ───────────

  it("blocks execute_intent on non-Transfer actions with UnsupportedActionCpi", async () => {
    // submit a Swap (allowed by mask, so it gets Approved)
    const seq = new BN(3);
    const [intentPubkey] = intentPda(agentPubkey, seq, program.programId);
    const [receiptPubkey] = receiptPda(agentPubkey, seq, program.programId);

    await program.methods
      .submitIntent(Action.swap, new BN(1 * SOL), null)
      .accounts({ authority })
      .rpc();

    const approved = await program.account.intentRequest.fetch(intentPubkey);
    assert.deepEqual(approved.status, { approved: {} }, "Swap should be approved");

    const dummyRecipient = Keypair.generate().publicKey;
    try {
      await program.methods
        .executeIntent()
        .accountsPartial({
          intentRequest: intentPubkey,
          agent: agentPubkey,
          agentAccount: agentPubkey,
          vault: vaultPubkey,
          recipient: dummyRecipient,
          executionReceipt: receiptPubkey,
          authority,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "UnsupportedActionCpi");
    }

    // Receipt must NOT exist (entire tx reverted, including account init).
    const receiptInfo = await provider.connection.getAccountInfo(receiptPubkey);
    assert.isNull(receiptInfo, "no receipt should be written when CPI is unsupported");
    console.log(`  ✓ Swap execute reverted with UnsupportedActionCpi, no receipt`);
  });

  // ── 7. Rate limit trips on third intent in window ─────────────────────────

  it("rate-limits approved intents per window", async () => {
    // Fresh agent with rate-limit: 2 intents per 60s.
    const rlAuthority = Keypair.generate();
    await airdrop(provider, rlAuthority.publicKey, 5);
    const [rlAgent] = agentPda(rlAuthority.publicKey, program.programId);

    await program.methods
      .registerAgent(
        "rl-agent",
        new BN(2 * SOL),
        maskFor(0),       // Transfer only
        new BN(60),
        2,
        null
      )
      .accounts({ authority: rlAuthority.publicKey })
      .signers([rlAuthority])
      .rpc();

    const recipient = Keypair.generate().publicKey;

    // submit 3 in-policy Transfers; first two Approved, third Rejected
    const statuses: any[] = [];
    const reasons: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const seq = new BN(i);
      const [intentPubkey] = intentPda(rlAgent, seq, program.programId);

      await program.methods
        .submitIntent(Action.transfer, new BN(0.1 * SOL), recipient)
        .accounts({ authority: rlAuthority.publicKey })
        .signers([rlAuthority])
        .rpc();

      const intent = await program.account.intentRequest.fetch(intentPubkey);
      statuses.push(intent.status);
      reasons.push(intent.rejectionReason);
    }

    assert.deepEqual(statuses[0], { approved: {} });
    assert.deepEqual(statuses[1], { approved: {} });
    assert.deepEqual(statuses[2], { rejected: {} });
    assert.equal(reasons[2], "rate limit exceeded");

    const agent = await program.account.agentAccount.fetch(rlAgent);
    assert.equal(agent.countInWindow, 2, "counter caps at max_per_window");
    console.log(`  ✓ rate limit: intent #0,#1 approved, #2 rejected (rate limit exceeded)`);
  });

  // ── 8. update_policy: policy_authority succeeds; other signer fails ───────

  it("update_policy enforces the separate policy_authority", async () => {
    // Fresh agent with a distinct policy_authority.
    const upAuthority = Keypair.generate();
    const upPolicyAuthority = Keypair.generate();
    const intruder = Keypair.generate();
    await airdrop(provider, upAuthority.publicKey, 3);
    await airdrop(provider, upPolicyAuthority.publicKey, 1);
    await airdrop(provider, intruder.publicKey, 1);

    const [upAgent] = agentPda(upAuthority.publicKey, program.programId);

    await program.methods
      .registerAgent(
        "up-agent",
        new BN(1 * SOL),
        maskFor(0),
        new BN(0),
        0,
        upPolicyAuthority.publicKey
      )
      .accounts({ authority: upAuthority.publicKey })
      .signers([upAuthority])
      .rpc();

    let agent = await program.account.agentAccount.fetch(upAgent);
    assert.ok(agent.policyAuthority.equals(upPolicyAuthority.publicKey));
    assert.equal(agent.policy.maxValueLamports.toNumber(), 1 * SOL);

    // Intruder cannot update — has_one on the context rejects them.
    try {
      await program.methods
        .updatePolicy(new BN(100 * SOL), maskFor(0, 1, 2, 3), new BN(0), 0)
        .accounts({
          agentAccount: upAgent,
          policyAuthority: intruder.publicKey,
        })
        .signers([intruder])
        .rpc();
      assert.fail("intruder should not be able to update policy");
    } catch (err: any) {
      // Anchor surfaces the has_one violation as ConstraintHasOne; our explicit
      // require! would surface UnauthorizedPolicyUpdate. Either is acceptable.
      const msg = String(err.message ?? err);
      assert.ok(
        msg.includes("UnauthorizedPolicyUpdate") || msg.includes("ConstraintHasOne"),
        `unexpected error: ${msg}`
      );
      console.log(`  ✓ intruder rejected on update_policy`);
    }

    agent = await program.account.agentAccount.fetch(upAgent);
    assert.equal(agent.policy.maxValueLamports.toNumber(), 1 * SOL, "policy unchanged");

    // Real policy_authority succeeds.
    await program.methods
      .updatePolicy(new BN(3 * SOL), maskFor(0, 1), new BN(30), 5)
      .accounts({
        agentAccount: upAgent,
        policyAuthority: upPolicyAuthority.publicKey,
      })
      .signers([upPolicyAuthority])
      .rpc();

    agent = await program.account.agentAccount.fetch(upAgent);
    assert.equal(agent.policy.maxValueLamports.toNumber(), 3 * SOL);
    assert.equal(agent.policy.allowedActionsMask, maskFor(0, 1));
    assert.equal(agent.policy.windowSeconds.toNumber(), 30);
    assert.equal(agent.policy.maxPerWindow, 5);
    assert.equal(agent.countInWindow, 0, "rate-limit window resets on policy update");
    console.log(`  ✓ policy_authority updated policy → maxValue=3 SOL, window=30s/5`);
  });
});
