/**
 * Basira demo web server.
 *
 * Tiny Express app that exposes the SDK over HTTP and serves a single-page UI
 * from `web/public/`. Designed for live demos — refresh-friendly, idempotent
 * registration, and a JSON shape that's easy to render.
 *
 * The server holds a long-lived "policy authority" keypair on disk so it can
 * sign `update_policy` calls. That key is distinct from the agent's signing
 * authority (the server's wallet). In production the policy authority would
 * be held by a different principal (human, multisig, etc.).
 */

import express from "express";
import path from "path";
import fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  BasiraClient,
  ActionTypeName,
  actionsFromMask,
  statusName,
  rpcUrlForCluster,
} from "../sdk/src";

const SOL = 1_000_000_000;

const PORT = Number(process.env.PORT ?? 4000);
const CLUSTER = (process.env.BASIRA_CLUSTER ?? "localnet") as
  | "localnet"
  | "devnet"
  | "mainnet-beta";

const client = new BasiraClient({ rpcUrl: rpcUrlForCluster(CLUSTER) });

// ── policy authority — persisted across server restarts ──────────────────────

function loadOrCreatePolicyAuthority(): Keypair {
  const p = path.join(process.cwd(), ".basira-web-policy-authority.json");
  if (fs.existsSync(p)) {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

const policyAuthority = loadOrCreatePolicyAuthority();

async function ensurePolicyAuthorityFunded() {
  const bal = await client.connection.getBalance(policyAuthority.publicKey);
  if (bal >= 0.01 * SOL) return;
  if (CLUSTER === "localnet") {
    const sig = await client.connection.requestAirdrop(
      policyAuthority.publicKey,
      0.05 * SOL
    );
    const bh = await client.connection.getLatestBlockhash();
    await client.connection.confirmTransaction({ signature: sig, ...bh });
  } else {
    throw new Error(
      `policy authority ${policyAuthority.publicKey.toBase58()} needs ~0.01 SOL for tx fees on ${CLUSTER}`
    );
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── helpers ────────────────────────────────────────────────────────────────────

function serializeIntent(account: any, pubkey: any) {
  const recipient = (account.recipient as PublicKey).toBase58();
  return {
    pubkey: pubkey.toBase58(),
    seq: (account.seq as BN).toNumber(),
    actionType: Object.keys(account.actionType)[0],
    valueLamports: (account.valueLamports as BN).toString(),
    valueSol: (account.valueLamports as BN).toNumber() / SOL,
    recipient,
    status: statusName(account.status),
    rejectionReason: account.rejectionReason ?? null,
    submittedAt: Number(account.submittedAt),
    finalisedAt: account.finalisedAt ? Number(account.finalisedAt) : null,
    agent: account.agent.toBase58(),
  };
}

function serializeReceipt(account: any, pubkey: any) {
  return {
    pubkey: pubkey.toBase58(),
    intentSeq: (account.intentSeq as BN).toNumber(),
    actionType: Object.keys(account.actionType)[0],
    valueLamports: (account.valueLamports as BN).toString(),
    valueSol: (account.valueLamports as BN).toNumber() / SOL,
    recipient: (account.recipient as PublicKey).toBase58(),
    executedAt: Number(account.executedAt),
    agent: account.agent.toBase58(),
  };
}

// ── routes ─────────────────────────────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  try {
    const balance = await client.connection.getBalance(client.authority());
    const vault = client.vaultPda();
    const vaultBalance = await client.connection.getBalance(vault);
    res.json({
      cluster: CLUSTER,
      programId: client.programId.toBase58(),
      payer: client.authority().toBase58(),
      payerBalanceSol: balance / SOL,
      agentPda: client.agentPda().toBase58(),
      vaultPda: vault.toBase58(),
      vaultBalanceSol: vaultBalance / SOL,
      policyAuthority: policyAuthority.publicKey.toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent", async (_req, res) => {
  try {
    const agent = await client.fetchAgentOrNull();
    if (!agent) return res.json({ exists: false });
    const vault = client.vaultPda();
    const vaultBalance = await client.connection.getBalance(vault);
    res.json({
      exists: true,
      pubkey: client.agentPda().toBase58(),
      authority: agent.authority.toBase58(),
      policyAuthority: (agent.policyAuthority as PublicKey).toBase58(),
      name: agent.name,
      maxValueLamports: (agent.policy.maxValueLamports as BN).toString(),
      maxValueSol: (agent.policy.maxValueLamports as BN).toNumber() / SOL,
      allowedActionsMask: agent.policy.allowedActionsMask,
      allowedActions: actionsFromMask(agent.policy.allowedActionsMask),
      windowSeconds: (agent.policy.windowSeconds as BN).toNumber(),
      maxPerWindow: agent.policy.maxPerWindow,
      countInWindow: agent.countInWindow,
      windowStartTs: (agent.windowStartTs as BN).toNumber(),
      intentCount: (agent.intentCount as BN).toNumber(),
      vaultPda: vault.toBase58(),
      vaultBalanceSol: vaultBalance / SOL,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/register", async (req, res) => {
  try {
    const {
      name,
      maxValueSol,
      allowedActions,
      windowSeconds,
      maxPerWindow,
    } = req.body as {
      name: string;
      maxValueSol: number;
      allowedActions: ActionTypeName[];
      windowSeconds?: number;
      maxPerWindow?: number;
    };
    const existing = await client.fetchAgentOrNull();
    if (existing) {
      return res
        .status(409)
        .json({ error: "agent already exists for this authority" });
    }
    const tx = await client.registerAgent({
      name,
      maxValueLamports: new BN(Math.floor(maxValueSol * SOL)),
      allowedActions,
      windowSeconds: windowSeconds ?? 0,
      maxPerWindow: maxPerWindow ?? 0,
      policyAuthority: policyAuthority.publicKey,
    });
    res.json({ ok: true, tx, agentPda: client.agentPda().toBase58() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/policy", async (req, res) => {
  try {
    const {
      maxValueSol,
      allowedActions,
      windowSeconds,
      maxPerWindow,
    } = req.body as {
      maxValueSol: number;
      allowedActions: ActionTypeName[];
      windowSeconds: number;
      maxPerWindow: number;
    };
    await ensurePolicyAuthorityFunded();
    const tx = await client.updatePolicy(
      {
        maxValueLamports: new BN(Math.floor(maxValueSol * SOL)),
        allowedActions,
        windowSeconds: windowSeconds ?? 0,
        maxPerWindow: maxPerWindow ?? 0,
      },
      policyAuthority
    );
    res.json({ ok: true, tx });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/agent/vault/fund", async (req, res) => {
  try {
    const { sol } = req.body as { sol: number };
    if (!sol || sol <= 0) {
      return res.status(400).json({ error: "sol must be > 0" });
    }
    const tx = await client.fundVault(new BN(Math.floor(sol * SOL)));
    const vaultBalance = await client.connection.getBalance(client.vaultPda());
    res.json({ ok: true, tx, vaultBalanceSol: vaultBalance / SOL });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/intent", async (req, res) => {
  try {
    const { action, valueSol, recipient, autoExecute } = req.body as {
      action: ActionTypeName;
      valueSol: number;
      recipient?: string | null;
      autoExecute?: boolean;
    };
    let recipientKey: PublicKey | null = null;
    if (recipient) {
      try {
        recipientKey = new PublicKey(recipient);
      } catch {
        return res.status(400).json({ error: "invalid recipient pubkey" });
      }
    }
    if (action === "Transfer" && !recipientKey) {
      return res.status(400).json({ error: "Transfer requires a recipient" });
    }

    const submit = await client.submitIntent({
      action,
      valueLamports: new BN(Math.floor(valueSol * SOL)),
      recipient: recipientKey,
    });
    const intent = await client.fetchIntent(submit.seq);
    const status = statusName(intent.status);

    let executeTx: string | null = null;
    let receipt: any = null;
    if (autoExecute && status === "Approved") {
      const exec = await client.executeIntent(submit.seq);
      executeTx = exec.tx;
      const r = await client.fetchReceipt(submit.seq);
      receipt = serializeReceipt(r, exec.receipt);
    }

    res.json({
      submitTx: submit.tx,
      seq: submit.seq.toNumber(),
      intent: serializeIntent(intent, submit.intent),
      executeTx,
      receipt,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/intent/:seq/execute", async (req, res) => {
  try {
    const seq = Number(req.params.seq);
    const exec = await client.executeIntent(seq);
    const r = await client.fetchReceipt(seq);
    res.json({
      ok: true,
      tx: exec.tx,
      receipt: serializeReceipt(r, exec.receipt),
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/intents", async (_req, res) => {
  try {
    const xs = await client.listIntents();
    res.json(xs.map((x) => serializeIntent(x.account, x.pubkey)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/receipts", async (_req, res) => {
  try {
    const xs = await client.listReceipts();
    res.json(xs.map((x) => serializeReceipt(x.account, x.pubkey)));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Basira demo server`);
  console.log(`  cluster:          ${CLUSTER}`);
  console.log(`  program:          ${client.programId.toBase58()}`);
  console.log(`  payer:            ${client.authority().toBase58()}`);
  console.log(`  policy authority: ${policyAuthority.publicKey.toBase58()}`);
  console.log(`\n  → http://localhost:${PORT}\n`);
});
