/**
 * A client change once ended a member on every HTTP 403, by status alone: a proxy, a firewall or a sign-in page in
 * between then ends members for good. Only bot-link's server's own JSON error shape with a final code ends a member
 * (memberend.ts). These checks fail if any 4xx without that shape, or with a code the table does not name, is final,
 * and if any code path calls endMember without isFinal on the same error first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ApiError } from "../src/api.js";
import { isFinal } from "../src/memberend.js";

// every code bot-link's server sends on a member's calls, the final ones among them, and some it never sends
const CODES = ["gone", "room_gone", "unknown_key", "not_holder", "bad_signature", "stale_timestamp", "replayed", "not_member", "forbidden",
  "not_found", "bad_request", "superseded", "rate_limited", "too_many_polls", "", "error", "access_denied", "blocked", "Forbidden", "403"];

test("no 4xx is final without bot-link's own error shape, whatever its status and code", () => {
  const wrong: string[] = [];
  for (let status = 400; status <= 499; status++) {
    for (const code of CODES) {
      if (isFinal(new ApiError(status, code, "x", null, null, null, false))) wrong.push(`${status} ${code || "(no code)"}`);
    }
  }
  assert.deepEqual(wrong, [], `ended a member by status without the server's JSON error shape (ApiError.shaped false); only the shape with a final code may end one (memberend.ts FINAL): ${wrong.slice(0, 10).join(", ")}`);
});

test("no status alone is final: with bot-link's shape, a code the server never sends is not final at any 4xx", () => {
  const wrong: string[] = [];
  for (let status = 400; status <= 499; status++) {
    for (const code of ["", "error", "access_denied", "blocked", "something_new"]) {
      if (isFinal(new ApiError(status, code, "x", null, null, null, true))) wrong.push(`${status} ${code || "(no code)"}`);
    }
  }
  assert.deepEqual(wrong, [], `ended a member by status alone (the code was not one memberend.ts FINAL names): ${wrong.slice(0, 10).join(", ")}`);
});

test("the final answers the server sends still end a member", () => {
  for (const [status, code] of [[410, "gone"], [410, "room_gone"], [401, "unknown_key"], [403, "not_holder"], [409, "not_holder"]] as const) {
    assert.ok(isFinal(new ApiError(status, code, "x", null, null, null, true)), `${status} ${code}`);
  }
});

test("every call of endMember in client/src is behind isFinal on the same error", () => {
  const src = join(import.meta.dirname, "..", "src");
  const wrong: string[] = [];
  let calls = 0;
  for (const f of readdirSync(src).filter((x) => x.endsWith(".ts") && x !== "memberend.ts")) {
    const lines = readFileSync(join(src, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bendMember\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        calls++;
        const guard = new RegExp(`\\bisFinal\\(\\s*${m[1]}\\s*\\)`);
        if (!lines.slice(Math.max(0, i - 3), i + 1).some((l) => guard.test(l))) wrong.push(`client/src/${f}:${i + 1}: ${line.trim()}`);
      }
      if (/\bendMember\(/.test(line) && !/\bendMember\(\s*[^,()]+(?:\([^()]*\))?\s*,\s*[A-Za-z_$][\w$]*\s*\)/.test(line) && !/import /.test(line)) {
        wrong.push(`client/src/${f}:${i + 1}: endMember called in a form this check cannot read: ${line.trim()}`);
      }
    });
  }
  assert.ok(calls >= 5, `found ${calls} calls of endMember; the scan is broken`);
  assert.deepEqual(wrong, [], `endMember must only run right after isFinal(e) on the same error (within the 3 lines above), so nothing ends a member by status alone:\n${wrong.join("\n")}`);
});
