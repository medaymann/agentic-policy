/**
 * Basira demo web server.
 *
 * Tiny Express app that exposes the SDK over HTTP and serves a single-page UI
 * from `web/public/`. Designed for live demos — refresh-friendly, idempotent
 * registration, and a JSON shape that's easy to render.
 */

import express from "express";
import path from "path";
import { BN } from "@coral-xyz/anchor";
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── helpers ────────────────────────────────────────────────────────────────────

function serializeIntent(account: any, pubkey: any) {
  return {
    pubkey: pubkey.toBase58(),
    seq: (account.seq as BN).toNumber(),
    actionType: Object.keys(account.actionType)[0],
    valueLamports: (account.valueLamports as BN).toString(),
    valueSol: (account.valueLamports as BN).toNumber() / SOL,
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
    executedAt: Number(account.executedAt),
    agent: account.agent.toBase58(),
  };
}

// ── routes ─────────────────────────────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  try {
    const balance = await client.connection.getBalance(client.authority());
    res.json({
      cluster: CLUSTER,
      programId: client.programId.toBase58(),
      payer: client.authority().toBase58(),
      payerBalanceSol: balance / SOL,
      agentPda: client.agentPda().toBase58(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/agent", async (_req, res) => {
  try {
    const agent = await client.fetchAgentOrNull();
    if (!agent) return res.json({ exists: false });
    res.json({
      exists: true,
      pubkey: client.agentPda().toBase58(),
      authority: agent.authority.toBase58(),
      name: agent.name,
      maxValueLamports: (agent.policy.maxValueLamports as BN).toString(),
      maxValueSol: (agent.policy.maxValueLamports as BN).toNumber() / SOL,
      allowedActionsMask: agent.policy.allowedActionsMask,
      allowedActions: actionsFromMask(agent.policy.allowedActionsMask),
      intentCount: (agent.intentCount as BN).toNumber(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/agent/register", async (req, res) => {
  try {
    const { name, maxValueSol, allowedActions } = req.body as {
      name: string;
      maxValueSol: number;
      allowedActions: ActionTypeName[];
    };
    const existing = await client.fetchAgentOrNull();
    if (existing) {
      return res
        .status(409)
        .json({ error: "agent already exists for this authority" });
    }
    const tx = await client.registerAgent(
      name,
      new BN(Math.floor(maxValueSol * SOL)),
      allowedActions
    );
    res.json({ ok: true, tx, agentPda: client.agentPda().toBase58() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/intent", async (req, res) => {
  try {
    const { action, valueSol, autoExecute } = req.body as {
      action: ActionTypeName;
      valueSol: number;
      autoExecute?: boolean;
    };
    const submit = await client.submitIntent(
      action,
      new BN(Math.floor(valueSol * SOL))
    );
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
  console.log(`  cluster:    ${CLUSTER}`);
  console.log(`  program:    ${client.programId.toBase58()}`);
  console.log(`  payer:      ${client.authority().toBase58()}`);
  console.log(`\n  → http://localhost:${PORT}\n`);
});
