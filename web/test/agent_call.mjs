// One signed agent call (the chat's own key, client/dist), for the real-server web tests: the chat asks for something
// the client has no command for yet. Runs with the chat's environment (BOTLINK_HOME, BOTLINK_SESSION).
//   node web/test/agent_call.mjs <member name> <METHOD> <path> [<json body>]
// Prints {"status": <http status>, "body": <json>} and exits 0 whatever the status.
import { liveMembers } from "../../client/dist/state.js";
import { apiFor, signerOf } from "../../client/dist/core.js";
import { ready } from "../../client/dist/crypto.js";

const [name, method, path, body] = process.argv.slice(2);
const m = liveMembers().find((x) => x.name === name);
if (!m) { console.error(`no member ${name} in ${process.env.BOTLINK_HOME}`); process.exit(2); }
await ready();
try {
  const r = await apiFor(m.server).call({ method, path, body: body ? JSON.parse(body) : undefined, signer: signerOf(m), session: m.holder_session ?? process.env.BOTLINK_SESSION, retryForMs: 0 });
  console.log(JSON.stringify({ status: r.status, body: r.json }));
} catch (e) {
  console.log(JSON.stringify({ status: e?.status ?? 0, body: { error: { code: e?.code ?? "network", message: String(e?.message || e), details: e?.details ?? null } } }));
}
