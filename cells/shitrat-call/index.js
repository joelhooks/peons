// One test call from a celld cell: ask a SIP API to dial the operator's own
// number into a room; a voice worker already listening for that room joins and
// speaks the reason. Every provider and account value is a binding (see
// README.md); the callee is a binding, never request input.
//
// The dial is not idempotent (replay: unsafe). Each call id is one cell; its
// outcome row is written as "dialing" before the POST, so a retry or restart
// reads the row and never rings twice.

const CALL_ID = /^[a-z0-9-]{1,64}$/;

export class ShitratCall {
  constructor(state, env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS outcome (call_id TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL, detail TEXT)",
    );
  }

  read(callId) {
    return this.sql.exec("SELECT * FROM outcome WHERE call_id = ?", callId).toArray()[0];
  }

  settle(callId, state, detail) {
    this.sql.exec(
      "UPDATE outcome SET state = ?, at = ?, detail = ? WHERE call_id = ? AND state = 'dialing'",
      state,
      new Date().toISOString(),
      detail,
      callId,
    );
  }

  async fetch(request) {
    const { callId, reason, dryRun } = await request.json();
    const prior = this.read(callId);
    if (reason === undefined || prior) return Response.json({ replayed: Boolean(prior), outcome: prior ?? null });

    this.sql.exec(
      "INSERT INTO outcome (call_id, state, at, detail) VALUES (?, 'dialing', ?, NULL)",
      callId,
      new Date().toISOString(),
    );
    try {
      const res = await (dryRun ? probe(this.env) : dial(this.env, callId, reason));
      const body = await res.text();
      this.settle(callId, res.ok ? (dryRun ? "probed" : "answered") : "failed", `${res.status} ${body.slice(0, 300)}`);
    } catch (error) {
      this.settle(callId, "failed", String(error).slice(0, 300));
    }
    return Response.json({ replayed: false, outcome: this.read(callId) });
  }
}

// Proves egress and auth without dialing: one read call with an admin token.
async function probe(env) {
  const res = await fetch(env.SIP_PROBE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${await bearer(env, { admin: true })}`, "content-type": "application/json" },
    body: "{}",
  });
  return new Response(res.ok ? "probe ok" : res.statusText, { status: res.status });
}

async function dial(env, callId, reason) {
  return fetch(env.SIP_DIAL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${await bearer(env, { call: true })}`, "content-type": "application/json" },
    body: JSON.stringify({
      sip_trunk_id: env.SIP_TRUNK_ID,
      sip_call_to: env.CALLEE_NUMBER,
      room_name: `${env.ROOM_PREFIX}${callId}`,
      participant_identity: "callee",
      participant_name: "Callee",
      participant_attributes: { call_reason: reason },
      wait_until_answered: true,
    }),
  });
}

// A short-lived HS256 bearer token carrying a SIP grant.
async function bearer(env, sip) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (value) =>
    btoa(typeof value === "string" ? value : String.fromCharCode(...new Uint8Array(value)))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: env.SIP_API_KEY, sub: "shitrat-cell", nbf: now - 5, exp: now + 300, sip }));
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SIP_API_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/call") return new Response("not found", { status: 404 });
    let input = { callId: url.searchParams.get("id") ?? "" };
    if (request.method === "POST") {
      const { callId, reason, dryRun } = await request.json();
      if (typeof reason !== "string" || reason.trim() === "" || reason.length > 400)
        return new Response("reason: 1 to 400 characters", { status: 400 });
      input = { callId, reason: reason.trim(), dryRun: dryRun === true };
    } else if (request.method !== "GET") return new Response("method", { status: 405 });
    if (typeof input.callId !== "string" || !CALL_ID.test(input.callId))
      return new Response("callId: [a-z0-9-]{1,64}", { status: 400 });
    const stub = env.CALL.get(env.CALL.idFromName(input.callId));
    return stub.fetch("https://cell/call", { method: "POST", body: JSON.stringify(input) });
  },
};
