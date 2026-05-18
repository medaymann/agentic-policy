// Basira demo — vanilla JS, talks to /api/* on the same origin.

const $ = (sel) => document.querySelector(sel);

const shortAddr = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "—");
const fmtSol = (n) => `${Number(n).toFixed(4)} SOL`;
const fmtTs = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

let cluster = "localnet";

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function explorerLink(kind, value) {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (cluster === "localnet") {
    return `${base}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`;
  }
  return `${base}?cluster=${cluster}`;
}

// Generate a random pubkey-shaped string by creating a random Ed25519
// keypair via the SubtleCrypto + base58 encoder we ship below. Used only
// to populate the recipient field with a fresh demo address.
async function randomPubkeyB58() {
  // Generate 32 random bytes and base58-encode. Not a real keypair (we never
  // need the private key here), just a plausible-looking system-owned address.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b58encode(bytes);
}

// Tiny base58 encoder (Bitcoin alphabet).
const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = BigInt(0);
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHA[rem] + out;
  }
  return B58_ALPHA[0].repeat(zeros) + out;
}

// ── status / footer ───────────────────────────────────────────────────────────

async function loadStatus() {
  const s = await api("/api/status");
  cluster = s.cluster;
  $("#env").textContent = `${s.cluster} · ${shortAddr(s.payer)}`;
  $("#program-id").textContent = shortAddr(s.programId);
  $("#payer").textContent = shortAddr(s.payer);
  $("#balance").textContent = `${s.payerBalanceSol.toFixed(2)} SOL`;
  $("#vault").innerHTML = `<a href="${explorerLink(
    "address",
    s.vaultPda
  )}" target="_blank">${shortAddr(s.vaultPda)}</a> · ${s.vaultBalanceSol.toFixed(
    2
  )} SOL`;
  $("#policy-authority").textContent = shortAddr(s.policyAuthority);
}

// ── agent panel ───────────────────────────────────────────────────────────────

async function loadAgent() {
  const agent = await api("/api/agent");
  const el = $("#agent-body");

  if (!agent.exists) {
    el.innerHTML = `
      <div class="muted">No agent registered for this authority yet.</div>
      <form id="register-form">
        <label>Name<input name="name" value="demo-agent" /></label>
        <label>Max value (SOL)<input name="maxValueSol" type="number" min="0.1" step="0.1" value="5" /></label>
        <label>Window seconds<input name="windowSeconds" type="number" min="0" step="1" value="60" /></label>
        <label>Max per window<input name="maxPerWindow" type="number" min="0" step="1" value="3" /></label>
        <label class="check"><input type="checkbox" name="Transfer" checked /> Transfer</label>
        <label class="check"><input type="checkbox" name="Swap" checked /> Swap</label>
        <label class="check"><input type="checkbox" name="Stake" /> Stake</label>
        <label class="check"><input type="checkbox" name="ContractCall" /> ContractCall</label>
        <button type="submit">register agent</button>
      </form>
    `;
    $("#register-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      const allowedActions = [
        "Transfer",
        "Swap",
        "Stake",
        "ContractCall",
      ].filter((a) => form.elements[a].checked);
      try {
        await api("/api/agent/register", {
          method: "POST",
          body: JSON.stringify({
            name: form.elements.name.value,
            maxValueSol: Number(form.elements.maxValueSol.value),
            allowedActions,
            windowSeconds: Number(form.elements.windowSeconds.value),
            maxPerWindow: Number(form.elements.maxPerWindow.value),
          }),
        });
        await refresh();
      } catch (e) {
        alert("register failed: " + e.message);
      }
    });
    return;
  }

  const rateLimitLine =
    agent.windowSeconds > 0
      ? `${agent.countInWindow} / ${agent.maxPerWindow} in current ${agent.windowSeconds}s window`
      : `disabled`;

  el.innerHTML = `
    <div class="kv">
      <div class="k">name</div><div class="v"><strong>${agent.name}</strong></div>
      <div class="k">agent pda</div><div class="v"><a href="${explorerLink(
        "address",
        agent.pubkey
      )}" target="_blank"><code>${agent.pubkey}</code></a></div>
      <div class="k">authority</div><div class="v"><code>${shortAddr(
        agent.authority
      )}</code></div>
      <div class="k">policy authority</div><div class="v"><code>${shortAddr(
        agent.policyAuthority
      )}</code></div>
      <div class="k">vault pda</div><div class="v">
        <a href="${explorerLink("address", agent.vaultPda)}" target="_blank"><code>${shortAddr(
          agent.vaultPda
        )}</code></a>
        · ${fmtSol(agent.vaultBalanceSol)}
        <button id="fund-btn" class="inline">+ fund 1 SOL</button>
      </div>
      <div class="k">policy max</div><div class="v">${fmtSol(
        agent.maxValueSol
      )} per intent</div>
      <div class="k">rate limit</div><div class="v">${rateLimitLine}</div>
      <div class="k">intents</div><div class="v">${agent.intentCount}</div>
    </div>
    <div class="policy-row">
      ${["Transfer", "Swap", "Stake", "ContractCall"]
        .map(
          (a) =>
            `<span class="tag ${
              agent.allowedActions.includes(a) ? "allow" : ""
            }">${a}${agent.allowedActions.includes(a) ? " ✓" : ""}</span>`
        )
        .join("")}
    </div>
  `;

  $("#fund-btn").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "funding…";
    try {
      await api("/api/agent/vault/fund", {
        method: "POST",
        body: JSON.stringify({ sol: 1 }),
      });
      await refresh();
    } catch (e) {
      alert("fund failed: " + e.message);
      btn.disabled = false;
      btn.textContent = "+ fund 1 SOL";
    }
  });
}

// ── intents table ─────────────────────────────────────────────────────────────

async function loadIntents() {
  const xs = await api("/api/intents");
  const el = $("#intents");
  if (!xs.length) {
    el.innerHTML = `<div class="muted">no intents yet</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th><th>action</th><th>value</th><th>recipient</th>
          <th>status</th><th>reason</th><th>submitted</th><th>pda</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${xs
          .slice()
          .reverse()
          .map(
            (i) => `
          <tr data-seq="${i.seq}">
            <td>${i.seq}</td>
            <td>${i.actionType}</td>
            <td>${fmtSol(i.valueSol)}</td>
            <td class="muted-sm">${
              i.recipient && i.recipient !== SYSTEM_PROGRAM
                ? `<code>${shortAddr(i.recipient)}</code>`
                : "—"
            }</td>
            <td><span class="status ${i.status}">${i.status}</span></td>
            <td class="muted-sm">${i.rejectionReason ?? ""}</td>
            <td class="muted-sm">${fmtTs(i.submittedAt)}</td>
            <td><a href="${explorerLink(
              "address",
              i.pubkey
            )}" target="_blank"><code>${shortAddr(i.pubkey)}</code></a></td>
            <td class="row-action">${
              i.status === "Approved"
                ? `<button data-execute="${i.seq}">execute</button>`
                : ""
            }</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll("button[data-execute]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const seq = btn.dataset.execute;
      btn.disabled = true;
      btn.textContent = "executing…";
      try {
        await api(`/api/intent/${seq}/execute`, { method: "POST" });
        await refresh();
      } catch (e) {
        alert("execute failed: " + e.message);
        btn.disabled = false;
        btn.textContent = "execute";
      }
    });
  });
}

// ── receipts table ────────────────────────────────────────────────────────────

async function loadReceipts() {
  const xs = await api("/api/receipts");
  const el = $("#receipts");
  if (!xs.length) {
    el.innerHTML = `<div class="muted">no receipts yet</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>intent #</th><th>action</th><th>value</th><th>recipient</th>
          <th>executed</th><th>receipt pda</th>
        </tr>
      </thead>
      <tbody>
        ${xs
          .slice()
          .reverse()
          .map(
            (r) => `
          <tr>
            <td>${r.intentSeq}</td>
            <td>${r.actionType}</td>
            <td>${fmtSol(r.valueSol)}</td>
            <td class="muted-sm">${
              r.recipient && r.recipient !== SYSTEM_PROGRAM
                ? `<code>${shortAddr(r.recipient)}</code>`
                : "—"
            }</td>
            <td class="muted-sm">${fmtTs(r.executedAt)}</td>
            <td><a href="${explorerLink(
              "address",
              r.pubkey
            )}" target="_blank"><code>${shortAddr(r.pubkey)}</code></a></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// ── intent form ───────────────────────────────────────────────────────────────

function toggleRecipientField() {
  const action = document.querySelector("#intent-form select[name=action]").value;
  const row = $("#recipient-row");
  row.style.display = action === "Transfer" ? "" : "none";
}

document
  .querySelector("#intent-form select[name=action]")
  .addEventListener("change", toggleRecipientField);

$("#recipient-random").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const input = document.querySelector("#intent-form input[name=recipient]");
  input.value = await randomPubkeyB58();
});

$("#intent-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const action = form.elements.action.value;
  const valueSol = Number(form.elements.value.value);
  const recipient = form.elements.recipient.value.trim() || null;
  const autoExecute = form.elements.autoExecute.checked;
  const btn = $("#submit-btn");
  const result = $("#last-result");
  btn.disabled = true;
  btn.textContent = "submitting…";
  result.textContent = "";
  try {
    const r = await api("/api/intent", {
      method: "POST",
      body: JSON.stringify({ action, valueSol, recipient, autoExecute }),
    });
    const status = r.intent.status;
    const cls = status === "Rejected" ? "result-bad" : "result-ok";
    let html = `<span class="${cls}">intent #${r.seq} → <strong>${status}</strong></span>`;
    if (r.intent.rejectionReason) {
      html += ` — <span class="muted">${r.intent.rejectionReason}</span>`;
    }
    if (r.executeTx) {
      html += ` · executed → receipt <code>${shortAddr(
        r.receipt.pubkey
      )}</code> → recipient <code>${shortAddr(r.receipt.recipient)}</code>`;
    }
    result.innerHTML = html;
    await refresh();
  } catch (e) {
    result.innerHTML = `<span class="result-bad">error: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "submit";
  }
});

// ── policy update form ────────────────────────────────────────────────────────

$("#policy-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const btn = $("#policy-btn");
  const result = $("#policy-result");
  const allowedActions = ["Transfer", "Swap", "Stake", "ContractCall"].filter(
    (a) => form.elements[a].checked
  );
  btn.disabled = true;
  btn.textContent = "updating…";
  result.textContent = "";
  try {
    const r = await api("/api/agent/policy", {
      method: "POST",
      body: JSON.stringify({
        maxValueSol: Number(form.elements.maxValueSol.value),
        windowSeconds: Number(form.elements.windowSeconds.value),
        maxPerWindow: Number(form.elements.maxPerWindow.value),
        allowedActions,
      }),
    });
    result.innerHTML = `<span class="result-ok">policy updated · tx <code>${shortAddr(
      r.tx
    )}</code></span>`;
    await refresh();
  } catch (e) {
    result.innerHTML = `<span class="result-bad">error: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "update policy";
  }
});

// ── refresh loop ──────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStatus(), loadAgent(), loadIntents(), loadReceipts()]);
}

toggleRecipientField();
refresh().catch((e) => {
  console.error(e);
  $("#agent-body").innerHTML = `<div class="result-bad">api error: ${e.message}<br/><span class="muted">is the validator running and the program deployed?</span></div>`;
});

setInterval(() => {
  refresh().catch(() => {});
}, 4000);
