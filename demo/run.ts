/**
 * Basira end-to-end demo.
 *
 * Walks an audience through:
 *   1. Registering an agent with a risk policy
 *   2. Submitting an in-policy intent → approved → executed → on-chain receipt
 *   3. Submitting an over-limit intent → rejected (with reason)
 *   4. Submitting a forbidden action → rejected (with reason)
 *   5. Attempting to execute a rejected intent → blocked
 *
 * Usage:
 *   yarn demo                  # localnet (default)
 *   BASIRA_CLUSTER=devnet yarn demo
 */

import chalk from "chalk";
import { BN } from "@coral-xyz/anchor";
import {
  BasiraClient,
  ActionTypeName,
  actionsFromMask,
  statusName,
  rpcUrlForCluster,
  defaultKeypairPath,
} from "../sdk/src";

const SOL = 1_000_000_000;

// ── pretty-printing helpers ───────────────────────────────────────────────────

const tag = {
  step: (n: number, t: string) =>
    console.log("\n" + chalk.bold.cyan(`▶ Step ${n}: ${t}`)),
  ok: (s: string) => console.log(chalk.green("  ✓ ") + s),
  bad: (s: string) => console.log(chalk.red("  ✗ ") + s),
  info: (s: string) => console.log(chalk.gray("    " + s)),
  hdr: (s: string) =>
    console.log(
      "\n" +
        chalk.bgCyan.black(` ${s} `) +
        chalk.cyan(" ".repeat(Math.max(0, 60 - s.length)))
    ),
  divider: () => console.log(chalk.gray("─".repeat(70))),
};

function fmtSol(lamports: BN | number) {
  const n = typeof lamports === "number" ? lamports : lamports.toNumber();
  return chalk.yellow(`${(n / SOL).toFixed(2)} SOL`);
}

function shortAddr(pk: { toBase58: () => string }) {
  const s = pk.toBase58();
  return chalk.dim(`${s.slice(0, 4)}…${s.slice(-4)}`);
}

async function pause(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cluster = (process.env.BASIRA_CLUSTER ?? "localnet") as
    | "localnet"
    | "devnet"
    | "mainnet-beta";

  tag.hdr("BASIRA — Trust Layer for Agentic Solana");
  console.log(chalk.gray(`    cluster: ${cluster}`));
  console.log(chalk.gray(`    keypair: ${defaultKeypairPath()}`));

  const client = new BasiraClient({ rpcUrl: rpcUrlForCluster(cluster) });
  console.log(chalk.gray(`    program: ${client.programId.toBase58()}`));
  console.log(chalk.gray(`    payer:   ${client.authority().toBase58()}`));

  const balance = await client.connection.getBalance(client.authority());
  console.log(chalk.gray(`    balance: ${(balance / SOL).toFixed(4)} SOL`));
  if (balance < 0.05 * SOL) {
    tag.bad(
      "low balance — fund the keypair before continuing (`solana airdrop 2` on devnet/local)"
    );
    process.exit(1);
  }

  // ── Step 1: register agent (idempotent) ────────────────────────────────────

  tag.step(1, "Register an agent + on-chain risk policy");
  tag.info(`agent name:        "demo-agent"`);
  tag.info(`max value:         ${chalk.yellow("5 SOL")}`);
  tag.info(`allowed actions:   ${chalk.yellow("Transfer, Swap")}`);

  const existing = await client.fetchAgentOrNull();
  if (existing) {
    tag.ok(
      `agent already exists at ${shortAddr(client.agentPda())} — reusing`
    );
    tag.info(
      `policy: max ${fmtSol(
        existing.policy.maxValueLamports as BN
      )}, actions [${actionsFromMask(
        existing.policy.allowedActionsMask as number
      ).join(", ")}], intents so far: ${(
        existing.intentCount as BN
      ).toString()}`
    );
  } else {
    const tx = await client.registerAgent("demo-agent", new BN(5 * SOL), [
      "Transfer",
      "Swap",
    ]);
    tag.ok(`agent registered — tx ${shortAddr({ toBase58: () => tx })}`);
    tag.info(`agent PDA: ${client.agentPda().toBase58()}`);
  }

  // We always start scenarios from the *current* intent_count so the demo can
  // be re-run safely against a long-lived agent.
  let agent = await client.fetchAgent();
  let cursor = (agent.intentCount as BN).toNumber();

  // ── Scenario helpers ───────────────────────────────────────────────────────

  async function scenario(opts: {
    step: number;
    title: string;
    action: ActionTypeName;
    valueSol: number;
    expectApproved: boolean;
    execute?: boolean;
  }) {
    tag.step(opts.step, opts.title);
    tag.info(
      `action=${chalk.bold(opts.action)}  value=${fmtSol(
        opts.valueSol * SOL
      )}`
    );

    const { tx, intent, seq } = await client.submitIntent(
      opts.action,
      new BN(opts.valueSol * SOL)
    );
    tag.info(`submit tx:    ${shortAddr({ toBase58: () => tx })}`);
    tag.info(`intent #${seq.toString()} pda: ${shortAddr(intent)}`);

    const intentAccount = await client.fetchIntent(seq);
    const status = statusName(intentAccount.status);

    if (status === "Approved") {
      tag.ok(`policy decision: ${chalk.green.bold("APPROVED")}`);
    } else if (status === "Rejected") {
      tag.bad(
        `policy decision: ${chalk.red.bold("REJECTED")} — ${
          intentAccount.rejectionReason ?? ""
        }`
      );
    }

    if (opts.expectApproved && status !== "Approved") {
      throw new Error(`expected Approved, got ${status}`);
    }
    if (!opts.expectApproved && status !== "Rejected") {
      throw new Error(`expected Rejected, got ${status}`);
    }

    if (opts.execute && status === "Approved") {
      const exec = await client.executeIntent(seq);
      const receipt = await client.fetchReceipt(seq);
      tag.ok(
        `execution receipt written — pda ${shortAddr(exec.receipt)} tx ${shortAddr(
          { toBase58: () => exec.tx }
        )}`
      );
      tag.info(
        `receipt: agent=${shortAddr({
          toBase58: () => receipt.agent.toBase58(),
        })} value=${fmtSol(receipt.valueLamports as BN)} ts=${
          receipt.executedAt
        }`
      );
    }

    if (opts.execute && status !== "Approved") {
      try {
        await client.executeIntent(seq);
        throw new Error("execute should have failed for non-approved intent");
      } catch (e: any) {
        tag.ok(
          `execute correctly blocked: ${chalk.dim(
            (e.message || "").split("\n")[0].slice(0, 90)
          )}`
        );
      }
    }

    return seq;
  }

  // ── Scenarios ──────────────────────────────────────────────────────────────

  await scenario({
    step: 2,
    title: "In-policy transfer → APPROVED → executed → receipt",
    action: "Transfer",
    valueSol: 1,
    expectApproved: true,
    execute: true,
  });

  await pause(400);

  await scenario({
    step: 3,
    title: "Over-limit transfer → REJECTED (value > policy max)",
    action: "Transfer",
    valueSol: 10,
    expectApproved: false,
  });

  await pause(400);

  const rejectedSeq = await scenario({
    step: 4,
    title: "Forbidden action → REJECTED (action not in policy)",
    action: "ContractCall",
    valueSol: 1,
    expectApproved: false,
  });

  await pause(400);

  tag.step(5, "Try to execute the rejected intent → blocked");
  try {
    await client.executeIntent(rejectedSeq);
    tag.bad("expected execution to fail, but it succeeded");
  } catch (e: any) {
    tag.ok(
      `blocked by IntentNotApproved guard: ${chalk.dim(
        (e.message || "").split("\n")[0].slice(0, 90)
      )}`
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  tag.divider();
  tag.hdr(" SUMMARY ");

  agent = await client.fetchAgent();
  const intents = await client.listIntents();
  const receipts = await client.listReceipts();

  console.log(
    `  agent:    ${chalk.bold(agent.name)}  (${shortAddr(client.agentPda())})`
  );
  console.log(
    `  policy:   max=${fmtSol(
      agent.policy.maxValueLamports as BN
    )} actions=[${actionsFromMask(
      agent.policy.allowedActionsMask as number
    ).join(", ")}]`
  );
  console.log(
    `  intents:  ${chalk.bold(intents.length.toString())} total`
  );
  console.log(`  receipts: ${chalk.bold(receipts.length.toString())} on-chain`);

  console.log("\n  " + chalk.bold("Recent intents:"));
  for (const { account } of intents.slice(-6)) {
    const s = statusName(account.status);
    const colour =
      s === "Approved"
        ? chalk.green
        : s === "Executed"
        ? chalk.green
        : s === "Rejected"
        ? chalk.red
        : chalk.gray;
    console.log(
      `    #${(account.seq as BN).toString().padStart(2)}  ${colour(
        s.padEnd(9)
      )}  action=${Object.keys(account.actionType)[0].padEnd(13)} value=${fmtSol(
        account.valueLamports as BN
      )}` +
        (account.rejectionReason
          ? `  ${chalk.dim(`(${account.rejectionReason})`)}`
          : "")
    );
  }

  console.log("\n" + chalk.green.bold("✓ demo complete"));
  console.log(
    chalk.gray(
      `\n  view on explorer (cluster=${cluster}): https://explorer.solana.com/address/${client
        .agentPda()
        .toBase58()}?cluster=${cluster}`
    )
  );
}

main().catch((e) => {
  console.error(chalk.red("\n✗ demo failed:"), e);
  process.exit(1);
});
