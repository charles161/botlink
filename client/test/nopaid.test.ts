/**
 * Lane FREE (founder, 16 Nov 2026: "we are gonna release without a paywall"): nothing the client can say mentions a
 * plan, a price, credits, an upgrade, billing or a payment, except the one answer that only a server with the paywall
 * on sends (409 plan_limit, client/src/limits.ts), which keeps its plain line for that build.
 *   - every string and template literal in client/src (tool descriptions, CLI help, status lines, tool output, errors),
 *     read with the TypeScript parser, so comments and code are not read
 *   - core.explain for every code the server sends on a member's call, except plan_limit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import * as core from "../src/core.js";
import { ApiError } from "../src/api.js";
import { limitText } from "../src/limits.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
// whole words; Pro and Team only with their capital; a currency sign before a number. Not "subscription": the client's
// event subscriptions (a wake address) are a feature, not a payment.
const PAID = [/\b(plans?|pricing|prices?|credits?|upgrade[sd]?|billing|payments?|per month)\b/i, /\b(Pro|Team)\b/, /[$€£₹¥]\s?\d/];
const paidWord = (s: string) => PAID.map((re) => re.exec(s)?.[0]).find(Boolean) ?? null;

/** Every literal text in a source file, with whether it sits in a `case "plan_limit":` clause. */
function literals(file: string): { text: string; planLimit: boolean; line: number }[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: { text: string; planLimit: boolean; line: number }[] = [];
  const inPlanLimit = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isCaseClause(p) && ts.isStringLiteral(p.expression) && p.expression.text === "plan_limit") return true;
    return false;
  };
  const visit = (n: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("…");
    if (text !== null && / /.test(text) && /[a-z]{3}/i.test(text)) out.push({ text, planLimit: inPlanLimit(n), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("no text in client/src mentions a plan, price, credits, an upgrade, billing or a payment (plan_limit's own lines aside)", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("mcp.ts") && files.includes("cli.ts") && files.includes("limits.ts"), "the tool descriptions, the CLI help and the limit lines are read");
  const hits: string[] = [];
  let kept = 0;
  for (const f of files) {
    for (const l of literals(join(SRC, f))) {
      const w = paidWord(l.text);
      if (!w) continue;
      if (l.planLimit && f === "limits.ts") { kept++; continue; }
      hits.push(`client/src/${f}:${l.line} "${w}" in ${JSON.stringify(l.text.slice(0, 120))}`);
    }
  }
  assert.deepEqual(hits, [], "say it without plans, prices, credits, upgrades, billing or payments: bot-link launches free");
  assert.ok(kept > 0, "limits.ts still has its plan_limit lines (kept for the build with the paywall on)");
});

test("core.explain: no answer the server sends on a member's call, other than plan_limit, gets paid words", () => {
  const src = readFileSync(join(SRC, "memberend.ts"), "utf8");
  const known = /const KNOWN = new Set\(\[([\s\S]*?)\]\);/.exec(src)?.[1] ?? "";
  const codes = [...known.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).concat(["gone", "room_gone", "unknown_key", "not_holder", "high_load", "stale_timestamp"]);
  assert.ok(codes.includes("storage_full") && codes.includes("room_full") && codes.includes("server_full"), "the codes are read from memberend.ts");
  for (const code of codes.filter((c) => c !== "plan_limit")) {
    for (const details of [null, { limit: "storage_ceiling", value: 64 }, { limit: "rooms", value: 20 }]) {
      const t = core.explain(new ApiError(409, code, "The server's own words.", details as any));
      assert.equal(paidWord(t), null, `${code}: ${t}`);
    }
  }
});

test("limitText: a plan_limit answer (paywall on) still gets its plain line", () => {
  for (const limit of ["storage_mb", "agents_per_room", "people_per_room", "rooms", "other"]) {
    const t = limitText(new ApiError(409, "plan_limit", "server text", { limit, value: 5 }));
    assert.ok(t && /plan/.test(t), `${limit}: ${t}`);
  }
  assert.match(limitText(new ApiError(409, "storage_full", "x", { value: 64 }))!, /64 MB/);
});
