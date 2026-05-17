// Basira demo — vanilla JS, talks to /api/* on the same origin.

const $ = (sel) => document.querySelector(sel);

const shortAddr = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "—");
const fmtSol = (n) => `${Number(n).toFixed(2)} SOL`;
const fmtTs = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
};

let lastIntentSig = null;
let lastReceiptSig = null;
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

// ── status / footer ───────────────────────────────────────────────────────────

async function loadStatus() {
  const s = await api("/api/status");
  cluster = s.cluster;
  $("#env").textContent = `${s.cluster} · ${shortAddr(s.payer)}`;
  $("#program-id").textContent = shortAddr(s.programId);
  $("#payer").textContent = shortAddr(s.payer);
  $("#balance").textContent = `${s.payerBalanceSol.toFixed(2)} SOL`;
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
          }),
        });
        await refresh();
      } catch (e) {
        alert("register failed: " + e.message);
      }
    });
    return;
  }

  el.innerHTML = `
    <div class="kv">
      <div class="k">name</div><div class="v"><strong>${agent.name}</strong></div>
      <div class="k">pda</div><div class="v"><a href="${explorerLink(
        "address",
        agent.pubkey
      )}" target="_blank"><code>${agent.pubkey}</code></a></div>
      <div class="k">authority</div><div class="v"><code>${shortAddr(
        agent.authority
      )}</code></div>
      <div class="k">policy max</div><div class="v">${fmtSol(
        agent.maxValueSol
      )} per intent</div>
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
          <th>#</th><th>action</th><th>value</th><th>status</th>
          <th>reason</th><th>submitted</th><th>pda</th><th></th>
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
          <th>intent #</th><th>action</th><th>value</th>
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

$("#intent-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const action = form.elements.action.value;
  const valueSol = Number(form.elements.value.value);
  const autoExecute = form.elements.autoExecute.checked;
  const btn = $("#submit-btn");
  const result = $("#last-result");
  btn.disabled = true;
  btn.textContent = "submitting…";
  result.textContent = "";
  try {
    const r = await api("/api/intent", {
      method: "POST",
      body: JSON.stringify({ action, valueSol, autoExecute }),
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
      )}</code>`;
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

// ── refresh loop ──────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStatus(), loadAgent(), loadIntents(), loadReceipts()]);
}

refresh().catch((e) => {
  console.error(e);
  $("#agent-body").innerHTML = `<div class="result-bad">api error: ${e.message}<br/><span class="muted">is the validator running and the program deployed?</span></div>`;
});

setInterval(() => {
  refresh().catch(() => {});
}, 4000);
