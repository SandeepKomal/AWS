// In-browser playground: a modelled AWS account with one fault per scenario.
// Visitors type aws CLI commands to find and fix the fault and watch the VPC,
// the access checks and the monthly cost change. It is a simulation: nothing
// here talks to AWS, and no real account, credential or bill is involved.
//
// The simulator (AQSim) has no DOM access so tests/check_playground.js can
// drive it under Node; the UI at the end only renders what the simulator says.
"use strict";

(function (root) {
  // AWS's documentation account IDs: obviously not real accounts.
  const ACCOUNT = "111122223333";
  const PARTNER = "444455556666";
  const REGION = "us-east-1";
  const START = Date.UTC(2026, 9, 30, 9, 0, 0);
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const LAPTOP = "192.0.2.44";

  // Illustrative us-east-1 on-demand list prices in USD. They change; the
  // site links to the official pricing pages and shows this date with them.
  const PRICES = {
    asOf: "June 2026",
    hours: 730,
    ec2: { "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832, "m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384, "c7i.8xlarge": 1.428 },
    vcpus: { "t3.micro": 2, "t3.small": 2, "t3.medium": 2, "t3.large": 2, "m5.large": 2, "m5.xlarge": 4, "m5.2xlarge": 8, "c7i.8xlarge": 32 },
    ebs: { gp3: 0.08, gp2: 0.10 }, snapshot: 0.05,
    natHour: 0.045, natGb: 0.045, ipv4Hour: 0.005,
    albHour: 0.0225, albLcuHour: 0.008,
    rds: { "db.t3.micro": 0.018, "db.t3.medium": 0.072 }, rdsGb: 0.115, rdsExtendedVcpuHour: 0.1,
    s3Gb: 0.023, logsStoreGb: 0.03, logsIngestGb: 0.50
  };

  // --- small helpers -----------------------------------------------------------

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hexOf(str, len) {
    let x = hash(str) || 1, s = "";
    while (s.length < len) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      s += x.toString(16).padStart(8, "0");
    }
    return s.slice(0, len);
  }
  // Resource IDs the way EC2 prints them: prefix, then 17 hex digits.
  const rid = (prefix, name) => `${prefix}-0${hexOf(prefix + name, 16)}`;
  // Practice key and principal IDs are built from a name and end in EXAMPLE,
  // like the examples in AWS's own documentation, so none can be a real key.
  const keyId = (kind, name) => kind + (String(name).toUpperCase().replace(/[^A-Z0-9]/g, "") + "XXXXXXXXX").slice(0, 9) + "EXAMPLE";
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const blob = (seed, len) => Array.from(hexOf(seed, len * 2).match(/../g), (h) => B64[parseInt(h, 16) % 64]).join("");
  const ts = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const ts3 = (ms) => new Date(ms).toISOString().replace(/Z$/, "+00:00");
  const json = (v) => JSON.stringify(v, null, 4);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const pascal = (op) => op.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("").replace(/^ListObjects$/, "ListObjectsV2");
  const money = (n) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // IPv4 helpers for routes, security groups and NACLs.
  const ipNum = (ip) => String(ip).split(".").reduce((n, o) => n * 256 + Number(o), 0);
  function inCidr(ip, cidr) {
    if (!cidr || !ip) return false;
    const [base, bits] = cidr.split("/");
    const b = Number(bits);
    if (b === 0) return true;
    const size = 2 ** (32 - b);
    return Math.floor(ipNum(ip) / size) === Math.floor(ipNum(base) / size);
  }
  const validCidr = (c) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.test(c || "") && c.split("/")[0].split(".").every((o) => Number(o) < 256);

  // --- the command line --------------------------------------------------------

  // Split a line like bash: quotes, &&, ||, ;, | and > redirects, with $VAR
  // and ${VAR} expanded outside single quotes. Returns null on an open quote.
  function lex(line, env) {
    const out = [];
    let cur = "", q = null, has = false;
    const push = () => { if (cur || has) out.push({ w: cur }); cur = ""; has = false; };
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const v = env && ch === "$" && q !== "'" ? /^\$(?:\{(\w+)\}|(\w+))/.exec(line.slice(i)) : null;
      if (v) { cur += env[v[1] || v[2]] ?? ""; has = true; i += v[0].length - 1; continue; }
      if (q) {
        if (ch === q) q = null;
        else if (ch === "\\" && q === '"' && /["\\$`]/.test(line[i + 1] || "")) cur += line[++i];
        else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
      if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
      if (/\s/.test(ch)) { push(); continue; }
      const two = line.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ">>") { push(); out.push({ op: two }); i++; continue; }
      if (ch === ";" || ch === "|" || ch === ">") { push(); out.push({ op: ch }); continue; }
      cur += ch;
    }
    if (q) return null;
    push();
    return out;
  }
  const words = (s) => (lex(s) || []).filter((t) => "w" in t).map((t) => t.w);

  // --- a JMESPath subset for --query -------------------------------------------
  // Fields, [n], [], [*], [?a=='b'], .{A: a}, .[a, b], pipes, literals and
  // length / contains / starts_with: what people write with the aws CLI.

  function jmesTokens(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      let m;
      if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)))) { out.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
      if ((m = /^-?\d+/.exec(src.slice(i)))) { out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue; }
      if (ch === '"' || ch === "'" || ch === "`") {
        const end = src.indexOf(ch, i + 1);
        if (end < 0) throw new Error(`Unclosed ${ch} delimiter`);
        const raw = src.slice(i + 1, end);
        if (ch === '"') out.push({ t: "id", v: raw });
        else if (ch === "'") out.push({ t: "lit", v: raw });
        else { try { out.push({ t: "lit", v: JSON.parse(raw) }); } catch { out.push({ t: "lit", v: raw }); } }
        i = end + 1;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (["||", "&&", "==", "!=", "<=", ">="].includes(two)) { out.push({ t: two }); i += 2; continue; }
      if ("[]{}().,:|!<>@*&?".includes(ch)) { out.push({ t: ch }); i++; continue; }
      throw new Error(`Unknown token: ${ch}`);
    }
    return out;
  }

  function jmesParse(src) {
    const toks = jmesTokens(src);
    let p = 0;
    const peek = (k = 0) => toks[p + k] || { t: "eof" };
    const eat = (t) => { if (peek().t !== t) throw new Error(`Expecting ${t}, got: ${peek().t}`); return toks[p++]; };
    function expr() {
      let left = orExpr();
      while (peek().t === "|") { p++; left = { k: "pipe", l: left, r: orExpr() }; }
      return left;
    }
    function orExpr() { let l = andExpr(); while (peek().t === "||") { p++; l = { k: "or", l, r: andExpr() }; } return l; }
    function andExpr() { let l = cmpExpr(); while (peek().t === "&&") { p++; l = { k: "and", l, r: cmpExpr() }; } return l; }
    function cmpExpr() {
      if (peek().t === "!") { p++; return { k: "not", e: cmpExpr() }; }
      const l = chain();
      if (["==", "!=", "<", "<=", ">", ">="].includes(peek().t)) return { k: "cmp", op: toks[p++].t, l, r: chain() };
      return l;
    }
    function list(close) {
      const items = [];
      do { items.push(expr()); } while (peek().t === "," && p++);
      eat(close);
      return items;
    }
    // A chain is a list of steps; [] splits it into flattened segments.
    function chain() {
      const steps = [];
      const t = peek();
      if (t.t === "id" && peek(1).t === "(") {
        p += 2;
        const args = peek().t === ")" ? (p++, []) : list(")");
        steps.push({ s: "fn", name: t.v, args });
      } else if (t.t === "id") { p++; steps.push({ s: "field", v: t.v }); }
      else if (t.t === "lit" || t.t === "num") { p++; steps.push({ s: "lit", v: t.v }); }
      else if (t.t === "@") p++;
      else if (t.t === "*") { p++; steps.push({ s: "values" }); }
      else if (t.t === "(") { p++; steps.push({ s: "sub", e: expr() }); eat(")"); }
      else if (t.t === "{") { p++; steps.push(hash()); }
      else if (t.t === "[") bracket(steps, true);
      else throw new Error(`Invalid token: ${t.t}`);
      for (;;) {
        if (peek().t === ".") {
          p++;
          const n = peek();
          if (n.t === "id") { p++; steps.push({ s: "field", v: n.v }); }
          else if (n.t === "*") { p++; steps.push({ s: "values" }); }
          else if (n.t === "{") { p++; steps.push(hash()); }
          else if (n.t === "[") { p++; steps.push({ s: "multi", items: list("]") }); }
          else throw new Error(`Expecting identifier after "."`);
        } else if (peek().t === "[") bracket(steps, false);
        else return steps;
      }
    }
    function hash() {
      const pairs = [];
      do {
        const key = eat("id").v;
        eat(":");
        pairs.push([key, expr()]);
      } while (peek().t === "," && p++);
      eat("}");
      return { s: "hash", pairs };
    }
    function bracket(steps, first) {
      p++;
      const t = peek();
      if (t.t === "]") { p++; steps.push({ s: "flatten" }); return; }
      if (t.t === "*" && peek(1).t === "]") { p += 2; steps.push({ s: "wild" }); return; }
      if (t.t === "?") { p++; const e = expr(); eat("]"); steps.push({ s: "filter", e }); return; }
      if (t.t === "num" && peek(1).t === "]") { p += 2; steps.push({ s: "index", v: t.v }); return; }
      if (!first) throw new Error("Invalid bracket expression");
      steps.push({ s: "multi", items: list("]") });
    }
    const ast = expr();
    if (p < toks.length) throw new Error(`Unexpected token: ${peek().t}`);
    return ast;
  }

  const truthy = (v) => !(v === null || v === undefined || v === false || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && v && !Array.isArray(v) && !Object.keys(v).length));
  function jmesEval(node, v) {
    if (Array.isArray(node)) return evalChain(node, v);
    switch (node.k) {
      case "pipe": return jmesEval(node.r, jmesEval(node.l, v));
      case "or": { const l = jmesEval(node.l, v); return truthy(l) ? l : jmesEval(node.r, v); }
      case "and": { const l = jmesEval(node.l, v); return truthy(l) ? jmesEval(node.r, v) : l; }
      case "not": return !truthy(jmesEval(node.e, v));
      case "cmp": {
        const l = jmesEval(node.l, v), r = jmesEval(node.r, v);
        if (node.op === "==") return JSON.stringify(l) === JSON.stringify(r);
        if (node.op === "!=") return JSON.stringify(l) !== JSON.stringify(r);
        if (typeof l !== "number" || typeof r !== "number") return null;
        return { "<": l < r, "<=": l <= r, ">": l > r, ">=": l >= r }[node.op];
      }
    }
    return null;
  }
  // Steps run left to right; [*] and filters project the rest of the segment
  // over a list, and [] flattens what came before and projects the rest.
  function evalChain(steps, v) {
    const cut = steps.map((s) => s.s).lastIndexOf("flatten");
    if (cut < 0) return evalSegment(steps, v);
    const left = evalChain(steps.slice(0, cut), v);
    if (!Array.isArray(left)) return null;
    const flat = left.flatMap((x) => (Array.isArray(x) ? x : [x]));
    const rest = steps.slice(cut + 1);
    return rest.length ? flat.map((x) => evalSegment(rest, x)).filter((x) => x !== null && x !== undefined) : flat;
  }
  function evalSegment(steps, v) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.s === "wild" || s.s === "filter" || s.s === "values") {
        let list = s.s === "values" ? (v && typeof v === "object" && !Array.isArray(v) ? Object.values(v) : null) : Array.isArray(v) ? v : null;
        if (!list) return null;
        if (s.s === "filter") list = list.filter((x) => truthy(jmesEval(s.e, x)));
        const rest = steps.slice(i + 1);
        return list.map((x) => evalSegment(rest, x)).filter((x) => x !== null && x !== undefined);
      }
      if (s.s === "lit") { v = s.v; continue; }
      if (s.s === "sub") { v = jmesEval(s.e, v); continue; }
      if (s.s === "fn") { v = callFn(s.name, s.args.map((e) => jmesEval(e, v))); continue; }
      if (v === null || v === undefined) return null;
      if (s.s === "field") v = typeof v === "object" && !Array.isArray(v) ? (v[s.v] ?? null) : null;
      else if (s.s === "index") v = Array.isArray(v) ? (v[s.v < 0 ? v.length + s.v : s.v] ?? null) : null;
      else if (s.s === "multi") { const cur = v; v = s.items.map((e) => jmesEval(e, cur)); }
      else if (s.s === "hash") { const cur = v; v = Object.fromEntries(s.pairs.map(([k, e]) => [k, jmesEval(e, cur)])); }
    }
    return v === undefined ? null : v;
  }
  function callFn(name, args) {
    const [a, b] = args;
    if (name === "length") return a === null ? null : typeof a === "string" || Array.isArray(a) ? a.length : typeof a === "object" ? Object.keys(a).length : null;
    if (name === "contains") return a === null ? false : typeof a === "string" ? a.includes(b) : Array.isArray(a) ? a.some((x) => JSON.stringify(x) === JSON.stringify(b)) : false;
    if (name === "starts_with") return typeof a === "string" && typeof b === "string" && a.startsWith(b);
    if (name === "to_string") return typeof a === "string" ? a : JSON.stringify(a);
    throw new Error(`Unknown function: ${name}()`);
  }
  function query(expr, data) {
    return jmesEval(jmesParse(expr), data);
  }

  // --output text, as the CLI lays it out: a row of scalars per object,
  // sorted by key, nested lists headed by their key in capitals.
  function textOut(v, id, out = []) {
    const scalar = (x) => x === null || typeof x !== "object";
    const str = (x) => (x === null || x === undefined ? "None" : x === true ? "True" : x === false ? "False" : String(x));
    if (scalar(v)) out.push(str(v));
    else if (Array.isArray(v)) {
      if (v.every(scalar)) { if (v.length) out.push([id && id.toUpperCase(), ...v.map(str)].filter(Boolean).join("\t")); }
      else v.forEach((x) => (scalar(x) ? out.push(str(x)) : textOut(x, id, out)));
    } else {
      const keys = Object.keys(v).sort();
      const sc = keys.filter((k) => scalar(v[k]));
      if (sc.length) out.push([id && id.toUpperCase(), ...sc.map((k) => str(v[k]))].filter(Boolean).join("\t"));
      for (const k of keys.filter((k) => !scalar(v[k]))) textOut(v[k], k, out);
    }
    return out;
  }

  // Shorthand syntax: Key=a,Values=b,c  and  [{...}] or JSON.
  function shorthand(s) {
    s = String(s).trim();
    if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { /* fall through to shorthand */ } }
    const obj = {};
    const re = /([A-Za-z][\w.:-]*)=(\[[^\]]*\]|\{[^}]*\}|[^=]*?)(?=,[A-Za-z][\w.:-]*=|$)/g;
    let m, any = false;
    while ((m = re.exec(s))) {
      any = true;
      let val = m[2];
      if (/^\[.*\]$/.test(val)) val = val.slice(1, -1).split(",").filter(Boolean);
      else if (/^\{.*\}$/.test(val)) val = shorthand(val.slice(1, -1));
      else if (val.includes(",")) val = val.split(",");
      obj[m[1]] = val;
    }
    return any ? obj : null;
  }

  // --- IAM: policies and the evaluation logic ----------------------------------

  const AWS_POLICIES = {
    AdministratorAccess: [{ Effect: "Allow", Action: "*", Resource: "*" }],
    PowerUserAccess: [{ Effect: "Allow", NotAction: ["iam:*", "organizations:*", "account:*"], Resource: "*" },
      { Effect: "Allow", Action: ["iam:CreateServiceLinkedRole", "iam:ListRoles", "organizations:DescribeOrganization"], Resource: "*" }],
    ReadOnlyAccess: [{ Effect: "Allow", Action: ["ec2:Describe*", "s3:Get*", "s3:List*", "iam:Get*", "iam:List*", "rds:Describe*", "elasticloadbalancing:Describe*", "cloudwatch:Describe*", "cloudwatch:Get*", "logs:Describe*", "logs:Get*", "lambda:Get*", "lambda:List*", "route53:Get*", "route53:List*", "kms:Describe*", "kms:List*", "autoscaling:Describe*", "cloudtrail:Describe*", "cloudtrail:Get*", "cloudtrail:LookupEvents"], Resource: "*" }],
    AmazonS3ReadOnlyAccess: [{ Effect: "Allow", Action: ["s3:Get*", "s3:List*", "s3:Describe*", "s3-object-lambda:Get*", "s3-object-lambda:List*"], Resource: "*" }],
    AmazonS3FullAccess: [{ Effect: "Allow", Action: ["s3:*", "s3-object-lambda:*"], Resource: "*" }],
    AmazonEC2FullAccess: [{ Effect: "Allow", Action: ["ec2:*", "elasticloadbalancing:*", "cloudwatch:*", "autoscaling:*"], Resource: "*" }],
    AmazonSSMManagedInstanceCore: [{ Effect: "Allow", Action: ["ssm:UpdateInstanceInformation", "ssm:GetParameter*", "ssmmessages:*", "ec2messages:*"], Resource: "*" }],
    AWSLambdaVPCAccessExecutionRole: [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DeleteNetworkInterface"], Resource: "*" }],
    IAMFullAccess: [{ Effect: "Allow", Action: ["iam:*", "organizations:DescribeAccount", "organizations:ListPolicies"], Resource: "*" }]
  };
  const awsPolicyArn = (name) => `arn:aws:iam::aws:policy/${name}`;
  const doc = (...Statement) => ({ Version: "2012-10-17", Statement });
  const trustService = (svc) => doc({ Effect: "Allow", Principal: { Service: svc }, Action: "sts:AssumeRole" });

  const asList = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
  function glob(pattern, value, ci) {
    const esc = (s) => s.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
    const re = "^" + String(pattern).split("*").map((p) => p.split("?").map(esc).join(".")).join(".*") + "$";
    return new RegExp(re, ci ? "is" : "s").test(String(value));
  }
  const subst = (pattern, keys) => String(pattern).replace(/\$\{([\w:/-]+)\}/g, (m, k) => (keys[k] !== undefined ? keys[k] : m));

  // Condition operators. A missing key fails a positive test and passes a
  // negated one, as in IAM; ...IfExists passes when the key is absent.
  function conditionHolds(cond, keys) {
    for (const [rawOp, block] of Object.entries(cond || {})) {
      const op = rawOp.replace(/^(ForAnyValue|ForAllValues):/, "");
      const ifExists = op.endsWith("IfExists");
      const base = op.replace(/IfExists$/, "");
      for (const [rawKey, want] of Object.entries(block || {})) {
        const key = Object.keys(keys).find((k) => k.toLowerCase() === rawKey.toLowerCase());
        const have = key === undefined ? undefined : keys[key];
        const wants = asList(want).map(String);
        if (base === "Null") { if ((have === undefined) !== (wants[0] === "true")) return false; continue; }
        const negated = /Not/.test(base);
        if (have === undefined) { if (ifExists || negated) continue; return false; }
        const haves = asList(have).map(String);
        const any = (fn) => haves.some((h) => wants.some((w) => fn(h, w)));
        let ok;
        switch (base) {
          case "StringEquals": case "ArnEquals": case "StringNotEquals": case "ArnNotEquals": ok = any((h, w) => h === w); break;
          case "StringEqualsIgnoreCase": ok = any((h, w) => h.toLowerCase() === w.toLowerCase()); break;
          case "StringLike": case "ArnLike": case "StringNotLike": case "ArnNotLike": ok = any((h, w) => glob(w, h)); break;
          case "Bool": ok = any((h, w) => h.toLowerCase() === w.toLowerCase()); break;
          case "IpAddress": case "NotIpAddress": ok = any((h, w) => inCidr(h, w.includes("/") ? w : w + "/32")); break;
          case "NumericLessThan": ok = any((h, w) => Number(h) < Number(w)); break;
          case "NumericLessThanEquals": ok = any((h, w) => Number(h) <= Number(w)); break;
          case "NumericGreaterThan": ok = any((h, w) => Number(h) > Number(w)); break;
          case "NumericEquals": ok = any((h, w) => Number(h) === Number(w)); break;
          default: return false;
        }
        if (negated ? ok : !ok) return false;
      }
    }
    return true;
  }

  // How a Principal element matches the caller: "direct" names it, "account"
  // names its whole account (which hands the decision to that account's IAM).
  function principalMatch(P, who) {
    if (P === "*") return "direct";
    if (!P || typeof P !== "object") return null;
    if (asList(P.Service).includes(who.service)) return "direct";
    if (asList(P.Federated).includes(who.federated)) return "direct";
    let best = null;
    for (const p of asList(P.AWS)) {
      if (p === "*") return "direct";
      if (who.service) continue;
      if (p === who.arn || p === who.baseArn || p === who.uniqueId) return "direct";
      if (p === who.account || p === `arn:aws:iam::${who.account}:root`) best = best || "account";
    }
    return best;
  }

  function statementMatches(st, req, resourceBased) {
    const actions = st.NotAction !== undefined ? asList(st.NotAction) : asList(st.Action);
    const hit = actions.some((a) => glob(a, req.action, true));
    if (st.NotAction !== undefined ? hit : !hit) return null;
    if (req.resource !== undefined && (st.Resource !== undefined || st.NotResource !== undefined)) {
      const res = st.NotResource !== undefined ? asList(st.NotResource) : asList(st.Resource);
      const rhit = res.some((r) => glob(subst(r, req.keys), req.resource));
      if (st.NotResource !== undefined ? rhit : !rhit) return null;
    }
    let how = "direct";
    if (resourceBased) {
      if (st.NotPrincipal !== undefined) how = principalMatch(st.NotPrincipal, req.who) ? null : "direct";
      else how = principalMatch(st.Principal, req.who);
      if (!how) return null;
    }
    return conditionHolds(st.Condition, req.keys) ? how : null;
  }
  const stmts = (d) => (d && typeof d === "object" ? asList(d.Statement) : []);
  function scan(docs, req, resourceBased) {
    let deny = null, allow = null;
    for (const d of docs) {
      for (const st of stmts(d)) {
        const how = statementMatches(st, req, resourceBased);
        if (!how) continue;
        if (st.Effect === "Deny") deny = deny || how;
        else if (st.Effect === "Allow") allow = allow === "direct" ? allow : how;
      }
    }
    return { deny, allow };
  }
  const parseDoc = (d) => { if (!d) return null; if (typeof d === "object") return d; try { return JSON.parse(d); } catch { return null; } };

  // The policy evaluation logic, for one account: explicit deny anywhere wins;
  // SCPs and permission boundaries cap what is allowed; KMS needs the key
  // policy; across accounts both sides must allow.
  function evaluate(a, who, action, resource, opt = {}) {
    const keys = { "aws:PrincipalArn": who.baseArn || who.arn, "aws:PrincipalAccount": who.account, "aws:RequestedRegion": opt.region || REGION,
      "aws:SecureTransport": "true", "aws:SourceIp": opt.sourceIp || LAPTOP, ...(who.name ? { "aws:username": who.name } : {}), ...(opt.keys || {}) };
    const req = { action, resource, keys, who };
    const res = parseDoc(opt.resPolicy);
    const ids = who.root || who.service ? [] : a.identityDocs(who);
    const sameAccount = who.account === (opt.resAccount || ACCOUNT);
    const scp = who.account === ACCOUNT && !who.service ? a.scps.map(parseDoc) : [];
    const no = (why) => ({ allowed: false, why });
    if (scan(scp, req).deny) return no("with an explicit deny in a service control policy");
    const idScan = scan(ids, req);
    if (idScan.deny) return no("with an explicit deny in an identity-based policy");
    const resScan = res ? scan([res], req, true) : { deny: null, allow: null };
    if (resScan.deny) return no("with an explicit deny in a resource-based policy");
    const boundary = who.boundary ? parseDoc(a.policyDoc(who.boundary)) : null;
    if (scp.length && !scan(scp, req).allow) return no(`because no service control policy allows the ${action} action`);
    const idAllow = who.root || Boolean(idScan.allow);
    if (opt.kms) {
      if (!resScan.allow) return no(`because no resource-based policy allows the ${action} action`);
      if (resScan.allow === "account" && !idAllow) return no(`because no identity-based policy allows the ${action} action`);
    } else if (!sameAccount) {
      if (!resScan.allow) return no(`because no resource-based policy allows the ${action} action`);
      if (!idAllow) return no(`because no identity-based policy allows the ${action} action`);
    } else if (!idAllow && resScan.allow !== "direct") {
      return no(`because no identity-based policy allows the ${action} action`);
    }
    if (boundary && !scan([boundary], req).allow && resScan.allow !== "direct") return no(`because no permissions boundary allows the ${action} action`);
    return { allowed: true };
  }

  // --- what runs on the instances ------------------------------------------------

  // ports: what the app listens on; paths: what an HTTP GET returns.
  const SHOP_PAGE = "<!doctype html><title>Quest Kitchen</title><h1>Order dinner</h1>";
  const APPS = {
    shop: { ports: [8080], paths: { "/": [200, SHOP_PAGE], "/health": [200, "ok"], "/preview": [200, ""] } },
    blog: { ports: [80, 22], paths: { "/": [200, "<!doctype html><title>Kitchen notes</title><h1>Kitchen notes</h1>"] } },
    worker: { ports: [22], paths: {} },
    batch: { ports: [22], paths: {} },
    bastion: { ports: [22], paths: {} },
    pgsql: { ports: [5432], paths: {} }
  };
  const ALB_PAGE = (code, text) => `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n</body>\n</html>`;
  const S3_ERR = (code, msg, extra = "") => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${msg}</Message>${extra}<RequestId>${hexOf(code + msg, 16).toUpperCase()}</RequestId><HostId>${blob(code, 40)}=</HostId></Error>`;
  const EXTERNAL = { "api.github.com": "140.82.112.5", "pypi.org": "151.101.0.223", "checkip.amazonaws.com": "52.4.112.30" };
  const S3_IP = "52.216.40.12";
  const S3_PREFIX_LIST = "pl-63a5400a";
  const ALB_ZONE = "Z35SXDOTRQ7X7K";
  const EPHEMERAL = 49152;
  const PUBLIC_IP = (n) => `203.0.113.${n}`;

  class AwsError extends Error {
    constructor(code, message, retries) { super(message); this.code = code; this.retries = retries; }
  }

  // --- the simulated account -------------------------------------------------------

  class Account {
    constructor(scenario) {
      this.scenario = scenario;
      this.now = START;
      this.seq = 0;
      this.files = { ...(scenario.files || {}) };
      this.env = {};
      this.history = [];
      this.notifications = [];
      this.session = null;
      this.base();
      if (scenario.setup) scenario.setup(this);
      this.lastMonth = this.costItems();
    }

    // The shared starting point: one VPC across two AZs, an ALB in front of two
    // web servers, a Postgres database, a few buckets and the IAM to run it.
    base() {
      const vpc = rid("vpc", "kitchen");
      this.vpcs = [{ id: vpc, name: "kitchen", cidr: "10.0.0.0/16" }];
      this.igws = [{ id: rid("igw", "kitchen"), name: "kitchen-igw", vpc }];
      const subnet = (name, cidr, az, pub) => ({ id: rid("subnet", name), name, cidr, az, vpc, mapPublic: pub });
      this.subnets = [subnet("public-a", "10.0.1.0/24", "us-east-1a", true), subnet("public-b", "10.0.2.0/24", "us-east-1b", true),
        subnet("private-a", "10.0.11.0/24", "us-east-1a", false), subnet("private-b", "10.0.12.0/24", "us-east-1b", false)];
      this.eips = [];
      this.nats = [];
      const natEip = this.addEip("nat-a-eip", 200);
      this.nats.push({ id: rid("nat", "nat-a"), name: "nat-a", subnet: this.sub("public-a").id, alloc: natEip.alloc, state: "available", created: START - 200 * DAY });
      natEip.assoc = this.nats[0].id;
      this.rts = [
        { id: rid("rtb", "main"), name: "kitchen-main", vpc, main: true, subnets: [], routes: [{ dest: "10.0.0.0/16", target: "local" }] },
        { id: rid("rtb", "public"), name: "public-rt", vpc, subnets: [this.sub("public-a").id, this.sub("public-b").id], routes: [{ dest: "10.0.0.0/16", target: "local" }, { dest: "0.0.0.0/0", target: this.igws[0].id }] },
        { id: rid("rtb", "private"), name: "private-rt", vpc, subnets: [this.sub("private-a").id, this.sub("private-b").id], routes: [{ dest: "10.0.0.0/16", target: "local" }, { dest: "0.0.0.0/0", target: this.nats[0].id }] }
      ];
      const allowAll = (egress) => [{ n: 100, egress, proto: "-1", from: 0, to: 65535, cidr: "0.0.0.0/0", action: "allow" }];
      this.nacls = [{ id: rid("acl", "default"), name: "", vpc, isDefault: true, subnets: this.subnets.map((s) => s.id), entries: [...allowAll(false), ...allowAll(true)] }];
      this.endpoints = [];
      this.sgs = [];
      this.addSg("default", "default VPC security group", []);
      this.addSg("alb-sg", "Public load balancer", [{ proto: "tcp", from: 80, to: 80, cidr: "0.0.0.0/0" }, { proto: "tcp", from: 443, to: 443, cidr: "0.0.0.0/0" }]);
      this.addSg("web-sg", "Web servers", [{ proto: "tcp", from: 8080, to: 8080, sg: this.sgId("alb-sg"), desc: "from the load balancer" }]);
      this.addSg("db-sg", "Orders database", [{ proto: "tcp", from: 5432, to: 5432, sg: this.sgId("web-sg"), desc: "from the web servers" }]);
      this.instances = [];
      this.volumes = [];
      this.snapshots = [];
      this.amis = [];
      this.addInstance({ name: "web-1", type: "t3.small", subnet: "private-a", sgs: ["web-sg"], ip: "10.0.11.21", app: "shop", role: "web-role", tags: { env: "prod" } });
      this.addInstance({ name: "web-2", type: "t3.small", subnet: "private-b", sgs: ["web-sg"], ip: "10.0.12.22", app: "shop", role: "web-role", tags: { env: "prod" } });
      this.tgs = [];
      this.albs = [];
      this.addTg("web-tg", 8080, "/health", ["web-1", "web-2"]);
      this.addAlb("shop-alb", "web-tg");
      this.asgs = [{ name: "web-asg", min: 2, max: 4, desired: 2, instances: [this.inst("web-1").id, this.inst("web-2").id], tgs: [this.tgs[0].arn],
        lt: { type: "t3.small", app: "shop", subnets: ["private-a", "private-b"], sgs: ["web-sg"], role: "web-role" }, policies: [], activities: [], created: START - 90 * DAY }];
      this.load = { "web-asg": 70 };
      this.dbs = [{ id: "orders-db", engine: "postgres", version: "16.4", cls: "db.t3.medium", port: 5432, subnet: this.sub("private-a").id, sgs: [this.sgId("db-sg")],
        ip: "10.0.11.25", public: false, status: "available", storage: 100, maxStorage: null, freeGb: 61, backups: 7, multiAz: false, created: START - 300 * DAY, snapshots: [] }];
      this.lambdas = [];
      this.buckets = {};
      this.accountPab = null;
      this.addBucket("quest-kitchen-assets", { gb: 12 });
      this.kmsKeys = [];
      this.creds = {};
      this.iam = { users: {}, groups: {}, roles: {}, policies: {}, rootKeys: [], rootMfa: true };
      this.scps = [];
      this.addRole("PlatformAdmin", { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: `arn:aws:iam::${ACCOUNT}:saml-provider/QuestKitchenSSO` }, Action: "sts:AssumeRoleWithSAML" }] }, [awsPolicyArn("AdministratorAccess")]);
      this.addRole("web-role", trustService("ec2.amazonaws.com"), [awsPolicyArn("AmazonSSMManagedInstanceCore")],
        { "assets-read": doc({ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::quest-kitchen-assets", "arn:aws:s3:::quest-kitchen-assets/*"] }) });
      this.addUser("breakglass", [awsPolicyArn("AdministratorAccess")]).mfa = true;
      this.profiles = { default: { sso: true, role: "PlatformAdmin", session: "you" } };
      this.sso = { valid: true };
      this.zones = [];
      this.domains = {};
      const zone = this.addZone("example.com");
      zone.records.push({ Name: "shop.example.com.", Type: "A", AliasTarget: { HostedZoneId: ALB_ZONE, DNSName: this.albs[0].dns + ".", EvaluateTargetHealth: true } });
      this.domains["example.com"] = { ns: [...zone.ns] };
      this.alarms = [];
      this.metrics = {};
      this.logGroups = [];
      this.topics = [{ arn: `arn:aws:sns:${REGION}:${ACCOUNT}:oncall-pager`, subs: [{ proto: "email", endpoint: "oncall@example.com", confirmed: true }] }];
      this.trail = { name: "main-trail", logging: true, bucket: "quest-kitchen-cloudtrail", multiRegion: true };
      this.events = [];
      this.findings = [];
      this.quotas = { "L-1216C47A": 64 };
      this.capacityOut = [];
      this.traffic = { internetGb: 120, s3Gb: 40 };
      this.certs = [];
      this.dists = [];
      this.ecs = { services: [], taskDefs: {}, deploys: 0 };
      this.eks = null;
      this.secrets = [];
      this.tables = [];
      this.queues = [];
      this.peerings = [];
    }

    // --- builders, also used by scenarios ---
    sub(name) { return this.subnets.find((s) => s.name === name || s.id === name); }
    sgId(name) { const g = this.sgs.find((s) => s.name === name); return g ? g.id : null; }
    sg(id) { return this.sgs.find((s) => s.id === id || s.name === id); }
    inst(name) { return this.instances.find((i) => i.name === name || i.id === name); }
    tg(name) { return this.tgs.find((t) => t.name === name || t.arn === name); }
    db(id) { return this.dbs.find((d) => d.id === id); }
    fn(name) { return this.lambdas.find((f) => f.name === name || f.arn === name); }
    rt(name) { return this.rts.find((r) => r.name === name || r.id === name); }
    addSg(name, desc, rules, egress) {
      const g = { id: rid("sg", name), name, desc, vpc: this.vpcs[0].id, in: rules.map((r) => ({ ...r })), out: egress || [{ proto: "-1", from: 0, to: 65535, cidr: "0.0.0.0/0" }] };
      this.sgs.push(g);
      return g;
    }
    addEip(name, n) {
      const e = { alloc: rid("eipalloc", name), assocId: rid("eipassoc", name), ip: PUBLIC_IP(n), assoc: null, name };
      this.eips.push(e);
      return e;
    }
    addInstance(o) {
      const sub = this.sub(o.subnet);
      const i = { id: rid("i", o.name), name: o.name, type: o.type || "t3.small", state: o.state || "running", subnet: sub.id, sgs: (o.sgs || ["default"]).map((n) => this.sgId(n) || n),
        ip: o.ip || `${sub.cidr.split(".").slice(0, 3).join(".")}.${10 + this.instances.length * 7}`, publicIp: o.publicIp || null, role: o.role || null,
        imds: { tokens: "required", endpoint: "enabled", hop: 2, ...(o.imds || {}) }, app: o.app || null, tags: { Name: o.name, ...(o.tags || {}) },
        launched: o.launched || START - 40 * DAY, system: "ok", status: "ok", ssm: o.ssm !== false, by: o.by || null, ami: o.ami || "ami-0c02fb55b34e7ea4f" };
      this.instances.push(i);
      this.volumes.push({ id: rid("vol", o.name), size: o.disk || 20, type: "gp3", attached: i.id, device: "/dev/xvda", created: i.launched, name: `${o.name}-root` });
      return i;
    }
    addTg(name, port, path, targets) {
      const t = { name, arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/${name}/${hexOf("tg" + name, 16)}`, port, path, hcPort: "traffic-port", matcher: "200",
        interval: 30, targets: targets.map((n) => ({ id: this.inst(n).id, port })) };
      this.tgs.push(t);
      return t;
    }
    addAlb(name, tg) {
      const id = hexOf("alb" + name, 16);
      const alb = { name, arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/${name}/${id}`, dns: `${name}-${hash(name) % 1e10}.${REGION}.elb.amazonaws.com`,
        subnets: [this.sub("public-a").id, this.sub("public-b").id], sgs: [this.sgId("alb-sg")], ips: [PUBLIC_IP(50), PUBLIC_IP(51)], ip: "10.0.1.10",
        listeners: [{ arn: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:listener/app/${name}/${id}/${hexOf("l" + name, 16)}`, port: 80, tg: this.tg(tg).arn }] };
      this.albs.push(alb);
      return alb;
    }
    addBucket(name, o = {}) {
      const b = { name, region: o.region || REGION, owner: ACCOUNT, created: o.created || START - 200 * DAY, policy: o.policy ? JSON.stringify(o.policy) : null,
        pab: o.pab === undefined ? { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } : o.pab,
        versioning: o.versioning || null, lifecycle: o.lifecycle || null, ownership: o.ownership || "BucketOwnerEnforced", kms: o.kms || null,
        gb: o.gb || 0, noncurrentGb: o.noncurrentGb || 0, churnGb: o.churnGb || 0, objects: {} };
      for (const [key, v] of Object.entries(o.objects || {})) b.objects[key] = [{ v: hexOf(name + key, 32), size: v.size || 1024, modified: v.modified || START - 3 * DAY, owner: v.owner || ACCOUNT, body: v.body || "" }];
      this.buckets[name] = b;
      return b;
    }
    addRole(name, trust, attached = [], inline = {}, boundary = null) {
      this.iam.roles[name] = { name, id: keyId("AROA", name), trust: JSON.stringify(trust), attached: [...attached], inline: Object.fromEntries(Object.entries(inline).map(([k, v]) => [k, JSON.stringify(v)])),
        boundary, created: START - 120 * DAY, maxSession: 3600 };
      return this.iam.roles[name];
    }
    addUser(name, attached = [], inline = {}, keys = 0) {
      const u = { name, id: keyId("AIDA", name), attached: [...attached], inline: Object.fromEntries(Object.entries(inline).map(([k, v]) => [k, JSON.stringify(v)])),
        groups: [], keys: [], created: START - 150 * DAY, mfa: false };
      this.iam.users[name] = u;
      for (let k = 0; k < keys; k++) this.addKey(u, name + (k || ""));
      return u;
    }
    addKey(user, seed, o = {}) {
      const id = keyId("AKIA", seed);
      this.creds[id] = { id, secret: blob("secret" + seed, 40), who: user ? { kind: "user", name: user.name } : { kind: "root" }, status: "Active", created: o.created || START - 100 * DAY, lastUsed: o.lastUsed || START - DAY };
      (user ? user.keys : this.iam.rootKeys).push(id);
      return this.creds[id];
    }
    addPolicy(name, d) {
      const arn = `arn:aws:iam::${ACCOUNT}:policy/${name}`;
      this.iam.policies[arn] = { name, arn, doc: JSON.stringify(d), version: 1, created: START - 60 * DAY };
      return arn;
    }
    addZone(name) {
      const id = "Z0" + hexOf("zone" + name + this.zones.length, 19).toUpperCase();
      const n = hash(id);
      const z = { id, name: name + ".", ns: [`ns-${n % 2048}.awsdns-${n % 64}.org`, `ns-${(n >> 3) % 2048}.awsdns-${(n >> 5) % 64}.co.uk`, `ns-${(n >> 7) % 512}.awsdns-${(n >> 9) % 64}.com`, `ns-${(n >> 11) % 1024}.awsdns-${(n >> 13) % 64}.net`],
        records: [] };
      this.zones.push(z);
      return z;
    }
    addKmsKey(alias, policy) {
      const h = hexOf("kms" + alias, 32);
      const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
      const k = { id, arn: `arn:aws:kms:${REGION}:${ACCOUNT}:key/${id}`, alias: "alias/" + alias, policy: JSON.stringify(policy), state: "Enabled", created: START - 400 * DAY };
      this.kmsKeys.push(k);
      return k;
    }
    addLambda(o) {
      const f = { name: o.name, arn: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${o.name}`, runtime: o.runtime || "nodejs22.x", handler: "index.handler", timeout: o.timeout || 3, memory: o.memory || 128,
        role: o.role, env: { ...(o.env || {}) }, vpc: o.vpc ? { subnets: o.vpc.subnets.map((n) => this.sub(n).id), sgs: o.vpc.sgs.map((n) => this.sgId(n)), ip: o.vpc.ip || "10.0.11.77" } : null,
        workMs: o.workMs || 180, needs: o.needs || {}, modified: START - 5 * DAY };
      this.lambdas.push(f);
      this.addLogGroup(`/aws/lambda/${o.name}`, { gb: 2, ingestGb: 1, retention: 30 });
      return f;
    }
    addLogGroup(name, o = {}) {
      const g = { name, retention: o.retention || null, gb: o.gb || 0.1, ingestGb: o.ingestGb || 0.1, created: START - 400 * DAY, lines: [] };
      this.logGroups.push(g);
      return g;
    }

    // --- IAM lookups ---
    policyDoc(arn) {
      const m = /^arn:aws:iam::aws:policy\/(?:service-role\/)?(.+)$/.exec(arn);
      if (m && AWS_POLICIES[m[1]]) return doc(...AWS_POLICIES[m[1]]);
      const p = this.iam.policies[arn];
      return p ? parseDoc(p.doc) : null;
    }
    identityDocs(who) {
      const ent = who.kind === "user" ? this.iam.users[who.name] : who.kind === "role" ? this.iam.roles[who.role] : null;
      if (!ent) return [];
      const groups = (ent.groups || []).map((g) => this.iam.groups[g]).filter(Boolean);
      return [ent, ...groups].flatMap((e) => [...e.attached.map((arn) => this.policyDoc(arn)), ...Object.values(e.inline).map(parseDoc)]).filter(Boolean);
    }
    // A principal as the evaluation logic sees it.
    user(name) {
      const u = this.iam.users[name];
      return { kind: "user", name, arn: `arn:aws:iam::${ACCOUNT}:user/${name}`, baseArn: `arn:aws:iam::${ACCOUNT}:user/${name}`, account: ACCOUNT, uniqueId: u ? u.id : null, boundary: u && u.boundary };
    }
    role(name, session = "session") {
      const r = this.iam.roles[name];
      return { kind: "role", role: name, name: null, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${name}/${session}`, baseArn: `arn:aws:iam::${ACCOUNT}:role/${name}`, account: ACCOUNT,
        uniqueId: r ? r.id : null, session, boundary: r && r.boundary };
    }
    root() { return { kind: "root", root: true, arn: `arn:aws:iam::${ACCOUNT}:root`, baseArn: `arn:aws:iam::${ACCOUNT}:root`, account: ACCOUNT }; }
    outsider() { return { kind: "user", name: "mallory", arn: `arn:aws:iam::${PARTNER}:user/mallory`, baseArn: `arn:aws:iam::${PARTNER}:user/mallory`, account: PARTNER }; }
    can(who, action, resource, opt) { return evaluate(this, who, action, resource, opt).allowed; }
    // Can this principal assume the role? Its own policy and the role's trust policy must agree.
    canAssume(who, roleName) {
      const r = this.iam.roles[roleName];
      if (!r) return false;
      const arn = `arn:aws:iam::${ACCOUNT}:role/${roleName}`;
      return evaluate(this, who, "sts:AssumeRole", arn, { resPolicy: r.trust, resAccount: ACCOUNT }).allowed && this.trustNames(r, who);
    }
    trustNames(r, who) { return Boolean(scan([parseDoc(r.trust)], { action: "sts:AssumeRole", keys: { "aws:PrincipalArn": who.baseArn }, who }, true).allow); }

    // --- network ---
    rtOf(subnetId) { return this.rts.find((r) => r.subnets.includes(subnetId)) || this.rts.find((r) => r.main && r.vpc === this.sub(subnetId).vpc); }
    naclOf(subnetId) { return this.nacls.find((n) => n.subnets.includes(subnetId)); }
    routeFor(subnetId, ip, service) {
      const rt = this.rtOf(subnetId);
      if (!rt) return null;
      if (service === "s3") { const pl = rt.routes.find((r) => r.dest === S3_PREFIX_LIST); if (pl) return pl; }
      const hits = rt.routes.filter((r) => r.dest !== S3_PREFIX_LIST && inCidr(ip, r.dest)).sort((x, y) => Number(y.dest.split("/")[1]) - Number(x.dest.split("/")[1]));
      return hits[0] || null;
    }
    igwUp(id) { const g = this.igws.find((x) => x.id === id); return Boolean(g && g.vpc); }
    hasInternetRoute(subnetId) { const r = this.routeFor(subnetId, "8.8.8.8"); return Boolean(r && r.target.startsWith("igw-") && this.igwUp(r.target)); }
    naclAllows(subnetId, egress, port, ip, proto = "6") {
      const acl = this.naclOf(subnetId);
      if (!acl) return true;
      for (const e of acl.entries.filter((x) => x.egress === egress).sort((x, y) => x.n - y.n)) {
        if (e.proto !== "-1" && e.proto !== proto) continue;
        if (e.proto !== "-1" && (port < e.from || port > e.to)) continue;
        if (!inCidr(ip, e.cidr)) continue;
        return e.action === "allow";
      }
      return false;
    }
    sgAllows(sgIds, dir, port, peer) {
      return sgIds.map((id) => this.sg(id)).filter(Boolean).some((g) => g[dir].some((r) =>
        (r.proto === "-1" || (r.proto === "tcp" && port >= r.from && port <= r.to)) && (r.cidr ? inCidr(peer.ip, r.cidr) : r.sg ? (peer.sgs || []).includes(r.sg) : false)));
    }
    publicIpOf(i) {
      const e = this.eips.find((x) => x.assoc === i.id);
      return e ? e.ip : i.state === "running" ? i.publicIp : null;
    }
    ep(thing) {
      if (thing.kind) return thing;
      if (thing.subnet && thing.app !== undefined) {
        const i = thing;
        return { kind: "eni", name: i.name, subnet: i.subnet, sgs: i.sgs, ip: i.ip, publicIp: this.publicIpOf(i), up: i.state === "running" && i.system === "ok", listens: (p) => (APPS[i.app] || { ports: [] }).ports.includes(p) };
      }
      return thing;
    }
    // Whether a TCP connection from src to dst:port opens: "ok", "refused" or "timeout".
    connect(srcIn, dstIn, port) {
      const src = this.ep(srcIn), dst = this.ep(dstIn);
      if (src.up === false) return "timeout";
      if (dst.kind === "internet") {
        if (!this.egress(src, dst.ip, port, dst.service)) return "timeout";
        return "ok";
      }
      if (dst.up === false) return "timeout";
      if (src.kind === "internet") {
        if (!dst.publicIp || !this.hasInternetRoute(dst.subnet)) return "timeout";
        if (!this.naclAllows(dst.subnet, false, port, src.ip) || !this.naclAllows(dst.subnet, true, EPHEMERAL, src.ip)) return "timeout";
        if (!this.sgAllows(dst.sgs, "in", port, src)) return "timeout";
      } else {
        if (!this.sgAllows(src.sgs, "out", port, dst) || !this.sgAllows(dst.sgs, "in", port, src)) return "timeout";
        const vs = this.sub(src.subnet).vpc, vd = this.sub(dst.subnet).vpc;
        if (vs !== vd && !(this.peered(src.subnet, dst.ip, vs, vd) && this.peered(dst.subnet, src.ip, vd, vs))) return "timeout";
        if (src.subnet !== dst.subnet && !(this.naclAllows(src.subnet, true, port, dst.ip) && this.naclAllows(dst.subnet, false, port, src.ip) &&
          this.naclAllows(dst.subnet, true, EPHEMERAL, src.ip) && this.naclAllows(src.subnet, false, EPHEMERAL, dst.ip))) return "timeout";
      }
      return dst.listens(port) ? "ok" : "refused";
    }
    // Leaving the VPC: security group, NACL, then the route table decides.
    egress(src, ip, port, service) {
      if (src.kind === "internet") return true;
      if (!this.sgAllows(src.sgs, "out", port, { ip }) || !this.naclAllows(src.subnet, true, port, ip) || !this.naclAllows(src.subnet, false, EPHEMERAL, ip)) return false;
      const r = this.routeFor(src.subnet, ip, service);
      if (!r || r.target === "local") return false;
      if (r.target.startsWith("vpce-")) return service === "s3";
      if (r.target.startsWith("igw-")) return Boolean(src.publicIp) && this.igwUp(r.target);
      if (r.target.startsWith("nat-")) {
        const nat = this.nats.find((n) => n.id === r.target);
        return Boolean(nat && nat.state === "available" && this.hasInternetRoute(nat.subnet));
      }
      return false;
    }
    // Across VPCs only through an active peering connection, routed both ways.
    peered(subnetId, ip, from, to) {
      const r = this.routeFor(subnetId, ip);
      return Boolean(r && r.target.startsWith("pcx-") && this.peerings.some((p) => p.id === r.target && p.status === "active" && [p.a, p.b].sort().join() === [from, to].sort().join()));
    }
    natPath(subnetId) {
      const r = this.routeFor(subnetId, "8.8.8.8");
      return r && r.target.startsWith("nat-") ? this.nats.find((n) => n.id === r.target && n.state !== "deleted") : null;
    }

    // --- load balancing ---
    health(tg, t) {
      const i = this.inst(t.id);
      if (!i || i.state !== "running") return { State: "unused", Reason: "Target.InvalidState", Description: `Target is in the ${i ? i.state : "terminated"} state` };
      if (t.fresh) return { State: "initial", Reason: "Elb.RegistrationInProgress", Description: "Target registration is in progress" };
      const alb = this.albs.find((x) => x.listeners.some((l) => l.tg === tg.arn)) || this.albs[0];
      const port = tg.hcPort === "traffic-port" ? t.port : Number(tg.hcPort);
      const c = this.connect({ kind: "eni", subnet: alb.subnets[0], sgs: alb.sgs, ip: alb.ip }, i, port);
      if (c === "timeout") return { State: "unhealthy", Reason: "Target.Timeout", Description: "Request timed out" };
      if (c === "refused") return { State: "unhealthy", Reason: "Target.FailedHealthChecks", Description: "Health checks failed" };
      const code = ((APPS[i.app] || {}).paths || {})[tg.path] ? APPS[i.app].paths[tg.path][0] : 404;
      if (!matches(tg.matcher, code)) return { State: "unhealthy", Reason: "Target.ResponseCodeMismatch", Description: `Health checks failed with these codes: [${code}]` };
      return { State: "healthy" };
    }
    // One HTTP request through the load balancer, as the ALB answers it.
    albGet(alb, path, from) {
      const l = alb.listeners.find((x) => x.port === 80);
      if (!l) return { err: "refused" };
      const node = { kind: "eni", subnet: alb.subnets[0], sgs: alb.sgs, ip: alb.ip, publicIp: alb.ips[0], listens: () => true };
      const c = this.connect(from, node, 80);
      if (c !== "ok") return { err: c };
      const tg = this.tg(l.tg);
      if (!tg || !tg.targets.length) return { code: 503, body: ALB_PAGE(503, "Service Temporarily Unavailable") };
      const states = tg.targets.map((t) => [t, this.health(tg, t).State]);
      const healthy = states.filter((x) => x[1] === "healthy");
      // With no healthy target the ALB fails open and tries them all.
      const pool = healthy.length ? healthy : states.filter((x) => x[1] !== "unused");
      if (!pool.length) return { code: 503, body: ALB_PAGE(503, "Service Temporarily Unavailable") };
      const [t] = pool[0];
      const i = this.inst(t.id);
      const r = this.connect(node, i, t.port);
      if (r === "timeout") return { code: 504, body: ALB_PAGE(504, "Gateway Time-out") };
      if (r === "refused") return { code: 502, body: ALB_PAGE(502, "Bad Gateway") };
      return this.appGet(i, path);
    }

    // --- DNS: what a name points at, as public resolvers see it ---
    resolve(host, inside) {
      host = String(host).toLowerCase().replace(/\.$/, "");
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { ip: host };
      if (EXTERNAL[host]) return { ip: EXTERNAL[host] };
      if (/(^|\.)s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host)) return { ip: S3_IP, s3: host.split(".s3")[0] };
      const cf = this.dists.find((x) => x.domain === host);
      if (cf) return { ip: CF_IP, cf };
      const alb = this.albs.find((x) => x.dns === host || `dualstack.${x.dns}` === host);
      if (alb) return { ip: alb.ips[0], alb };
      const db = this.dbs.find((d) => this.dbHost(d) === host);
      if (db) return { ip: inside || !db.public ? db.ip : PUBLIC_IP(90), db };
      const zone = this.zones.find((z) => host === z.name.slice(0, -1) || host.endsWith("." + z.name.slice(0, -1)));
      if (!zone) return null;
      const apex = zone.name.slice(0, -1);
      const reg = this.domains[apex];
      if (reg && reg.ns.slice().sort().join() !== zone.ns.slice().sort().join()) return { servfail: true };
      const recs = zone.records.filter((r) => r.Name === host + ".");
      const rec = recs.find((r) => r.Type === "A") || recs.find((r) => r.Type === "CNAME");
      if (!rec) return { nx: true };
      if (rec.AliasTarget) return this.resolve(rec.AliasTarget.DNSName, inside);
      if (rec.Type === "CNAME") return this.resolve(rec.ResourceRecords[0].Value, inside);
      return { ip: rec.ResourceRecords[0].Value, rec };
    }
    dbHost(d) { return `${d.id}.c3kq8vx0zw1m.${REGION}.rds.amazonaws.com`; }
    // What answers at a public IP.
    atIp(ip) {
      const i = this.instances.find((x) => this.publicIpOf(x) === ip);
      if (i) return { inst: i };
      const alb = this.albs.find((x) => x.ips.includes(ip));
      if (alb) return { alb };
      const db = this.dbs.find((d) => d.public && ip === PUBLIC_IP(90));
      if (db) return { db };
      if (Object.values(EXTERNAL).includes(ip)) return { external: true };
      if (ip === S3_IP) return { s3: true };
      return null;
    }
    dbEp(d) { return { kind: "eni", name: d.id, subnet: d.subnet, sgs: d.sgs, ip: d.ip, publicIp: d.public ? PUBLIC_IP(90) : null, up: d.status === "available" || d.status === "backing-up" || d.status === "modifying", listens: (p) => p === d.port }; }
    lambdaEp(f) { return f.vpc ? { kind: "eni", name: f.name, subnet: f.vpc.subnets[0], sgs: f.vpc.sgs, ip: f.vpc.ip, listens: () => false } : { kind: "internet", ip: "3.80.0.1" }; }

    // --- S3 ---
    isPublicPolicy(b) {
      const d = parseDoc(b.policy);
      return stmts(d).some((st) => st.Effect === "Allow" && (st.Principal === "*" || asList((st.Principal || {}).AWS).includes("*")) &&
        !Object.values(st.Condition || {}).some((blk) => Object.keys(blk).some((k) => /aws:(SourceIp|SourceVpce?|PrincipalOrgID|PrincipalAccount|PrincipalArn|SourceArn|SourceAccount)/i.test(k))));
    }
    pabOn(b, key) { return Boolean((b.pab && b.pab[key]) || (this.accountPab && this.accountPab[key])); }
    isPublic(b) { return this.isPublicPolicy(b) && !this.pabOn(b, "RestrictPublicBuckets"); }
    // Whether a principal may do an S3 action; throws the error S3 returns.
    s3Check(who, action, bucket, key, op) {
      const b = this.buckets[bucket];
      if (!b) throw new AwsError("NoSuchBucket", "The specified bucket does not exist");
      const arn = `arn:aws:s3:::${bucket}${key !== undefined ? "/" + key : ""}`;
      let pol = b.policy;
      if (this.pabOn(b, "RestrictPublicBuckets") && this.isPublicPolicy(b) && who.account !== b.owner) pol = null;
      const r = who.anonymous ? { allowed: Boolean(pol) && this.isPublic(b) && scan([parseDoc(pol)], { action, resource: arn, keys: {}, who: { account: "anonymous" } }, true).allow === "direct" && !scan([parseDoc(pol)], { action, resource: arn, keys: {}, who: {} }, true).deny }
        : evaluate(this, who, action, arn, { resPolicy: pol, resAccount: b.owner });
      if (!r.allowed) throw new AwsError("AccessDenied", who.anonymous || who.account !== b.owner ? "Access Denied" : `User: ${who.arn} is not authorized to perform: ${action} on resource: "${arn}" ${r.why}`);
      const obj = key !== undefined && b.objects[key] ? b.objects[key][0] : null;
      if (obj && obj.owner !== b.owner && b.ownership !== "BucketOwnerEnforced" && who.account !== obj.owner) throw new AwsError("AccessDenied", "Access Denied");
      if (obj && b.kms && /GetObject/.test(action)) {
        const k = this.kmsKeys.find((x) => x.arn === b.kms);
        const kr = evaluate(this, who, "kms:Decrypt", k.arn, { resPolicy: k.policy, kms: true, keys: { "kms:ViaService": `s3.${REGION}.amazonaws.com` } });
        if (!kr.allowed) throw new AwsError("AccessDenied", `User: ${who.arn} is not authorized to perform: kms:Decrypt on resource: ${k.arn} ${kr.why}`);
      }
      return { b, obj, op };
    }
    noncurrent(b) {
      const lc = b.lifecycle && b.lifecycle.Rules ? b.lifecycle.Rules.find((r) => r.Status === "Enabled" && r.NoncurrentVersionExpiration) : null;
      const days = lc ? Number(lc.NoncurrentVersionExpiration.NoncurrentDays) : null;
      return days ? Math.min(b.noncurrentGb, b.churnGb * days) : b.noncurrentGb;
    }

    // --- logs, metrics, alarms ---
    storedGb(g) { return g.retention ? Math.min(g.gb, (g.ingestGb / 30) * g.retention) : g.gb; }
    log(group, line) {
      let g = this.logGroups.find((x) => x.name === group);
      if (!g) g = this.addLogGroup(group);
      g.lines.push([this.now, line]);
    }
    inService(asg) { return asg.instances.map((id) => this.inst(id)).filter((i) => i && i.state === "running").length; }
    metric(ns, name, dims) {
      const d = Object.fromEntries((dims || []).map((x) => [x.Name, x.Value]));
      if (ns === "AWS/EC2" && name === "CPUUtilization") {
        if (d.AutoScalingGroupName) {
          const g = this.asgs.find((x) => x.name === d.AutoScalingGroupName);
          const n = g ? this.inService(g) : 0;
          return g && n ? Math.min(99.5, Math.round((this.load[g.name] || 0) / n * 10) / 10) : null;
        }
        const i = this.inst(d.InstanceId || "");
        return i && i.state === "running" ? 12.4 : null;
      }
      if (ns === "AWS/RDS" && name === "FreeStorageSpace") { const db = this.db(d.DBInstanceIdentifier); return db ? db.freeGb * 1073741824 : null; }
      if (ns === "AWS/ApplicationELB" && name === "UnHealthyHostCount") {
        const tg = this.tgs.find((t) => d.TargetGroup && d.TargetGroup === t.arn.split(":").pop());
        return tg ? tg.targets.filter((t) => this.health(tg, t).State === "unhealthy").length : null;
      }
      const v = this.metrics[`${ns}:${name}`];
      return v === undefined ? null : typeof v === "function" ? v(this) : v;
    }
    alarmState(al) {
      const v = this.metric(al.ns, al.metric, al.dims);
      if (v === null) return ["INSUFFICIENT_DATA", `Insufficient Data: ${al.evalPeriods} datapoints were unknown.`];
      const breach = { GreaterThanThreshold: v > al.threshold, GreaterThanOrEqualToThreshold: v >= al.threshold, LessThanThreshold: v < al.threshold, LessThanOrEqualToThreshold: v <= al.threshold }[al.op];
      const pts = Array(al.evalPeriods).fill(`${v} (30/10/26 08:${String(55 - al.evalPeriods).padStart(2, "0")}:00)`).join(", ");
      return breach ? ["ALARM", `Threshold Crossed: ${al.evalPeriods} datapoints [${pts}] were ${al.op.replace(/([A-Z])/g, " $1").trim().toLowerCase().replace("threshold", "the threshold")} (${al.threshold.toFixed(1)}).`]
        : ["OK", `Threshold Crossed: ${al.evalPeriods} datapoints [${pts}] were not ${al.op.replace(/([A-Z])/g, " $1").trim().toLowerCase().replace("threshold", "the threshold")} (${al.threshold.toFixed(1)}).`];
    }

    // Time passes a little with every command: things that were starting
    // finish, alarms re-evaluate and Auto Scaling acts on them.
    tick() {
      this.now += 30e3;
      this.seq++;
      for (const n of this.nats) if (n.state === "pending") n.state = "available"; else if (n.state === "deleting") n.state = "deleted";
      for (const i of this.instances) {
        const was = i.state;
        if (was === "pending") i.state = "running";
        else if (was === "stopping") i.state = "stopped";
        else if (was === "shutting-down") i.state = "terminated";
        if (was === "stopping" && i.system === "impaired") i.system = "ok";
        if (was !== i.state && i.state === "running" && !this.eips.some((e) => e.assoc === i.id) && this.sub(i.subnet).mapPublic && !i.publicIp) i.publicIp = PUBLIC_IP(120 + (hash(i.id + this.seq) % 60));
        if (i.state === "stopped" || i.state === "terminated") i.publicIp = null;
      }
      for (const t of this.tgs) for (const x of t.targets) delete x.fresh;
      for (const c of this.certs.filter((x) => x.status === "PENDING_VALIDATION")) {
        if (this.zones.some((z) => z.records.some((r) => r.Type === "CNAME" && fqdn(r.Name) === c.validation.Name && fqdn((r.ResourceRecords || [])[0] ? r.ResourceRecords[0].Value : "") === c.validation.Value))) c.status = "ISSUED";
      }
      for (const d of this.dists) {
        if (d.status === "InProgress") d.status = "Deployed";
        for (const inv of d.invalidations.filter((i) => i.status === "InProgress")) {
          inv.status = "Completed";
          for (const key of Object.keys(d.cache)) if (inv.paths.some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : key === p))) delete d.cache[key];
        }
      }
      for (const t of this.tables) if (t.status === "UPDATING") t.status = "ACTIVE";
      for (const d of this.dbs) {
        if (["modifying", "rebooting", "backing-up", "upgrading"].includes(d.status)) d.status = d.freeGb <= 0 ? "storage-full" : "available";
      }
      for (const al of this.alarms) {
        const [st, why] = this.alarmState(al);
        if (st !== al.state) { al.state = st; al.reason = why; al.updated = this.now; }
        if (st === "ALARM") this.fire(al);
      }
      for (const g of this.asgs) {
        for (const p of g.policies.filter((x) => x.type === "TargetTrackingScaling")) {
          const want = Math.ceil((this.load[g.name] || 0) / p.target);
          if (want > g.desired) this.scaleTo(g, want, `a user request created an AutoScalingGroup changing the desired capacity from ${g.desired} to ${Math.min(want, g.max)}`);
        }
        this.converge(g);
      }
    }
    fire(al) {
      for (const arn of al.actions) {
        const g = this.asgs.find((x) => x.policies.some((p) => p.arn === arn));
        if (g) {
          const p = g.policies.find((x) => x.arn === arn);
          this.scaleTo(g, g.desired + (p.adjustment || 1), `monitor alarm ${al.name} in state ALARM triggered policy ${p.name} changing the desired capacity from ${g.desired} to ${Math.min(g.max, g.desired + (p.adjustment || 1))}`);
        }
        if (this.topics.some((t) => t.arn === arn) && !this.notifications.some((n) => n.alarm === al.name)) this.notifications.push({ alarm: al.name, topic: arn, at: this.now });
      }
    }
    scaleTo(g, want, cause) {
      const next = Math.min(g.max, Math.max(g.min, want));
      if (next === g.desired) return;
      g.activities.unshift({ desc: `Launching ${plural(next - g.desired, "new EC2 instance")}`, cause: `At ${ts(this.now).replace("+00:00", "Z")} ${cause}.`, at: this.now });
      g.desired = next;
    }
    converge(g) {
      const live = g.instances.filter((id) => { const i = this.inst(id); return i && !["terminated", "shutting-down"].includes(i.state); });
      g.instances = live;
      while (g.instances.length < g.desired) {
        const n = g.instances.length;
        const name = `${g.name}-${hexOf(g.name + this.seq + n, 4)}`;
        const i = this.addInstance({ name, type: g.lt.type, subnet: g.lt.subnets[n % g.lt.subnets.length], sgs: g.lt.sgs, app: g.lt.app, role: g.lt.role, state: "pending", launched: this.now, tags: { "aws:autoscaling:groupName": g.name } });
        g.instances.push(i.id);
        for (const arn of g.tgs) { const tg = this.tg(arn); if (tg) tg.targets.push({ id: i.id, port: tg.port, fresh: true }); }
      }
    }

    // --- cost: an estimate for a month, from what exists right now ---
    costItems() {
      const P = PRICES, H = P.hours, items = [];
      const add = (service, label, usd) => { if (usd > 0.004) items.push({ service, label, usd }); };
      for (const i of this.instances.filter((x) => x.state === "running" || x.state === "pending")) add("Amazon Elastic Compute Cloud - Compute", `EC2 ${i.type} (${i.name})`, (P.ec2[i.type] || 0.1) * H);
      const vols = this.volumes.filter((v) => v.state !== "deleted");
      add("EC2 - Other", `EBS volumes (${vols.reduce((n, v) => n + v.size, 0)} GB)`, vols.reduce((n, v) => n + v.size * (P.ebs[v.type] || 0.08), 0));
      const idleVols = vols.filter((v) => !v.attached);
      if (idleVols.length) items[items.length - 1].label += `, ${idleVols.length} unattached`;
      add("EC2 - Other", `EBS snapshots (${this.snapshots.reduce((n, s) => n + s.size, 0)} GB)`, this.snapshots.reduce((n, s) => n + s.size * P.snapshot, 0));
      for (const n of this.nats.filter((x) => x.state === "available" || x.state === "pending")) add("EC2 - Other", `NAT gateway ${n.name}, ${this.natGb(n).toLocaleString("en-US")} GB processed`, P.natHour * H + this.natGb(n) * P.natGb);
      const ips = this.eips.length + this.instances.filter((i) => i.publicIp && i.state === "running" && !this.eips.some((e) => e.assoc === i.id)).length + this.albs.length * 2;
      const idle = this.eips.filter((e) => !e.assoc || (this.inst(e.assoc) && this.inst(e.assoc).state !== "running")).length;
      add("Amazon Virtual Private Cloud", `Public IPv4 addresses (${ips}${idle ? `, ${idle} idle` : ""})`, ips * P.ipv4Hour * H);
      for (const e of this.endpoints.filter((x) => x.type === "Interface")) add("Amazon Virtual Private Cloud", `Interface endpoint ${e.service.split(".").pop()}`, 2 * 0.01 * H);
      for (const alb of this.albs) add("Elastic Load Balancing", `ALB ${alb.name}`, (P.albHour + P.albLcuHour * 2) * H);
      for (const d of this.dbs.filter((x) => x.status !== "stopped")) {
        add("Amazon Relational Database Service", `RDS ${d.cls} (${d.id}), ${d.storage} GB`, (P.rds[d.cls] || 0.07) * H + d.storage * P.rdsGb);
        if (d.version.startsWith("12.")) add("Amazon Relational Database Service", `RDS Extended Support (PostgreSQL 12)`, P.rdsExtendedVcpuHour * 2 * H);
      }
      const s3 = Object.values(this.buckets).reduce((n, b) => n + b.gb + this.noncurrent(b), 0);
      add("Amazon Simple Storage Service", `S3 Standard (${Math.round(s3).toLocaleString("en-US")} GB)`, s3 * P.s3Gb);
      const stored = this.logGroups.reduce((n, g) => n + this.storedGb(g), 0);
      add("AmazonCloudWatch", `Logs: ${Math.round(stored).toLocaleString("en-US")} GB stored`, stored * P.logsStoreGb + this.logGroups.reduce((n, g) => n + g.ingestGb, 0) * P.logsIngestGb);
      return items;
    }
    natGb(n) {
      const users = this.subnets.filter((s) => this.natPath(s.id) === n).length;
      if (!users) return 0;
      const s3ViaNat = this.subnets.some((s) => this.natPath(s.id) === n && this.routeFor(s.id, S3_IP, "s3").target === n.id);
      return this.traffic.internetGb + (s3ViaNat ? this.traffic.s3Gb : 0);
    }
    monthly() { return this.costItems().reduce((n, x) => n + x.usd, 0); }
  }
  const matches = (matcher, code) => String(matcher).split(",").some((m) => { const [lo, hi] = m.split("-").map(Number); return hi ? code >= lo && code <= hi : code === lo; });

  // --- the aws CLI -------------------------------------------------------------------

  class ArgError extends Error {}
  const USAGE = ["usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]", "To see help text, you can run:", "", "  aws help", "  aws <command> help", "  aws <command> <subcommand> help", ""];
  const BOOL = new Set(["no-cli-pager", "dry-run", "no-dry-run", "apply-immediately", "no-apply-immediately", "force", "recursive", "publicly-accessible", "no-publicly-accessible",
    "egress", "ingress", "include-all-instances", "allow-major-version-upgrade", "set-as-default", "debug", "no-paginate", "follow", "human-readable", "summarize", "no-verify-ssl", "storage-encrypted", "multi-az", "no-multi-az"]);
  // Options that take a list: --instance-ids i-1 i-2. The rest take one value.
  const MULTI = new Set(["instance-ids", "filters", "action-names", "resource-arns", "targets", "nameservers", "dimensions", "alarm-actions", "alarm-names", "group-ids", "group-names",
    "ip-permissions", "subnet-ids", "route-table-ids", "volume-ids", "snapshot-ids", "security-group-ids", "owner-ids", "owners", "finding-ids", "statistics", "auto-scaling-group-names",
    "names", "target-group-arns", "network-acl-ids", "vpc-security-group-ids", "tag-specifications"]);
  const PREFIX = { ec2: "ec2", s3api: "s3", s3: "s3", s3control: "s3", iam: "iam", sts: "sts", elbv2: "elasticloadbalancing", autoscaling: "autoscaling", cloudwatch: "cloudwatch", logs: "logs",
    lambda: "lambda", rds: "rds", route53: "route53", route53domains: "route53domains", kms: "kms", cloudtrail: "cloudtrail", guardduty: "guardduty", "service-quotas": "servicequotas",
    ce: "ce", ssm: "ssm", sns: "sns", organizations: "organizations", cloudfront: "cloudfront", acm: "acm", ecs: "ecs", eks: "eks", secretsmanager: "secretsmanager", dynamodb: "dynamodb", sqs: "sqs" };
  // Error codes differ by service for the same denial.
  const DENY_CODE = { iam: "AccessDenied", sts: "AccessDenied", s3: "AccessDenied", elasticloadbalancing: "AccessDenied", autoscaling: "AccessDenied", cloudwatch: "AccessDenied", rds: "AccessDenied", route53: "AccessDenied", sns: "AuthorizationError" };

  function parseOpts(rest) {
    const o = {}, pos = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t.startsWith("--") && t.length > 2) {
        const eq = t.indexOf("=");
        const name = (eq > 0 ? t.slice(2, eq) : t.slice(2));
        if (eq > 0) { o[name] = [t.slice(eq + 1)]; continue; }
        const vals = [];
        while (!BOOL.has(name) && i + 1 < rest.length && !rest[i + 1].startsWith("--") && (!vals.length || MULTI.has(name))) vals.push(rest[++i]);
        o[name] = vals.length ? vals : true;
      } else pos.push(t);
    }
    return { o, pos };
  }

  // Which credentials a command uses, in the CLI's order: --profile, then
  // the AWS_* environment variables, then AWS_PROFILE, then [default].
  function credSource(a, profileFlag, inside) {
    if (inside) return { kind: "instance", inst: inside };
    if (!profileFlag && a.env.AWS_ACCESS_KEY_ID) return { kind: "env", key: a.env.AWS_ACCESS_KEY_ID, secret: a.env.AWS_SECRET_ACCESS_KEY, token: a.env.AWS_SESSION_TOKEN };
    const name = profileFlag || a.env.AWS_PROFILE || "default";
    return { kind: "profile", name, p: a.profiles[name] };
  }
  function whoAmI(a, src, opName, svc) {
    const s3 = svc === "s3" || svc === "s3api";
    if (src.kind === "instance") {
      const i = src.inst;
      if (!i.role) throw new ArgError("Unable to locate credentials. You can configure credentials by running \"aws configure\".");
      if (i.imds.endpoint !== "enabled") throw new ArgError("Unable to locate credentials. You can configure credentials by running \"aws configure\".");
      return a.role(i.role, i.id);
    }
    if (src.kind === "profile") {
      if (!src.p) throw new ArgError(`The config profile (${src.name}) could not be found`);
      if (src.p.sso) {
        if (!a.sso.valid) throw new ArgError("Error when retrieving token from sso: Token has expired and refresh failed");
        return a.role(src.p.role, src.p.session);
      }
      if (src.p.key) return keyWho(a, src.p.key, src.p.secret, null, opName, s3);
      throw new ArgError("Unable to locate credentials. You can configure credentials by running \"aws configure\".");
    }
    if (!src.secret) throw new ArgError("Partial credentials found in env, missing: AWS_SECRET_ACCESS_KEY");
    return keyWho(a, src.key, src.secret, src.token, opName, s3);
  }
  function keyWho(a, id, secret, token, opName, s3) {
    const k = a.creds[id];
    if (!k || k.status !== "Active" || (k.session && !token)) {
      if (s3) throw new AwsError("InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
      throw new AwsError("InvalidClientTokenId", "The security token included in the request is invalid.");
    }
    if (secret !== k.secret) {
      if (s3) throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method.");
      throw new AwsError("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.");
    }
    if (k.expires && k.expires < a.now) throw new AwsError(s3 ? "ExpiredToken" : "ExpiredToken", "The security token included in the request is expired");
    k.lastUsed = a.now;
    if (k.who.kind === "root") return a.root();
    if (k.who.kind === "role") return a.role(k.who.role, k.who.session);
    return a.user(k.who.name);
  }

  // Reads a parameter, following file:// and fileb:// like the CLI does.
  function paramText(a, name, v) {
    const m = /^fileb?:\/\/(.+)$/.exec(v || "");
    if (!m) return v;
    const p = m[1].replace(/^\.\//, "");
    if (a.files[p] === undefined) throw new ArgError(`Error parsing parameter '--${name}': Unable to load paramfile ${v}: [Errno 2] No such file or directory: '${m[1]}'`);
    return a.files[p];
  }

  function makeCtx(a, svc, op, o, pos, region, src) {
    const opName = svc === "s3api" && op === "list-objects-v2" ? "ListObjectsV2" : pascal(op);
    const c = {
      a, svc, op, o, pos, region, opName, src,
      opt: (n) => (Array.isArray(o[n]) ? paramText(a, n, o[n][0]) : undefined),
      list: (n) => (Array.isArray(o[n]) ? o[n].flatMap((x) => (/^\[/.test(x) ? shorthand(x) || [] : [x])) : []),
      flag: (n) => o[n] === true,
      need(...names) {
        const miss = names.filter((n) => o[n] === undefined || o[n] === true);
        if (miss.length) throw new ArgError(`aws: [ERROR]: the following arguments are required: ${miss.map((n) => "--" + n).join(", ")}`);
      },
      num(n) { const v = c.opt(n); if (v === undefined) return undefined; if (!/^-?\d+$/.test(v)) throw new ArgError(`aws: [ERROR]: argument --${n}: invalid int value: '${v}'`); return Number(v); },
      // Authorize the caller, or throw the error this service returns.
      allow(action, resource, opt = {}) {
        const r = evaluate(a, c.who, action, resource, { region: c.region, ...opt });
        if (r.allowed) return;
        const service = opt.as || action.split(":")[0];
        const res = service === "s3" ? `"${resource}"` : resource;
        if (service === "ec2") {
          if (/^Describe/.test(action.split(":")[1]) || opt.plain) throw new AwsError("UnauthorizedOperation", `You are not authorized to perform this operation. User: ${c.who.arn} is not authorized to perform: ${action} ${r.why}`);
          throw new AwsError("UnauthorizedOperation", `You are not authorized to perform this operation. Encoded authorization failure message: ${encode(a, c.who, action, resource, r)}`);
        }
        throw new AwsError(DENY_CODE[service] || "AccessDeniedException", `User: ${c.who.arn} is not authorized to perform: ${action} on resource: ${res} ${r.why}`);
      },
      policy(n, err) {
        const text = c.opt(n);
        try { const d = JSON.parse(text); if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(); return d; } catch { throw err; }
      }
    };
    return c;
  }
  // EC2 hides why a write was denied in an encoded message; sts can decode it.
  function encode(a, who, action, resource, r) {
    const id = blob(`${who.arn}${action}${resource}${a.seq}`, 380).replace(/\+/g, "-").replace(/\//g, "_");
    a.encoded = a.encoded || {};
    a.encoded[id] = { allowed: false, explicitDeny: /explicit deny/.test(r.why), matchedStatements: { items: [] }, failures: { items: [] },
      context: { principal: { id: who.uniqueId ? (who.kind === "role" ? `${who.uniqueId}:${who.session}` : who.uniqueId) : ACCOUNT, name: who.name || who.session, arn: who.arn }, action, resource,
        conditions: { items: [{ key: "aws:Region", values: { items: [{ value: REGION }] } }, { key: "aws:Account", values: { items: [{ value: ACCOUNT }] } }] } } };
    return id;
  }

  function aws(a, argv, inside) {
    const lines = [];
    const say = (t, cls) => lines.push([t, cls]);
    const { o: g, pos } = parseOpts(argv);
    if (g.version) return [["aws-cli/2.31.2 Python/3.13.7 Linux/6.8.0-1036-aws exe/x86_64.ubuntu.24"]];
    const [svc, op, ...extra] = pos;
    if (!svc || svc === "help") {
      if (svc === "help") return HELP_AWS.map((t) => [t, "dim"]);
      return [...USAGE, "aws: [ERROR]: the following arguments are required: command"].map((t) => [t, t.startsWith("aws:") ? "warn" : null]);
    }
    const S = SERVICES[svc];
    if (!S) return [...USAGE.map((t) => [t]), [`aws: [ERROR]: argument command: Found invalid choice '${svc}'`, "warn"], [NOTE_MODEL, "dim"]];
    if (!op || op === "help") return [[`${svc} commands in this playground: ${Object.keys(S).join(", ")}`, "dim"]];
    const spec = S[op];
    if (!spec) return [...USAGE.map((t) => [t]), [`aws: [ERROR]: argument operation: Found invalid choice '${op}'`, "warn"], [NOTE_MODEL, "dim"]];
    const region = (Array.isArray(g.region) && g.region[0]) || a.env.AWS_REGION || a.env.AWS_DEFAULT_REGION || REGION;
    const src = credSource(a, Array.isArray(g.profile) ? g.profile[0] : null, inside);
    const c = makeCtx(a, svc, op, g, extra, region, src);
    let result;
    try {
      if (spec.noAuth !== true) {
        c.who = whoAmI(a, src, c.opName, svc);
        if (!spec.own) c.allow(spec.action || `${PREFIX[svc]}:${c.opName}`, "*");
      }
      result = (spec.run || spec)(c, say);
      if (spec.write) a.events.unshift({ name: c.opName, source: `${PREFIX[svc]}.amazonaws.com`, user: c.who ? (c.who.name || c.who.session || "root") : "", key: src.kind === "env" ? src.key : null, at: a.now, res: [] });
    } catch (e) {
      if (e instanceof AwsError) {
        if (spec.s3fail) return [...lines, [spec.s3fail(c, e), "warn"]];
        return [...lines, ["", null], [`An error occurred (${e.code}) when calling the ${c.opName} operation${e.retries ? ` (reached max retries: ${e.retries})` : ""}: ${e.message}`, "warn"]];
      }
      if (e instanceof ArgError) return [...lines, ["", null], [e.message, "warn"]];
      throw e;
    }
    if (result === undefined || result === null) return lines;
    const q = Array.isArray(g.query) ? g.query[0] : null;
    let data = result;
    if (q) {
      try { data = query(q, result); } catch (err) { return [[`Bad value for --query ${q}: ${err.message}`, "warn"]]; }
    }
    const fmt = (Array.isArray(g.output) && g.output[0]) || "json";
    if (fmt === "text") return [...lines, ...textOut(data).map((t) => [t, "row"])];
    if (fmt === "table") return [...lines, ...json(data).split("\n").map((t) => [t]), ["(This playground prints json for --output table.)", "dim"]];
    if (fmt !== "json" && fmt !== "yaml") return [[`aws: [ERROR]: argument --output: Found invalid choice '${fmt}'`, "warn"]];
    return [...lines, ...(data === null ? ["null"] : json(data).split("\n")).map((t) => [t])];
  }
  const NOTE_MODEL = "(The playground models the commands its scenarios need. Type 'help' to see them.)";

  // --- STS and credentials ---

  const userId = (who) => (who.root ? ACCOUNT : who.kind === "role" ? `${who.uniqueId}:${who.session}` : who.uniqueId);
  const STS = {
    "get-caller-identity": { own: true, run: (c) => ({ UserId: userId(c.who), Account: c.who.account, Arn: c.who.arn }) },
    "assume-role": { own: true, run(c) {
      c.need("role-arn", "role-session-name");
      const arn = c.opt("role-arn"), session = c.opt("role-session-name");
      const m = /^arn:aws:iam::(\d{12}):role\/(?:.*\/)?([\w+=,.@-]+)$/.exec(arn);
      if (!m) throw new AwsError("ValidationError", `${arn} is invalid`);
      const role = c.a.iam.roles[m[2]];
      if (!role || m[1] !== ACCOUNT || !c.a.canAssume(c.who, m[2])) throw new AwsError("AccessDenied", `User: ${c.who.arn} is not authorized to perform: sts:AssumeRole on resource: ${arn}`);
      const dur = c.num("duration-seconds") || 3600;
      if (dur > role.maxSession) throw new AwsError("ValidationError", `The requested DurationSeconds exceeds the MaxSessionDuration set for this role.`);
      const id = keyId("ASIA", session + c.a.seq);
      c.a.creds[id] = { id, secret: blob("ss" + id, 40), token: blob("tok" + id, 120), session: true, who: { kind: "role", role: m[2], session }, status: "Active", created: c.a.now, expires: c.a.now + dur * 1000 };
      return { Credentials: { AccessKeyId: id, SecretAccessKey: c.a.creds[id].secret, SessionToken: c.a.creds[id].token, Expiration: ts(c.a.now + dur * 1000) },
        AssumedRoleUser: { AssumedRoleId: `${role.id}:${session}`, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${m[2]}/${session}` } };
    } },
    "assume-role-with-web-identity": { noAuth: true, run(c) {
      c.need("role-arn", "role-session-name", "web-identity-token");
      const arn = c.opt("role-arn"), session = c.opt("role-session-name");
      let claims;
      try { claims = JSON.parse(c.opt("web-identity-token")); } catch { throw new AwsError("InvalidIdentityToken", "Couldn't retrieve verification key from your identity provider,  please reference AssumeRoleWithWebIdentity documentation for requirements"); }
      const name = arn.split("/").pop();
      if (!webIdentityOk(c.a, name, claims || {})) throw new AwsError("AccessDenied", "Not authorized to perform sts:AssumeRoleWithWebIdentity");
      const id = keyId("ASIA", "gh" + session + c.a.seq);
      c.a.creds[id] = { id, secret: blob("wi" + id, 40), token: blob("witok" + id, 120), session: true, who: { kind: "role", role: name, session }, status: "Active", created: c.a.now, expires: c.a.now + HOUR };
      return { Credentials: { AccessKeyId: id, SecretAccessKey: c.a.creds[id].secret, SessionToken: c.a.creds[id].token, Expiration: ts(c.a.now + HOUR) },
        SubjectFromWebIdentityToken: claims.sub, AssumedRoleUser: { AssumedRoleId: `${c.a.iam.roles[name].id}:${session}`, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${name}/${session}` },
        Provider: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`, Audience: claims.aud };
    } },
    "decode-authorization-message": { action: "sts:DecodeAuthorizationMessage", run(c) {
      c.need("encoded-message");
      const d = (c.a.encoded || {})[c.opt("encoded-message")];
      if (!d) throw new AwsError("InvalidAuthorizationMessageException", "Message is not valid");
      return { DecodedMessage: JSON.stringify(d) };
    } }
  };

  // aws configure and aws sso: where credentials come from.
  const mask = (s) => (s ? "****************" + s.slice(-4) : "<not set>");
  const CONFIGURE = {
    list: { noAuth: true, run(c, say) {
      const src = c.src, p = src.kind === "profile" ? src.p || {} : {};
      const row = (n, v, t, l) => say(`${n.padStart(10)} ${String(v).padStart(24)} ${String(t).padStart(16)}    ${l}`, "row");
      say("      Name                    Value             Type    Location", "head");
      say("      ----                    -----             ----    --------", "head");
      row("profile", src.kind === "profile" && src.name !== "default" ? src.name : "<not set>", src.kind === "profile" && src.name !== "default" ? (c.o.profile ? "manual" : "env") : "None", src.kind === "profile" && src.name !== "default" && !c.o.profile ? "['AWS_PROFILE', 'AWS_DEFAULT_PROFILE']" : (c.o.profile ? "--profile" : "None"));
      if (src.kind === "env") { row("access_key", mask(src.key), "env", ""); row("secret_key", mask(src.secret), "env", ""); }
      else if (p.sso) { row("access_key", "****************" + keyId("ASIA", p.session).slice(-4), "sso", ""); row("secret_key", "****************" + blob(p.session, 4), "sso", ""); }
      else if (p.key) { row("access_key", mask(p.key), "shared-credentials-file", ""); row("secret_key", mask(p.secret), "shared-credentials-file", ""); }
      else { row("access_key", "<not set>", "None", "None"); row("secret_key", "<not set>", "None", "None"); }
      row("region", c.region, c.o.region ? "--region" : c.a.env.AWS_REGION ? "env" : "config-file", c.o.region || c.a.env.AWS_REGION ? "" : "~/.aws/config");
    } },
    "list-profiles": { noAuth: true, run: (c, say) => Object.keys(c.a.profiles).forEach((n) => say(n)) },
    get: { noAuth: true, run(c, say) { const k = c.pos[0]; if (k === "region") say(REGION); else if (k === "sso_start_url") say("https://quest-kitchen.awsapps.com/start"); } },
    set: { noAuth: true, run(c) {
      const [k, v] = c.pos;
      const name = (c.o.profile && c.o.profile[0]) || "default";
      const p = c.a.profiles[name] || (c.a.profiles[name] = {});
      if (k === "aws_access_key_id") { delete p.sso; p.key = v; }
      else if (k === "aws_secret_access_key") p.secret = v;
      else if (k === "retry_mode" || k === "max_attempts") p[k] = v;
      else if (k !== "region" && k !== "output") throw new ArgError(`(The playground stores aws_access_key_id, aws_secret_access_key, region, output, retry_mode and max_attempts.)`);
    } }
  };
  const SSO = {
    login: { noAuth: true, run(c, say) {
      c.a.sso.valid = true;
      say("Attempting to open your default browser.");
      say("If the browser does not open, open the following URL:");
      say("");
      say("https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=quest-kitchen-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A53311%2Foauth%2Fcallback");
      say("Successfully logged into Start URL: https://quest-kitchen.awsapps.com/start");
    } },
    logout: { noAuth: true, run(c) { c.a.sso.valid = false; } }
  };

  // --- IAM ---

  const iamArn = (kind, name) => `arn:aws:iam::${ACCOUNT}:${kind}/${name}`;
  const malformed = (msg) => new AwsError("MalformedPolicyDocument", msg);
  // IAM checks a policy before storing it, as the real service does.
  function checkPolicy(c, name, trust) {
    const d = c.policy(name, malformed("Syntax errors in policy."));
    const list = asList(d.Statement);
    if (!list.length) throw malformed("Syntax errors in policy.");
    for (const st of list) {
      if (!st || !["Allow", "Deny"].includes(st.Effect)) throw malformed("Syntax errors in policy.");
      if (!trust && (st.Principal || st.NotPrincipal)) throw malformed("Policy document should not specify a principal.");
      if (!trust && st.Resource === undefined && st.NotResource === undefined) throw malformed("Policy statement must contain resources.");
      if (st.Action === undefined && st.NotAction === undefined) throw malformed("Policy statement must contain actions.");
      if (trust) {
        if (!st.Principal) throw malformed("AssumeRolepolicy contained an invalid principal: \"\"");
        for (const p of asList(st.Principal.AWS)) {
          const m = /^arn:aws:iam::(\d{12}):(user|role)\/(.+)$/.exec(p);
          if (m && m[1] === ACCOUNT && !(m[2] === "user" ? c.a.iam.users[m[3]] : c.a.iam.roles[m[3]])) throw malformed(`Invalid principal in policy: "AWS":"${p}"`);
        }
      }
    }
    return JSON.stringify(d);
  }
  function entity(c, kind) {
    const name = c.opt(kind === "user" ? "user-name" : kind === "role" ? "role-name" : "group-name");
    const ent = c.a.iam[kind + "s"][name];
    if (!ent) throw new AwsError("NoSuchEntity", `The ${kind} with name ${name} cannot be found.`);
    c.allow(`iam:${c.opName}`, iamArn(kind, name));
    return ent;
  }
  const policyExists = (a, arn) => Boolean(a.policyDoc(arn));
  const attachedList = (a, ent) => ({ AttachedPolicies: ent.attached.map((arn) => ({ PolicyName: arn.split("/").pop(), PolicyArn: arn })) });
  function userJson(a, u) { return { Path: "/", UserName: u.name, UserId: u.id, Arn: iamArn("user", u.name), CreateDate: ts(u.created) }; }
  function roleJson(a, r, full) {
    const out = { Path: "/", RoleName: r.name, RoleId: r.id, Arn: iamArn("role", r.name), CreateDate: ts(r.created), AssumeRolePolicyDocument: parseDoc(r.trust), MaxSessionDuration: r.maxSession };
    if (full && r.boundary) out.PermissionsBoundary = { PermissionsBoundaryType: "Policy", PermissionsBoundaryArn: r.boundary };
    if (full) out.RoleLastUsed = {};
    return out;
  }
  const iamOps = {};
  for (const kind of ["user", "role", "group"]) {
    const K = kind[0].toUpperCase() + kind.slice(1);
    iamOps[`list-attached-${kind}-policies`] = { own: true, run: (c) => { c.need(`${kind}-name`); return attachedList(c.a, entity(c, kind)); } };
    if (kind === "group") continue;
    iamOps[`list-${kind}-policies`] = { own: true, run: (c) => { c.need(`${kind}-name`); return { PolicyNames: Object.keys(entity(c, kind).inline) }; } };
    iamOps[`get-${kind}-policy`] = { own: true, run(c) {
      c.need(`${kind}-name`, "policy-name");
      const ent = entity(c, kind), name = c.opt("policy-name");
      if (!ent.inline[name]) throw new AwsError("NoSuchEntity", `The ${kind} policy with name ${name} cannot be found.`);
      return { [`${K}Name`]: ent.name, PolicyName: name, PolicyDocument: parseDoc(ent.inline[name]) };
    } };
    iamOps[`put-${kind}-policy`] = { own: true, write: true, run(c) {
      c.need(`${kind}-name`, "policy-name", "policy-document");
      const ent = entity(c, kind);
      ent.inline[c.opt("policy-name")] = checkPolicy(c, "policy-document");
    } };
    iamOps[`delete-${kind}-policy`] = { own: true, write: true, run(c) {
      c.need(`${kind}-name`, "policy-name");
      const ent = entity(c, kind), name = c.opt("policy-name");
      if (!ent.inline[name]) throw new AwsError("NoSuchEntity", `The ${kind} policy with name ${name} cannot be found.`);
      delete ent.inline[name];
    } };
    for (const verb of ["attach", "detach"]) {
      iamOps[`${verb}-${kind}-policy`] = { own: true, write: true, run(c) {
        c.need(`${kind}-name`, "policy-arn");
        const ent = entity(c, kind), arn = c.opt("policy-arn");
        if (!policyExists(c.a, arn)) throw new AwsError("NoSuchEntity", `Policy ${arn} does not exist or is not attachable.`);
        if (verb === "attach") { if (!ent.attached.includes(arn)) ent.attached.push(arn); }
        else if (!ent.attached.includes(arn)) throw new AwsError("NoSuchEntity", `Policy ${arn} was not found.`);
        else ent.attached = ent.attached.filter((x) => x !== arn);
      } };
    }
  }
  function keyOwner(c) {
    const name = c.opt("user-name");
    if (name) return entity(c, "user");
    if (c.who.root) return null;
    if (c.who.kind === "user") return c.a.iam.users[c.who.name];
    throw new AwsError("ValidationError", "Must specify userName when calling with non-User credentials");
  }
  function findKey(c, owner) {
    const id = c.opt("access-key-id");
    const list = owner ? owner.keys : c.a.iam.rootKeys;
    if (!list.includes(id)) throw new AwsError("NoSuchEntity", `The Access Key with id ${id} cannot be found.`);
    return id;
  }
  Object.assign(iamOps, {
    "list-users": (c) => ({ Users: Object.values(c.a.iam.users).map((u) => userJson(c.a, u)) }),
    "get-user": { own: true, run(c) {
      if (!c.opt("user-name") && c.who.root) return { User: { UserId: ACCOUNT, Arn: c.who.arn, CreateDate: ts(START - 900 * DAY), PasswordLastUsed: ts(START - 2 * HOUR) } };
      const u = c.opt("user-name") ? entity(c, "user") : c.who.kind === "user" ? c.a.iam.users[c.who.name] : null;
      if (!u) throw new AwsError("ValidationError", "Must specify userName when calling with non-User credentials");
      return { User: userJson(c.a, u) };
    } },
    "list-roles": (c) => ({ Roles: Object.values(c.a.iam.roles).map((r) => roleJson(c.a, r)) }),
    "get-role": { own: true, run: (c) => { c.need("role-name"); return { Role: roleJson(c.a, entity(c, "role"), true) }; } },
    "list-groups-for-user": { own: true, run: (c) => { c.need("user-name"); return { Groups: entity(c, "user").groups.map((gname) => ({ Path: "/", GroupName: gname, GroupId: keyId("AGPA", gname), Arn: iamArn("group", gname), CreateDate: ts(START - 200 * DAY) })) }; } },
    "update-assume-role-policy": { own: true, write: true, run(c) {
      c.need("role-name", "policy-document");
      const r = entity(c, "role");
      r.trust = checkPolicy(c, "policy-document", true);
    } },
    "list-policies": (c) => {
      const scope = c.opt("scope") || "All";
      const local = Object.values(c.a.iam.policies).map((p) => ({ PolicyName: p.name, PolicyId: keyId("ANPA", p.name), Arn: p.arn, Path: "/", DefaultVersionId: `v${p.version}`, AttachmentCount: 1, IsAttachable: true, CreateDate: ts(p.created) }));
      const aws = Object.keys(AWS_POLICIES).map((n) => ({ PolicyName: n, PolicyId: keyId("ANPA", n), Arn: awsPolicyArn(n), Path: "/", DefaultVersionId: "v1", AttachmentCount: 0, IsAttachable: true }));
      return { Policies: scope === "Local" ? local : scope === "AWS" ? aws : [...local, ...aws] };
    },
    "get-policy": { own: true, run(c) {
      c.need("policy-arn");
      const arn = c.opt("policy-arn");
      if (!policyExists(c.a, arn)) throw new AwsError("NoSuchEntity", `Policy ${arn} was not found.`);
      c.allow("iam:GetPolicy", arn);
      const p = c.a.iam.policies[arn];
      return { Policy: { PolicyName: arn.split("/").pop(), PolicyId: keyId("ANPA", arn.split("/").pop()), Arn: arn, Path: "/", DefaultVersionId: `v${p ? p.version : 1}`, AttachmentCount: 1, IsAttachable: true } };
    } },
    "get-policy-version": { own: true, run(c) {
      c.need("policy-arn", "version-id");
      const arn = c.opt("policy-arn");
      const p = c.a.iam.policies[arn];
      if (!policyExists(c.a, arn) || (p && c.opt("version-id") !== `v${p.version}`) || (!p && c.opt("version-id") !== "v1")) throw new AwsError("NoSuchEntity", `Policy ${arn} version ${c.opt("version-id")} does not exist or is not attachable.`);
      c.allow("iam:GetPolicyVersion", arn);
      return { PolicyVersion: { Document: c.a.policyDoc(arn), VersionId: c.opt("version-id"), IsDefaultVersion: true, CreateDate: ts(p ? p.created : START - 900 * DAY) } };
    } },
    "create-policy-version": { own: true, write: true, run(c) {
      c.need("policy-arn", "policy-document");
      const p = c.a.iam.policies[c.opt("policy-arn")];
      if (!p) throw new AwsError("NoSuchEntity", `Policy ${c.opt("policy-arn")} was not found.`);
      c.allow("iam:CreatePolicyVersion", p.arn);
      const d = checkPolicy(c, "policy-document");
      if (!c.flag("set-as-default")) return { PolicyVersion: { VersionId: `v${p.version + 1}`, IsDefaultVersion: false, CreateDate: ts(c.a.now) } };
      p.doc = d; p.version++;
      return { PolicyVersion: { VersionId: `v${p.version}`, IsDefaultVersion: true, CreateDate: ts(c.a.now) } };
    } },
    "list-access-keys": { own: true, run(c) {
      const owner = keyOwner(c);
      const ids = owner ? owner.keys : c.a.iam.rootKeys;
      return { AccessKeyMetadata: ids.map((id) => ({ ...(owner ? { UserName: owner.name } : {}), AccessKeyId: id, Status: c.a.creds[id].status, CreateDate: ts(c.a.creds[id].created) })) };
    } },
    "get-access-key-last-used": { run(c) {
      c.need("access-key-id");
      const k = c.a.creds[c.opt("access-key-id")];
      if (!k || k.session) throw new AwsError("AccessDenied", `User: ${c.who.arn} is not authorized to perform: iam:GetAccessKeyLastUsed on resource: access key ${c.opt("access-key-id")}`);
      return { UserName: k.who.name || "root", AccessKeyLastUsed: { LastUsedDate: ts(k.lastUsed), ServiceName: k.lastService || "s3", Region: k.lastRegion || REGION } };
    } },
    "update-access-key": { own: true, write: true, run(c) {
      c.need("access-key-id", "status");
      const owner = keyOwner(c), id = findKey(c, owner);
      if (!["Active", "Inactive"].includes(c.opt("status"))) throw new ArgError(`aws: [ERROR]: argument --status: Found invalid choice '${c.opt("status")}'`);
      c.a.creds[id].status = c.opt("status");
    } },
    "delete-access-key": { own: true, write: true, run(c) {
      c.need("access-key-id");
      const owner = keyOwner(c), id = findKey(c, owner);
      if (owner) owner.keys = owner.keys.filter((x) => x !== id); else c.a.iam.rootKeys = c.a.iam.rootKeys.filter((x) => x !== id);
      delete c.a.creds[id];
    } },
    "create-access-key": { own: true, write: true, run(c) {
      const owner = keyOwner(c);
      if ((owner ? owner.keys : c.a.iam.rootKeys).length >= 2) throw new AwsError("LimitExceeded", "Cannot exceed quota for AccessKeysPerUser: 2");
      const k = c.a.addKey(owner, `${owner ? owner.name : "root"}new${c.a.seq}`, { created: c.a.now, lastUsed: null });
      return { AccessKey: { ...(owner ? { UserName: owner.name } : {}), AccessKeyId: k.id, Status: "Active", SecretAccessKey: k.secret, CreateDate: ts(c.a.now) } };
    } },
    "get-account-summary": (c) => ({ SummaryMap: { AccountAccessKeysPresent: c.a.iam.rootKeys.length, AccountMFAEnabled: c.a.iam.rootMfa ? 1 : 0, AccountSigningCertificatesPresent: 0,
      Users: Object.keys(c.a.iam.users).length, Roles: Object.keys(c.a.iam.roles).length, Policies: Object.keys(c.a.iam.policies).length, Groups: Object.keys(c.a.iam.groups).length,
      MFADevices: Object.values(c.a.iam.users).filter((u) => u.mfa).length, MFADevicesInUse: Object.values(c.a.iam.users).filter((u) => u.mfa).length, UsersQuota: 5000, RolesQuota: 1000 } }),
    "simulate-principal-policy": { run(c) {
      c.need("policy-source-arn", "action-names");
      const src = c.opt("policy-source-arn");
      const m = /^arn:aws:iam::\d{12}:(user|role)\/(.+)$/.exec(src);
      if (!m || !(m[1] === "user" ? c.a.iam.users[m[2]] : c.a.iam.roles[m[2]])) throw new AwsError("NoSuchEntity", `PolicySourceEntity ${src} does not exist.`);
      const who = m[1] === "user" ? c.a.user(m[2]) : c.a.role(m[2]);
      const resources = c.list("resource-arns").length ? c.list("resource-arns") : ["*"];
      return { EvaluationResults: c.list("action-names").flatMap((action) => resources.map((res) => {
        const r = evaluate(c.a, { ...who, boundary: who.boundary }, action, res, { keys: {} });
        return { EvalActionName: action, EvalResourceName: res, EvalDecision: r.allowed ? "allowed" : /explicit deny/.test(r.why) ? "explicitDeny" : "implicitDeny", MatchedStatements: [], MissingContextValues: [] };
      })) };
    } }
  });

  // --- EC2 and VPC ---

  const STATE_CODE = { pending: 0, running: 16, "shutting-down": 32, terminated: 48, stopping: 64, stopped: 80 };
  const tagList = (tags) => Object.entries(tags || {}).map(([Key, Value]) => ({ Key, Value }));
  const nameTag = (name) => (name ? [{ Key: "Name", Value: name }] : []);
  // --filters Name=x,Values=a,b ...
  function filtersOf(c) {
    return (c.o.filters && c.o.filters !== true ? c.o.filters : []).map((f) => {
      const s = shorthand(f) || {};
      return { name: s.Name, values: asList(s.Values) };
    });
  }
  const passes = (filters, get) => filters.every((f) => { const v = get(f.name); return asList(v).some((x) => f.values.some((w) => glob(w, String(x)))); });
  function instanceJson(a, i) {
    const pub = a.publicIpOf(i);
    const sub = a.sub(i.subnet);
    return { AmiLaunchIndex: 0, ImageId: i.ami, InstanceId: i.id, InstanceType: i.type, LaunchTime: ts(i.launched), Monitoring: { State: "disabled" },
      Placement: { AvailabilityZone: sub.az, GroupName: "", Tenancy: "default" }, PrivateDnsName: `ip-${i.ip.replace(/\./g, "-")}.ec2.internal`, PrivateIpAddress: i.ip,
      PublicDnsName: pub ? `ec2-${pub.replace(/\./g, "-")}.compute-1.amazonaws.com` : "", ...(pub ? { PublicIpAddress: pub } : {}),
      State: { Code: STATE_CODE[i.state], Name: i.state }, SubnetId: i.subnet, VpcId: sub.vpc, Architecture: "x86_64",
      ...(i.role ? { IamInstanceProfile: { Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/${i.role}`, Id: keyId("AIPA", i.role) } } : {}),
      SecurityGroups: i.sgs.map((id) => ({ GroupId: id, GroupName: (a.sg(id) || {}).name })),
      Tags: tagList(i.tags), MetadataOptions: { State: "applied", HttpTokens: i.imds.tokens, HttpPutResponseHopLimit: i.imds.hop, HttpEndpoint: i.imds.endpoint, HttpProtocolIpv6: "disabled", InstanceMetadataTags: "disabled" } };
  }
  function findInstances(c, ids) {
    return ids.map((id) => {
      if (!/^i-[0-9a-f]{8,17}$/.test(id)) throw new AwsError("InvalidInstanceID.Malformed", `Invalid id: "${id}"`);
      const i = c.a.instances.find((x) => x.id === id && x.state !== "gone");
      if (!i) throw new AwsError("InvalidInstanceID.NotFound", `The instance ID '${id}' does not exist`);
      return i;
    });
  }
  const instArn = (i) => `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${i.id}`;
  function changeState(c, key, to, from, deny) {
    c.need("instance-ids");
    const list = findInstances(c, c.list("instance-ids"));
    for (const i of list) c.allow(`ec2:${c.opName}`, instArn(i), { keys: Object.fromEntries(Object.entries(i.tags).map(([k, v]) => [`aws:ResourceTag/${k}`, v]).concat(Object.entries(i.tags).map(([k, v]) => [`ec2:ResourceTag/${k}`, v]))) });
    for (const i of list) if (deny && deny(i)) throw new AwsError("IncorrectInstanceState", deny(i));
    return { [key]: list.map((i) => {
      const prev = i.state;
      if (from.includes(i.state)) i.state = to;
      return { CurrentState: { Code: STATE_CODE[i.state], Name: i.state }, InstanceId: i.id, PreviousState: { Code: STATE_CODE[prev], Name: prev } };
    }) };
  }
  function sgJson(a, g) {
    const perm = (rules) => {
      const groups = new Map();
      for (const r of rules) {
        const k = `${r.proto}:${r.from}:${r.to}`;
        if (!groups.has(k)) groups.set(k, { ...(r.proto === "-1" ? {} : { FromPort: r.from }), IpProtocol: r.proto, IpRanges: [], Ipv6Ranges: [], PrefixListIds: [], ...(r.proto === "-1" ? {} : { ToPort: r.to }), UserIdGroupPairs: [] });
        const p = groups.get(k);
        if (r.cidr) p.IpRanges.push({ CidrIp: r.cidr, ...(r.desc ? { Description: r.desc } : {}) });
        if (r.sg) p.UserIdGroupPairs.push({ ...(r.desc ? { Description: r.desc } : {}), GroupId: r.sg, UserId: ACCOUNT });
      }
      return [...groups.values()];
    };
    return { Description: g.desc, GroupName: g.name, IpPermissions: perm(g.in), OwnerId: ACCOUNT, GroupId: g.id, IpPermissionsEgress: perm(g.out), VpcId: g.vpc, Tags: g.name === "default" ? [] : nameTag(g.name) };
  }
  // The rule an authorize/revoke call describes, from --protocol/--port/--cidr or --ip-permissions.
  function sgRules(c) {
    const rules = [];
    if (c.o["ip-permissions"]) {
      for (const raw of c.list("ip-permissions")) {
        const p = typeof raw === "object" ? raw : shorthand(raw) || {};
        const proto = String(p.IpProtocol === "all" ? "-1" : p.IpProtocol);
        const from = proto === "-1" ? 0 : Number(p.FromPort), to = proto === "-1" ? 65535 : Number(p.ToPort);
        for (const r of asList(p.IpRanges)) rules.push({ proto, from, to, cidr: typeof r === "object" ? r.CidrIp : String(r).replace(/^\{?CidrIp=|\}$/g, "") });
        for (const r of asList(p.UserIdGroupPairs)) rules.push({ proto, from, to, sg: typeof r === "object" ? r.GroupId : String(r).replace(/^\{?GroupId=|\}$/g, "") });
      }
      if (!rules.length) throw new ArgError("Error parsing parameter '--ip-permissions': Expected: '=', received: 'EOF' for input");
      return rules;
    }
    c.need("protocol");
    let proto = c.opt("protocol").toLowerCase();
    if (proto === "all") proto = "-1";
    if (!["tcp", "udp", "icmp", "-1"].includes(proto)) throw new AwsError("InvalidParameterValue", `Invalid value '${proto}' for IP protocol. Unknown protocol.`);
    let from = 0, to = 65535;
    if (proto !== "-1") {
      const port = c.opt("port");
      if (port === undefined) throw new AwsError("InvalidParameterValue", "Invalid value 'Must specify both from and to ports with TCP/UDP.' for portRange");
      const m = /^(-?\d+)(?:-(\d+))?$/.exec(port);
      if (!m) throw new ArgError(`aws: [ERROR]: argument --port: Expected a port or a range, got: '${port}'`);
      from = Number(m[1]); to = Number(m[2] || m[1]);
    }
    if (c.opt("source-group")) {
      const g = c.a.sg(c.opt("source-group"));
      if (!g) throw new AwsError("InvalidGroup.NotFound", `The security group '${c.opt("source-group")}' does not exist`);
      return [{ proto, from, to, sg: g.id }];
    }
    const cidr = c.opt("cidr");
    if (!cidr) throw new AwsError("MissingParameter", "Either 'cidrIp' or 'sourceGroup' or 'ipPermissions' must be specified");
    if (!validCidr(cidr)) throw new AwsError("InvalidParameterValue", `CIDR block ${cidr} is malformed`);
    return [{ proto, from, to, cidr }];
  }
  const sameRule = (x, y) => x.proto === y.proto && x.from === y.from && x.to === y.to && x.cidr === y.cidr && x.sg === y.sg;
  const ruleText = (r) => `peer: ${r.cidr || r.sg}, ${r.proto === "-1" ? "ALL" : r.proto.toUpperCase()}, from port: ${r.from}, to port: ${r.to}, ALLOW`;
  function editSg(c, dir, add) {
    const g = c.a.sg(c.opt("group-id") || c.opt("group-name") || "");
    if (!g) throw new AwsError("InvalidGroup.NotFound", `The security group '${c.opt("group-id") || c.opt("group-name")}' does not exist`);
    const rules = sgRules(c);
    for (const r of rules) {
      const has = g[dir].some((x) => sameRule(x, r));
      if (add && has) throw new AwsError("InvalidPermission.Duplicate", `the specified rule "${ruleText(r)}" already exists`);
      if (!add && !has) throw new AwsError("InvalidPermission.NotFound", "The specified rule does not exist in this security group.");
    }
    for (const r of rules) g[dir] = add ? [...g[dir], r] : g[dir].filter((x) => !sameRule(x, r));
    return add ? { Return: true, SecurityGroupRules: rules.map((r, n) => ({ SecurityGroupRuleId: rid("sgr", g.id + JSON.stringify(r) + n), GroupId: g.id, GroupOwnerId: ACCOUNT, IsEgress: dir === "out",
      IpProtocol: r.proto, FromPort: r.proto === "-1" ? -1 : r.from, ToPort: r.proto === "-1" ? -1 : r.to, ...(r.cidr ? { CidrIpv4: r.cidr } : { ReferencedGroupInfo: { GroupId: r.sg, UserId: ACCOUNT } }) })) } : { Return: true };
  }
  function naclJson(a, n) {
    const entry = (e) => ({ CidrBlock: e.cidr, Egress: e.egress, Protocol: e.proto, RuleAction: e.action, RuleNumber: e.n, ...(e.proto !== "-1" ? { PortRange: { From: e.from, To: e.to } } : {}) });
    const deny = (egress) => ({ CidrBlock: "0.0.0.0/0", Egress: egress, Protocol: "-1", RuleAction: "deny", RuleNumber: 32767 });
    return { Associations: n.subnets.map((s) => ({ NetworkAclAssociationId: rid("aclassoc", n.id + s), NetworkAclId: n.id, SubnetId: s })),
      Entries: [...n.entries.filter((e) => e.egress).map(entry), deny(true), ...n.entries.filter((e) => !e.egress).map(entry), deny(false)],
      IsDefault: n.isDefault, NetworkAclId: n.id, Tags: nameTag(n.name), VpcId: n.vpc, OwnerId: ACCOUNT };
  }
  function nacl(c) {
    const n = c.a.nacls.find((x) => x.id === c.opt("network-acl-id"));
    if (!n) throw new AwsError("InvalidNetworkAclID.NotFound", `The network ACL '${c.opt("network-acl-id")}' does not exist`);
    return n;
  }
  function naclEntry(c) {
    c.need("network-acl-id", "rule-number", "protocol", "rule-action");
    let proto = c.opt("protocol").toLowerCase();
    proto = { tcp: "6", udp: "17", icmp: "1", all: "-1" }[proto] || proto;
    const range = shorthand(c.opt("port-range") || "") || {};
    if (proto !== "-1" && (range.From === undefined || range.To === undefined)) throw new AwsError("InvalidParameterValue", "Invalid value 'null' for portRange. Must specify both from and to ports with TCP/UDP.");
    const cidr = c.opt("cidr-block");
    if (!validCidr(cidr)) throw new AwsError("InvalidParameterValue", `Value (${cidr}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
    return { n: c.num("rule-number"), egress: c.flag("egress"), proto, from: Number(range.From || 0), to: Number(range.To || 65535), cidr, action: c.opt("rule-action").toLowerCase() };
  }
  function rtJson(a, r) {
    return { Associations: [...(r.main ? [{ Main: true, RouteTableAssociationId: rid("rtbassoc", r.id), RouteTableId: r.id, AssociationState: { State: "associated" } }] : []),
      ...r.subnets.map((s) => ({ Main: false, RouteTableAssociationId: rid("rtbassoc", r.id + s), RouteTableId: r.id, SubnetId: s, AssociationState: { State: "associated" } }))],
      PropagatingVgws: [], RouteTableId: r.id,
      Routes: r.routes.map((x) => {
        const nat = x.target.startsWith("nat-") ? a.nats.find((n) => n.id === x.target) : null;
        const black = (x.target.startsWith("igw-") && !a.igwUp(x.target)) || (x.target.startsWith("nat-") && (!nat || nat.state === "deleted" || nat.state === "deleting"));
        return { ...(x.dest.startsWith("pl-") ? { DestinationPrefixListId: x.dest } : { DestinationCidrBlock: x.dest }), ...(x.target.startsWith("nat-") ? { NatGatewayId: x.target } : x.target.startsWith("pcx-") ? { VpcPeeringConnectionId: x.target } : { GatewayId: x.target }),
          Origin: x.target === "local" ? "CreateRouteTable" : x.target.startsWith("vpce-") ? "CreateRoute" : "CreateRoute", State: black ? "blackhole" : "active" };
      }), Tags: nameTag(r.name), VpcId: r.vpc, OwnerId: ACCOUNT };
  }
  function routeTable(c) {
    const r = c.a.rts.find((x) => x.id === c.opt("route-table-id"));
    if (!r) throw new AwsError("InvalidRouteTableID.NotFound", `The routeTable ID '${c.opt("route-table-id")}' does not exist`);
    return r;
  }
  function routeTarget(c) {
    const t = c.opt("gateway-id") || c.opt("nat-gateway-id") || c.opt("vpc-peering-connection-id");
    if (t && t.startsWith("pcx-")) { if (!c.a.peerings.some((x) => x.id === t)) throw new AwsError("InvalidVpcPeeringConnectionID.NotFound", `The vpcPeeringConnection ID '${t}' does not exist`); return t; }
    if (!t) throw new AwsError("MissingParameter", "The request must contain exactly one of gatewayId, natGatewayId, networkInterfaceId, vpcPeeringConnectionId or instanceId");
    if (t.startsWith("igw-") && !c.a.igws.some((g) => g.id === t)) throw new AwsError("InvalidGatewayID.NotFound", `The gateway ID '${t}' does not exist`);
    if (t.startsWith("nat-") && !c.a.nats.some((n) => n.id === t && n.state !== "deleted")) throw new AwsError("InvalidNatGatewayID.NotFound", `The natGateway ID '${t}' does not exist`);
    if (!/^(igw|nat)-/.test(t)) throw new AwsError("InvalidGatewayID.NotFound", `The gateway ID '${t}' does not exist`);
    return t;
  }
  function natJson(a, n) {
    const e = a.eips.find((x) => x.alloc === n.alloc);
    const sub = a.sub(n.subnet);
    return { CreateTime: ts(n.created), NatGatewayAddresses: [{ AllocationId: n.alloc, NetworkInterfaceId: rid("eni", n.id), PrivateIp: sub.cidr.replace(/0\/24$/, "200"), PublicIp: e ? e.ip : null, AssociationId: e ? e.assocId : null, IsPrimary: true, Status: "succeeded" }],
      NatGatewayId: n.id, State: n.state, SubnetId: n.subnet, VpcId: sub.vpc, Tags: nameTag(n.name), ConnectivityType: "public" };
  }
  function eip(c) {
    const e = c.a.eips.find((x) => x.alloc === c.opt("allocation-id") || (c.opt("public-ip") && x.ip === c.opt("public-ip")));
    if (!e) throw new AwsError("InvalidAllocationID.NotFound", `The allocation ID '${c.opt("allocation-id")}' does not exist`);
    return e;
  }
  function volJson(a, v) {
    return { Attachments: v.attached ? [{ AttachTime: ts(v.created), Device: v.device, InstanceId: v.attached, State: "attached", VolumeId: v.id, DeleteOnTermination: true }] : [],
      AvailabilityZone: "us-east-1a", CreateTime: ts(v.created), Encrypted: true, Size: v.size, SnapshotId: v.snap || "", State: v.attached ? "in-use" : "available", VolumeId: v.id, Iops: 3000,
      Tags: nameTag(v.name), VolumeType: v.type, MultiAttachEnabled: false, Throughput: 125 };
  }
  const snapJson = (s) => ({ Description: s.desc, Encrypted: true, OwnerId: ACCOUNT, Progress: "100%", SnapshotId: s.id, StartTime: ts3(s.created), State: "completed", VolumeId: s.vol, VolumeSize: s.size, StorageTier: "standard", Tags: nameTag(s.name) });
  const isVcpuFamily = (type) => /^[acdhimrtz]/.test(type);
  const vcpusUsed = (a) => a.instances.filter((i) => ["running", "pending"].includes(i.state) && isVcpuFamily(i.type)).reduce((n, i) => n + (PRICES.vcpus[i.type] || 2), 0);

  const EC2 = {
    "describe-instances": (c) => {
      const ids = c.list("instance-ids");
      const list = ids.length ? findInstances(c, ids) : c.a.instances.filter((i) => i.state !== "gone");
      const f = filtersOf(c);
      return { Reservations: list.filter((i) => passes(f, (n) => (n === "instance-state-name" ? i.state : n === "instance-id" ? i.id : n === "subnet-id" ? i.subnet : n === "vpc-id" ? c.a.sub(i.subnet).vpc :
        n === "instance-type" ? i.type : n === "private-ip-address" ? i.ip : n === "ip-address" ? c.a.publicIpOf(i) : n.startsWith("tag:") ? i.tags[n.slice(4)] : null)))
        .map((i) => ({ Groups: [], Instances: [instanceJson(c.a, i)], OwnerId: ACCOUNT, ReservationId: rid("r", i.id) })) };
    },
    "describe-instance-status": (c) => {
      const ids = c.list("instance-ids");
      const list = (ids.length ? findInstances(c, ids) : c.a.instances).filter((i) => c.flag("include-all-instances") || i.state === "running");
      const st = (ok, name) => ({ Details: [{ Name: "reachability", Status: ok ? "passed" : "failed", ...(ok ? {} : { ImpairedSince: ts(c.a.now - 2 * HOUR) }) }], Status: ok ? "ok" : "impaired" });
      return { InstanceStatuses: list.map((i) => ({ AvailabilityZone: c.a.sub(i.subnet).az, InstanceId: i.id, InstanceState: { Code: STATE_CODE[i.state], Name: i.state },
        ...(i.state === "running" ? { InstanceStatus: st(i.system === "ok", "instance"), SystemStatus: st(i.system === "ok", "system") } : { InstanceStatus: { Status: "not-applicable" }, SystemStatus: { Status: "not-applicable" } }) })) };
    },
    "start-instances": { own: true, write: true, run: (c) => changeState(c, "StartingInstances", "pending", ["stopped"]) },
    "stop-instances": { own: true, write: true, run: (c) => changeState(c, "StoppingInstances", "stopping", ["running", "pending"]) },
    "terminate-instances": { own: true, write: true, run: (c) => changeState(c, "TerminatingInstances", "shutting-down", ["running", "pending", "stopped", "stopping"]) },
    "reboot-instances": { own: true, write: true, run: (c) => { changeState(c, "x", "running", [], (i) => (i.state !== "running" ? `The instance '${i.id}' is not in a state from which it can be rebooted.` : null)); } },
    "run-instances": { own: true, write: true, run(c) {
      c.need("image-id");
      const type = c.opt("instance-type") || "m1.small";
      const sub = c.a.sub(c.opt("subnet-id") || "") || c.a.sub("public-a");
      if (c.opt("subnet-id") && !c.a.sub(c.opt("subnet-id"))) throw new AwsError("InvalidSubnetID.NotFound", `The subnet ID '${c.opt("subnet-id")}' does not exist`);
      c.allow("ec2:RunInstances", `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*`);
      const prof = c.opt("iam-instance-profile");
      const role = prof ? ((shorthand(prof) || {}).Name || (shorthand(prof) || {}).Arn || "").split("/").pop() : null;
      if (prof && !c.a.iam.roles[role]) throw new AwsError("InvalidParameterValue", `Value (${role}) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name`);
      if (role) c.allow("iam:PassRole", iamArn("role", role), { as: "ec2", keys: { "iam:PassedToService": "ec2.amazonaws.com" } });
      if (!PRICES.ec2[type]) throw new AwsError("InvalidParameterValue", `Invalid value '${type}' for InstanceType.`);
      if (c.a.capacityOut.includes(`${type}@${sub.az}`)) {
        const others = ["us-east-1b", "us-east-1c", "us-east-1d", "us-east-1f"].filter((z) => z !== sub.az);
        throw new AwsError("InsufficientInstanceCapacity", `We currently do not have sufficient ${type} capacity in the Availability Zone you requested (${sub.az}). Our system will be working on provisioning additional capacity. You can currently get ${type} capacity by not specifying an Availability Zone in your request or choosing ${others.join(", ")}.`, 2);
      }
      const count = Number(c.opt("count") || 1);
      const limit = c.a.quotas["L-1216C47A"];
      if (isVcpuFamily(type) && vcpusUsed(c.a) + count * (PRICES.vcpus[type] || 2) > limit) {
        throw new AwsError("VcpuLimitExceeded", `You have requested more vCPU capacity than your current vCPU limit of ${limit} allows for the instance bucket that the specified instance type belongs to. Please visit http://aws.amazon.com/contact-us/ec2-request to request an adjustment to this limit.`);
      }
      if (c.flag("dry-run")) throw new AwsError("DryRunOperation", "Request would have succeeded, but DryRun flag is set.");
      const tagSpec = c.opt("tag-specifications") || "";
      const name = (/Key=Name,Value=([\w.-]+)/.exec(tagSpec) || [])[1] || `instance-${c.a.seq}`;
      const sgs = c.list("security-group-ids");
      const made = [];
      for (let n = 0; n < count; n++) {
        const i = c.a.addInstance({ name: count > 1 ? `${name}-${n + 1}` : name, type, subnet: sub.name, sgs: sgs.length ? sgs : ["default"], role, state: "pending", launched: c.a.now, by: c.who.arn });
        made.push(instanceJson(c.a, i));
      }
      return { Groups: [], Instances: made, OwnerId: ACCOUNT, ReservationId: rid("r", made[0].InstanceId) };
    } },
    "modify-instance-metadata-options": { write: true, run(c) {
      c.need("instance-id");
      const [i] = findInstances(c, [c.opt("instance-id")]);
      for (const [opt, key, ok] of [["http-tokens", "tokens", ["optional", "required"]], ["http-endpoint", "endpoint", ["enabled", "disabled"]]]) {
        const v = c.opt(opt);
        if (v === undefined) continue;
        if (!ok.includes(v)) throw new ArgError(`aws: [ERROR]: argument --${opt}: Found invalid choice '${v}'`);
        i.imds[key] = v;
      }
      if (c.opt("http-put-response-hop-limit")) i.imds.hop = c.num("http-put-response-hop-limit");
      return { InstanceId: i.id, InstanceMetadataOptions: { State: "pending", HttpTokens: i.imds.tokens, HttpPutResponseHopLimit: i.imds.hop, HttpEndpoint: i.imds.endpoint, HttpProtocolIpv6: "disabled", InstanceMetadataTags: "disabled" } };
    } },
    "describe-security-groups": (c) => {
      const ids = [...c.list("group-ids"), ...c.list("group-names")];
      for (const id of ids) if (!c.a.sg(id)) throw new AwsError("InvalidGroup.NotFound", `The security group '${id}' does not exist`);
      const f = filtersOf(c);
      return { SecurityGroups: (ids.length ? ids.map((id) => c.a.sg(id)) : c.a.sgs).filter((g) => passes(f, (n) => (n === "group-name" ? g.name : n === "group-id" ? g.id : n === "vpc-id" ? g.vpc : n === "ip-permission.cidr" ? g.in.map((r) => r.cidr) : null))).map((g) => sgJson(c.a, g)) };
    },
    "authorize-security-group-ingress": { write: true, run: (c) => editSg(c, "in", true) },
    "revoke-security-group-ingress": { write: true, run: (c) => editSg(c, "in", false) },
    "authorize-security-group-egress": { write: true, run: (c) => editSg(c, "out", true) },
    "revoke-security-group-egress": { write: true, run: (c) => editSg(c, "out", false) },
    "describe-network-acls": (c) => {
      const f = filtersOf(c);
      const ids = c.list("network-acl-ids");
      return { NetworkAcls: c.a.nacls.filter((n) => (!ids.length || ids.includes(n.id)) && passes(f, (k) => (k === "association.subnet-id" ? n.subnets : k === "network-acl-id" ? n.id : k === "vpc-id" ? n.vpc : k === "default" ? String(n.isDefault) : null))).map((n) => naclJson(c.a, n)) };
    },
    "create-network-acl-entry": { write: true, run(c) {
      const n = nacl(c), e = naclEntry(c);
      if (n.entries.some((x) => x.n === e.n && x.egress === e.egress)) throw new AwsError("NetworkAclEntryAlreadyExists", `The network acl entry identified by ${e.n} already exists.`);
      n.entries.push(e);
    } },
    "replace-network-acl-entry": { write: true, run(c) {
      const n = nacl(c), e = naclEntry(c);
      const i = n.entries.findIndex((x) => x.n === e.n && x.egress === e.egress);
      if (i < 0) throw new AwsError("InvalidNetworkAclEntry.NotFound", `The network acl entry identified by ${e.n} does not exist.`);
      n.entries[i] = e;
    } },
    "delete-network-acl-entry": { write: true, run(c) {
      c.need("network-acl-id", "rule-number");
      const n = nacl(c), num = c.num("rule-number"), eg = c.flag("egress");
      if (!n.entries.some((x) => x.n === num && x.egress === eg)) throw new AwsError("InvalidNetworkAclEntry.NotFound", `The network acl entry identified by ${num} does not exist.`);
      n.entries = n.entries.filter((x) => !(x.n === num && x.egress === eg));
    } },
    "describe-route-tables": (c) => {
      const f = filtersOf(c);
      const ids = c.list("route-table-ids");
      return { RouteTables: c.a.rts.filter((r) => (!ids.length || ids.includes(r.id)) && passes(f, (k) => (k === "association.subnet-id" ? r.subnets : k === "route-table-id" ? r.id : k === "vpc-id" ? r.vpc : k === "association.main" ? String(Boolean(r.main)) : k === "tag:Name" ? r.name : null))).map((r) => rtJson(c.a, r)) };
    },
    "create-route": { write: true, run(c) {
      c.need("route-table-id", "destination-cidr-block");
      const r = routeTable(c), dest = c.opt("destination-cidr-block"), t = routeTarget(c);
      if (!validCidr(dest)) throw new AwsError("InvalidParameterValue", `Value (${dest}) for parameter destinationCidrBlock is invalid. This is not a valid CIDR block.`);
      if (r.routes.some((x) => x.dest === dest)) throw new AwsError("RouteAlreadyExists", `The route identified by ${dest} already exists.`);
      r.routes.push({ dest, target: t });
      return { Return: true };
    } },
    "replace-route": { write: true, run(c) {
      c.need("route-table-id", "destination-cidr-block");
      const r = routeTable(c), dest = c.opt("destination-cidr-block"), t = routeTarget(c);
      const x = r.routes.find((y) => y.dest === dest);
      if (!x || x.target === "local") throw new AwsError("InvalidRoute.NotFound", `no route with destination-cidr-block ${dest} in route table ${r.id}`);
      x.target = t;
    } },
    "delete-route": { write: true, run(c) {
      c.need("route-table-id", "destination-cidr-block");
      const r = routeTable(c), dest = c.opt("destination-cidr-block");
      const x = r.routes.find((y) => y.dest === dest);
      if (!x) throw new AwsError("InvalidRoute.NotFound", `no route with destination-cidr-block ${dest} in route table ${r.id}`);
      if (x.target === "local") throw new AwsError("InvalidParameterValue", `cannot remove local route ${dest} in route table ${r.id}`);
      r.routes = r.routes.filter((y) => y !== x);
    } },
    "associate-route-table": { write: true, run(c) {
      c.need("route-table-id", "subnet-id");
      const r = routeTable(c), s = c.a.sub(c.opt("subnet-id"));
      if (!s) throw new AwsError("InvalidSubnetID.NotFound", `The subnet ID '${c.opt("subnet-id")}' does not exist`);
      const cur = c.a.rts.find((x) => x.subnets.includes(s.id));
      if (cur) throw new AwsError("Resource.AlreadyAssociated", `the specified association for route table ${r.id} conflicts with an existing association`);
      r.subnets.push(s.id);
      return { AssociationId: rid("rtbassoc", r.id + s.id), AssociationState: { State: "associated" } };
    } },
    "replace-route-table-association": { write: true, run(c) {
      c.need("association-id", "route-table-id");
      const r = routeTable(c);
      const from = c.a.rts.find((x) => x.subnets.some((s) => rid("rtbassoc", x.id + s) === c.opt("association-id")));
      if (!from) throw new AwsError("InvalidAssociationID.NotFound", `The association ID '${c.opt("association-id")}' does not exist`);
      const s = from.subnets.find((x) => rid("rtbassoc", from.id + x) === c.opt("association-id"));
      from.subnets = from.subnets.filter((x) => x !== s);
      r.subnets.push(s);
      return { NewAssociationId: rid("rtbassoc", r.id + s), AssociationState: { State: "associated" } };
    } },
    "describe-subnets": (c) => {
      const ids = c.list("subnet-ids");
      return { Subnets: c.a.subnets.filter((s) => !ids.length || ids.includes(s.id)).map((s) => ({ AvailabilityZone: s.az, AvailableIpAddressCount: 249, CidrBlock: s.cidr, DefaultForAz: false, MapPublicIpOnLaunch: s.mapPublic, State: "available", SubnetId: s.id, VpcId: s.vpc, OwnerId: ACCOUNT, Tags: nameTag(s.name) })) };
    },
    "modify-subnet-attribute": { write: true, run(c) {
      c.need("subnet-id");
      const s = c.a.sub(c.opt("subnet-id"));
      if (!s) throw new AwsError("InvalidSubnetID.NotFound", `The subnet ID '${c.opt("subnet-id")}' does not exist`);
      if (c.o["map-public-ip-on-launch"]) s.mapPublic = true;
      if (c.o["no-map-public-ip-on-launch"]) s.mapPublic = false;
    } },
    "describe-vpcs": (c) => ({ Vpcs: c.a.vpcs.map((v) => ({ CidrBlock: v.cidr, DhcpOptionsId: rid("dopt", "x"), State: "available", VpcId: v.id, OwnerId: ACCOUNT, InstanceTenancy: "default", IsDefault: false, Tags: nameTag(v.name) })) }),
    "describe-internet-gateways": (c) => ({ InternetGateways: c.a.igws.map((g) => ({ Attachments: g.vpc ? [{ State: "available", VpcId: g.vpc }] : [], InternetGatewayId: g.id, OwnerId: ACCOUNT, Tags: nameTag(g.name) })) }),
    "attach-internet-gateway": { write: true, run(c) {
      c.need("internet-gateway-id", "vpc-id");
      const g = c.a.igws.find((x) => x.id === c.opt("internet-gateway-id"));
      if (!g) throw new AwsError("InvalidInternetGatewayID.NotFound", `The internetGateway ID '${c.opt("internet-gateway-id")}' does not exist`);
      if (g.vpc) throw new AwsError("Resource.AlreadyAssociated", `resource ${g.id} is already attached to network ${g.vpc}`);
      g.vpc = c.opt("vpc-id");
    } },
    "describe-nat-gateways": (c) => ({ NatGateways: c.a.nats.map((n) => natJson(c.a, n)) }),
    "create-nat-gateway": { write: true, run(c) {
      c.need("subnet-id");
      const s = c.a.sub(c.opt("subnet-id"));
      if (!s) throw new AwsError("InvalidSubnetID.NotFound", `The subnet ID '${c.opt("subnet-id")}' does not exist`);
      if (!c.opt("allocation-id")) throw new AwsError("MissingParameter", "The request must include the AllocationId parameter. Add the required parameter and retry the request.");
      const e = eip(c);
      if (e.assoc) throw new AwsError("Resource.AlreadyAssociated", `Elastic IP address [${e.alloc}] is already associated`);
      const n = { id: rid("nat", "new" + c.a.seq), name: "", subnet: s.id, alloc: e.alloc, state: "pending", created: c.a.now };
      e.assoc = n.id;
      c.a.nats.push(n);
      return { ClientToken: hexOf("ct" + c.a.seq, 32), NatGateway: natJson(c.a, n) };
    } },
    "delete-nat-gateway": { write: true, run(c) {
      c.need("nat-gateway-id");
      const n = c.a.nats.find((x) => x.id === c.opt("nat-gateway-id") && x.state !== "deleted");
      if (!n) throw new AwsError("NatGatewayNotFound", `The Nat Gateway ${c.opt("nat-gateway-id")} was not found`);
      n.state = "deleting";
      const e = c.a.eips.find((x) => x.assoc === n.id);
      if (e) e.assoc = null;
      return { NatGatewayId: n.id };
    } },
    "describe-addresses": (c) => ({ Addresses: c.a.eips.map((e) => {
      const i = e.assoc && e.assoc.startsWith("i-") ? c.a.inst(e.assoc) : null;
      const n = e.assoc && e.assoc.startsWith("nat-") ? c.a.nats.find((x) => x.id === e.assoc) : null;
      return { PublicIp: e.ip, AllocationId: e.alloc, Domain: "vpc", ...(e.assoc ? { AssociationId: e.assocId, NetworkInterfaceId: rid("eni", e.assoc), NetworkInterfaceOwnerId: ACCOUNT, PrivateIpAddress: i ? i.ip : n ? "10.0.1.200" : undefined } : {}),
        ...(i ? { InstanceId: i.id } : {}), PublicIpv4Pool: "amazon", NetworkBorderGroup: REGION, Tags: nameTag(e.name) };
    }) }),
    "allocate-address": { write: true, run(c) {
      const e = c.a.addEip(`new${c.a.seq}`, 60 + (c.a.eips.length * 7) % 40);
      return { PublicIp: e.ip, AllocationId: e.alloc, PublicIpv4Pool: "amazon", NetworkBorderGroup: REGION, Domain: "vpc" };
    } },
    "associate-address": { write: true, run(c) {
      c.need("allocation-id");
      const e = eip(c);
      const [i] = findInstances(c, [c.opt("instance-id") || ""]);
      if (e.assoc && !c.flag("allow-reassociation")) throw new AwsError("Resource.AlreadyAssociated", `resource ${e.alloc} is already associated with associate-id ${e.assocId}`);
      e.assoc = i.id;
      i.publicIp = null;
      return { AssociationId: e.assocId };
    } },
    "disassociate-address": { write: true, run(c) {
      c.need("association-id");
      const e = c.a.eips.find((x) => x.assocId === c.opt("association-id") && x.assoc);
      if (!e) throw new AwsError("InvalidAssociationID.NotFound", `The association ID '${c.opt("association-id")}' does not exist`);
      e.assoc = null;
    } },
    "release-address": { write: true, run(c) {
      c.need("allocation-id");
      const e = eip(c);
      if (e.assoc) throw new AwsError("InvalidIPAddress.InUse", `Address ${e.ip} is in use.`);
      c.a.eips = c.a.eips.filter((x) => x !== e);
    } },
    "describe-volumes": (c) => {
      const f = filtersOf(c);
      const ids = c.list("volume-ids");
      return { Volumes: c.a.volumes.filter((v) => (!ids.length || ids.includes(v.id)) && passes(f, (k) => (k === "status" ? (v.attached ? "in-use" : "available") : k === "volume-id" ? v.id : k === "attachment.instance-id" ? v.attached : null))).map((v) => volJson(c.a, v)) };
    },
    "delete-volume": { write: true, run(c) {
      c.need("volume-id");
      const v = c.a.volumes.find((x) => x.id === c.opt("volume-id"));
      if (!v) throw new AwsError("InvalidVolume.NotFound", `The volume '${c.opt("volume-id")}' does not exist.`);
      if (v.attached) throw new AwsError("VolumeInUse", `Volume ${v.id} is currently attached to ${v.attached}`);
      c.a.volumes = c.a.volumes.filter((x) => x !== v);
    } },
    "describe-snapshots": (c) => {
      const ids = c.list("snapshot-ids");
      for (const id of ids) if (!c.a.snapshots.some((s) => s.id === id)) throw new AwsError("InvalidSnapshot.NotFound", `The snapshot '${id}' does not exist.`);
      return { Snapshots: c.a.snapshots.filter((s) => !ids.length || ids.includes(s.id)).map(snapJson) };
    },
    "delete-snapshot": { write: true, run(c) {
      c.need("snapshot-id");
      const s = c.a.snapshots.find((x) => x.id === c.opt("snapshot-id"));
      if (!s) throw new AwsError("InvalidSnapshot.NotFound", `The snapshot '${c.opt("snapshot-id")}' does not exist.`);
      const ami = c.a.amis.find((x) => x.snap === s.id);
      if (ami) throw new AwsError("InvalidSnapshot.InUse", `The snapshot ${s.id} is currently in use by ${ami.id}`);
      c.a.snapshots = c.a.snapshots.filter((x) => x !== s);
    } },
    "describe-images": (c) => ({ Images: c.a.amis.map((m) => ({ ImageId: m.id, Name: m.name, State: "available", OwnerId: ACCOUNT, CreationDate: ts3(m.created), Architecture: "x86_64",
      BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { SnapshotId: m.snap, VolumeSize: 20, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true } }], RootDeviceType: "ebs", VirtualizationType: "hvm" })) }),
    "create-vpc-endpoint": { write: true, run(c) {
      c.need("vpc-id", "service-name");
      const svc = c.opt("service-name");
      if (!/^com\.amazonaws\.[a-z0-9-]+\.[a-z0-9.-]+$/.test(svc)) throw new AwsError("InvalidServiceName", `The Vpc Endpoint Service '${svc}' does not exist`);
      const type = c.opt("vpc-endpoint-type") || "Gateway";
      if (type === "Gateway" && !/\.(s3|dynamodb)$/.test(svc)) throw new AwsError("InvalidParameter", `The Vpc Endpoint Service '${svc}' does not support the Gateway endpoint type.`);
      const id = rid("vpce", svc + c.a.seq);
      const rts = c.list("route-table-ids");
      for (const r of rts) if (!c.a.rts.some((x) => x.id === r)) throw new AwsError("InvalidRouteTableId.NotFound", `The routeTable ID '${r}' does not exist`);
      c.a.endpoints.push({ id, service: svc, type, rts });
      if (type === "Gateway" && svc.endsWith(".s3")) for (const r of rts) c.a.rts.find((x) => x.id === r).routes.push({ dest: S3_PREFIX_LIST, target: id });
      return { VpcEndpoint: { VpcEndpointId: id, VpcEndpointType: type, VpcId: c.opt("vpc-id"), ServiceName: svc, State: type === "Gateway" ? "available" : "pending", RouteTableIds: rts,
        PolicyDocument: type === "Gateway" ? JSON.stringify(doc({ Effect: "Allow", Principal: "*", Action: "*", Resource: "*" })) : undefined, CreationTimestamp: ts3(c.a.now), OwnerId: ACCOUNT } };
    } },
    "describe-vpc-peering-connections": (c) => ({ VpcPeeringConnections: c.a.peerings.map((p) => {
      const v = (id) => c.a.vpcs.find((x) => x.id === id);
      return { AccepterVpcInfo: { CidrBlock: v(p.b).cidr, OwnerId: ACCOUNT, VpcId: p.b, Region: REGION }, RequesterVpcInfo: { CidrBlock: v(p.a).cidr, OwnerId: ACCOUNT, VpcId: p.a, Region: REGION },
        Status: { Code: p.status, Message: p.status === "active" ? "Active" : p.message }, Tags: nameTag(p.name), VpcPeeringConnectionId: p.id };
    }) }),
    "describe-vpc-endpoints": (c) => ({ VpcEndpoints: c.a.endpoints.map((e) => ({ VpcEndpointId: e.id, VpcEndpointType: e.type, VpcId: c.a.vpcs[0].id, ServiceName: e.service, State: "available", RouteTableIds: e.rts, OwnerId: ACCOUNT })) }),
    "describe-availability-zones": () => ({ AvailabilityZones: ["a", "b", "c", "d", "e", "f"].map((z, n) => ({ State: "available", OptInStatus: "opt-in-not-required", Messages: [], RegionName: REGION, ZoneName: `us-east-1${z}`, ZoneId: `use1-az${[6, 1, 2, 4, 3, 5][n]}`, GroupName: REGION, NetworkBorderGroup: REGION, ZoneType: "availability-zone" })) }),
    "describe-regions": () => ({ Regions: ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-2"].map((r) => ({ Endpoint: `ec2.${r}.amazonaws.com`, RegionName: r, OptInStatus: "opt-in-not-required" })) })
  };

  // --- Elastic Load Balancing and Auto Scaling ---

  function tgByArn(c, name = "target-group-arn") {
    const arn = c.opt(name);
    if (!/^arn:aws:elasticloadbalancing:/.test(arn || "")) throw new AwsError("ValidationError", `'${arn}' is not a valid target group ARN`);
    const tg = c.a.tg(arn);
    if (!tg) throw new AwsError("TargetGroupNotFound", `Target groups '${arn}' not found`);
    return tg;
  }
  const tgJson = (a, t) => ({ TargetGroupArn: t.arn, TargetGroupName: t.name, Protocol: "HTTP", Port: t.port, VpcId: a.vpcs[0].id, HealthCheckProtocol: "HTTP", HealthCheckPort: t.hcPort,
    HealthCheckEnabled: true, HealthCheckIntervalSeconds: t.interval, HealthCheckTimeoutSeconds: 5, HealthyThresholdCount: 5, UnhealthyThresholdCount: 2, HealthCheckPath: t.path,
    Matcher: { HttpCode: t.matcher }, LoadBalancerArns: a.albs.filter((x) => x.listeners.some((l) => l.tg === t.arn)).map((x) => x.arn), TargetType: "instance", ProtocolVersion: "HTTP1", IpAddressType: "ipv4" });
  function targetsOf(c) {
    c.need("targets");
    return c.list("targets").map((t) => {
      const s = typeof t === "object" ? t : shorthand(t) || {};
      if (!s.Id) throw new ArgError("Error parsing parameter '--targets': Expected: '=', received: 'EOF' for input");
      if (!c.a.inst(s.Id)) throw new AwsError("InvalidTarget", `The following targets are not in a running state and cannot be registered: '${s.Id}'`);
      return { id: s.Id, port: s.Port ? Number(s.Port) : undefined };
    });
  }
  const ELBV2 = {
    "describe-load-balancers": (c) => ({ LoadBalancers: c.a.albs.map((x) => ({ LoadBalancerArn: x.arn, DNSName: x.dns, CanonicalHostedZoneId: ALB_ZONE, CreatedTime: ts3(START - 90 * DAY), LoadBalancerName: x.name,
      Scheme: "internet-facing", VpcId: c.a.vpcs[0].id, State: { Code: "active" }, Type: "application", AvailabilityZones: x.subnets.map((s) => ({ ZoneName: c.a.sub(s).az, SubnetId: s, LoadBalancerAddresses: [] })),
      SecurityGroups: x.sgs, IpAddressType: "ipv4" })) }),
    "describe-target-groups": (c) => {
      const names = c.list("names");
      for (const n of names) if (!c.a.tg(n)) throw new AwsError("TargetGroupNotFound", "One or more target groups not found");
      return { TargetGroups: (names.length ? names.map((n) => c.a.tg(n)) : c.a.tgs).map((t) => tgJson(c.a, t)) };
    },
    "describe-target-health": (c) => {
      c.need("target-group-arn");
      const tg = tgByArn(c);
      return { TargetHealthDescriptions: tg.targets.map((t) => ({ Target: { Id: t.id, Port: t.port }, HealthCheckPort: tg.hcPort === "traffic-port" ? String(t.port) : tg.hcPort, TargetHealth: c.a.health(tg, t) })) };
    },
    "register-targets": { write: true, run(c) {
      c.need("target-group-arn");
      const tg = tgByArn(c);
      for (const t of targetsOf(c)) {
        const port = t.port || tg.port;
        if (!tg.targets.some((x) => x.id === t.id && x.port === port)) tg.targets.push({ id: t.id, port, fresh: true });
      }
    } },
    "deregister-targets": { write: true, run(c) {
      c.need("target-group-arn");
      const tg = tgByArn(c);
      for (const t of targetsOf(c)) tg.targets = tg.targets.filter((x) => !(x.id === t.id && (!t.port || x.port === t.port)));
    } },
    "modify-target-group": { write: true, run(c) {
      c.need("target-group-arn");
      const tg = tgByArn(c);
      if (c.opt("health-check-path")) {
        if (!c.opt("health-check-path").startsWith("/")) throw new AwsError("ValidationError", "Health check path must begin with '/' character");
        tg.path = c.opt("health-check-path");
      }
      if (c.opt("health-check-port")) tg.hcPort = c.opt("health-check-port");
      if (c.opt("matcher")) {
        const code = (shorthand(c.opt("matcher")) || {}).HttpCode;
        if (!code || !/^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/.test(Array.isArray(code) ? code.join(",") : code)) throw new AwsError("ValidationError", "Health check matcher HTTP code must be a value from 200 to 499");
        tg.matcher = Array.isArray(code) ? code.join(",") : code;
      }
      return { TargetGroups: [tgJson(c.a, tg)] };
    } },
    "describe-listeners": (c) => {
      c.need("load-balancer-arn");
      const alb = c.a.albs.find((x) => x.arn === c.opt("load-balancer-arn"));
      if (!alb) throw new AwsError("LoadBalancerNotFound", `Load balancers '[${c.opt("load-balancer-arn")}]' not found`);
      return { Listeners: alb.listeners.map((l) => ({ ListenerArn: l.arn, LoadBalancerArn: alb.arn, Port: l.port, Protocol: "HTTP", DefaultActions: [{ Type: "forward", TargetGroupArn: l.tg, Order: 1 }] })) };
    },
    "modify-listener": { write: true, run(c) {
      c.need("listener-arn");
      const alb = c.a.albs.find((x) => x.listeners.some((l) => l.arn === c.opt("listener-arn")));
      if (!alb) throw new AwsError("ListenerNotFound", "One or more listeners not found");
      const l = alb.listeners.find((x) => x.arn === c.opt("listener-arn"));
      const act = shorthand(c.opt("default-actions") || "") || {};
      const arn = (Array.isArray(act) ? act[0] || {} : act).TargetGroupArn;
      if (arn) { if (!c.a.tg(arn)) throw new AwsError("TargetGroupNotFound", `Target groups '${arn}' not found`); l.tg = arn; }
      return { Listeners: [{ ListenerArn: l.arn, LoadBalancerArn: alb.arn, Port: l.port, Protocol: "HTTP", DefaultActions: [{ Type: "forward", TargetGroupArn: l.tg }] }] };
    } }
  };

  function asgOf(c) {
    c.need("auto-scaling-group-name");
    const g = c.a.asgs.find((x) => x.name === c.opt("auto-scaling-group-name"));
    if (!g) throw new AwsError("ValidationError", `AutoScalingGroup name not found - AutoScalingGroup ${c.opt("auto-scaling-group-name")} not found`);
    return g;
  }
  const asgArn = (g) => `arn:aws:autoscaling:${REGION}:${ACCOUNT}:autoScalingGroup:${hexOf(g.name, 8)}-${hexOf(g.name + 1, 4)}-${hexOf(g.name + 2, 4)}-${hexOf(g.name + 3, 4)}-${hexOf(g.name + 4, 12)}:autoScalingGroupName/${g.name}`;
  const policyArn = (g, name) => `arn:aws:autoscaling:${REGION}:${ACCOUNT}:scalingPolicy:${hexOf(g.name + name, 8)}-${hexOf(name, 4)}-${hexOf(name + 1, 4)}-${hexOf(name + 2, 4)}-${hexOf(name + 3, 12)}:autoScalingGroupName/${g.name}:policyName/${name}`;
  const AUTOSCALING = {
    "describe-auto-scaling-groups": (c) => {
      const names = c.list("auto-scaling-group-names");
      return { AutoScalingGroups: c.a.asgs.filter((g) => !names.length || names.includes(g.name)).map((g) => ({ AutoScalingGroupName: g.name, AutoScalingGroupARN: asgArn(g),
        MinSize: g.min, MaxSize: g.max, DesiredCapacity: g.desired, DefaultCooldown: 300, AvailabilityZones: ["us-east-1a", "us-east-1b"], LoadBalancerNames: [], TargetGroupARNs: g.tgs,
        HealthCheckType: "ELB", HealthCheckGracePeriod: 300, Instances: g.instances.map((id) => c.a.inst(id)).filter(Boolean).map((i) => ({ InstanceId: i.id, InstanceType: i.type, AvailabilityZone: c.a.sub(i.subnet).az,
          LifecycleState: i.state === "running" ? "InService" : i.state === "pending" ? "Pending" : "Terminating", HealthStatus: "Healthy", ProtectedFromScaleIn: false })),
        CreatedTime: ts3(g.created), VPCZoneIdentifier: g.lt.subnets.map((s) => c.a.sub(s).id).join(","), TerminationPolicies: ["Default"] })) };
    },
    "describe-policies": (c) => ({ ScalingPolicies: c.a.asgs.flatMap((g) => g.policies.map((p) => ({ AutoScalingGroupName: g.name, PolicyName: p.name, PolicyARN: p.arn, PolicyType: p.type,
      ...(p.type === "SimpleScaling" ? { AdjustmentType: "ChangeInCapacity", ScalingAdjustment: p.adjustment, Cooldown: 300 } : { TargetTrackingConfiguration: { PredefinedMetricSpecification: { PredefinedMetricType: "ASGAverageCPUUtilization" }, TargetValue: p.target, DisableScaleIn: false } }),
      Alarms: c.a.alarms.filter((al) => al.actions.includes(p.arn)).map((al) => ({ AlarmName: al.name, AlarmARN: al.arn })), Enabled: true }))) }),
    "describe-scaling-activities": (c) => {
      const g = c.opt("auto-scaling-group-name") ? asgOf(c) : null;
      return { Activities: (g ? [g] : c.a.asgs).flatMap((x) => x.activities.map((act, n) => ({ ActivityId: `${hexOf(x.name + n + act.at, 8)}-${hexOf(act.desc, 4)}-${hexOf(act.cause, 4)}-${hexOf(act.desc + 1, 4)}-${hexOf(act.cause + 1, 12)}`,
        AutoScalingGroupName: x.name, Description: act.desc, Cause: act.cause, StartTime: ts3(act.at), EndTime: ts3(act.at + 40e3), StatusCode: "Successful", Progress: 100 }))) };
    },
    "update-auto-scaling-group": { write: true, run(c) {
      const g = asgOf(c);
      const min = c.num("min-size") ?? g.min, max = c.num("max-size") ?? g.max, desired = c.num("desired-capacity") ?? Math.min(Math.max(g.desired, min), max);
      if (min > max) throw new AwsError("ValidationError", `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
      if (desired < min || desired > max) throw new AwsError("ValidationError", `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
      Object.assign(g, { min, max });
      if (c.num("desired-capacity") !== undefined) g.manual = true;
      if (desired !== g.desired) c.a.scaleTo(g, desired, `a user request update of AutoScalingGroup constraints to min: ${min}, max: ${max}, desired: ${desired} changing the desired capacity from ${g.desired} to ${desired}`);
      c.a.converge(g);
    } },
    "set-desired-capacity": { write: true, run(c) {
      const g = asgOf(c);
      c.need("desired-capacity");
      const d = c.num("desired-capacity");
      if (d > g.max) throw new AwsError("ValidationError", `New SetDesiredCapacity value ${d} is above max value ${g.max} for the AutoScalingGroup.`);
      if (d < g.min) throw new AwsError("ValidationError", `New SetDesiredCapacity value ${d} is below min value ${g.min} for the AutoScalingGroup.`);
      c.a.scaleTo(g, d, `a user request explicitly set group desired capacity changing the desired capacity from ${g.desired} to ${d}`);
      g.manual = true;
      c.a.converge(g);
    } },
    "put-scaling-policy": { write: true, run(c) {
      const g = asgOf(c);
      c.need("policy-name");
      const name = c.opt("policy-name");
      const type = c.opt("policy-type") || "SimpleScaling";
      const p = { name, arn: policyArn(g, name), type };
      if (type === "TargetTrackingScaling") {
        let cfg;
        try { cfg = JSON.parse(c.opt("target-tracking-configuration") || ""); } catch { cfg = shorthand(c.opt("target-tracking-configuration") || "") || {}; }
        if (!cfg.TargetValue) throw new AwsError("ValidationError", "TargetTrackingConfiguration is required for policies of type TargetTrackingScaling");
        p.target = Number(cfg.TargetValue);
      } else {
        if (c.num("scaling-adjustment") === undefined) throw new AwsError("ValidationError", "ScalingAdjustment is required for policies of type SimpleScaling");
        p.adjustment = c.num("scaling-adjustment");
      }
      g.policies = [...g.policies.filter((x) => x.name !== name), p];
      return { PolicyARN: p.arn, Alarms: [] };
    } },
    "attach-load-balancer-target-groups": { write: true, run(c) {
      const g = asgOf(c);
      c.need("target-group-arns");
      for (const arn of c.list("target-group-arns")) {
        const tg = c.a.tg(arn);
        if (!tg) throw new AwsError("ValidationError", `Provided Target Groups may not be valid. Please ensure they exist and try again.`);
        if (!g.tgs.includes(arn)) g.tgs.push(arn);
        for (const id of g.instances) if (!tg.targets.some((t) => t.id === id)) tg.targets.push({ id, port: tg.port, fresh: true });
      }
    } }
  };

  // --- S3 ---

  // Bucket names are global: these belong to other AWS customers.
  const TAKEN = new Set(["assets", "backups", "logs", "data", "test", "images", "static", "uploads", "my-bucket", "website", "media", "files", "prod", "dev", "quest-kitchen"]);
  const validBucket = (n) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(n) && !/\.\.|^\d+\.\d+\.\d+\.\d+$/.test(n);
  const canonical = (acct) => hexOf("canonical" + acct, 64);
  const etag = (o) => `"${hexOf("etag" + o.v, 32)}"`;
  const s3url = (u) => { const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u || ""); return m ? { bucket: m[1], key: m[2] } : null; };
  const day = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  function bucketOf(c, action) {
    c.need("bucket");
    const name = c.opt("bucket");
    c.a.s3Check(c.who, action, name);
    return c.a.buckets[name];
  }
  function createBucket(c, name, region) {
    if (!validBucket(name)) throw new AwsError("InvalidBucketName", "The specified bucket is not valid.");
    if (c.a.buckets[name]) throw new AwsError("BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.");
    if (TAKEN.has(name)) throw new AwsError("BucketAlreadyExists", "The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.");
    c.allow("s3:CreateBucket", `arn:aws:s3:::${name}`, { region });
    c.a.addBucket(name, { region, created: c.a.now });
  }
  const latest = (b, key) => (b.objects[key] || [])[0];
  function putObject(a, b, key, body, owner) {
    const v = { v: b.versioning === "Enabled" ? hexOf(key + a.seq, 32) : "null", size: body.length, modified: a.now, owner, body };
    b.objects[key] = b.versioning ? [v, ...(b.objects[key] || []).filter((x) => x.v !== "null" || b.versioning === "Enabled")] : [v];
    return v;
  }
  const S3 = {
    ls: { own: true, run(c, say) {
      const u = s3url(c.pos[0]);
      if (!u) {
        c.allow("s3:ListAllMyBuckets", "*");
        for (const b of Object.values(c.a.buckets).sort((x, y) => x.name.localeCompare(y.name))) say(`${day(b.created)} ${b.name}`, "row");
        return;
      }
      const b = c.a.s3Check(c.who, "s3:ListBucket", u.bucket).b;
      const keys = Object.keys(b.objects).filter((k) => k.startsWith(u.key) && !latest(b, k).marker).sort();
      if (c.flag("recursive")) { for (const k of keys) { const o = latest(b, k); say(`${day(o.modified)} ${String(o.size).padStart(10)} ${k}`, "row"); } return; }
      const seen = new Set();
      for (const k of keys) {
        const rest = k.slice(u.key.length);
        const dir = rest.includes("/") ? rest.slice(0, rest.indexOf("/") + 1) : null;
        if (dir) { if (!seen.has(dir)) say(`${"PRE".padStart(30)} ${dir}`, "row"); seen.add(dir); }
        else { const o = latest(b, k); say(`${day(o.modified)} ${String(o.size).padStart(10)} ${rest}`, "row"); }
      }
    }, s3fail: (c, e) => `\nAn error occurred (${e.code}) when calling the ${s3url(c.pos[0]) ? "ListObjectsV2" : "ListBuckets"} operation: ${e.message}` },
    cp: { own: true, write: true, run(c, say) {
      const [from, to] = c.pos;
      if (!from || !to) throw new ArgError("aws: [ERROR]: the following arguments are required: paths");
      const src = s3url(from), dst = s3url(to);
      if (src) {
        let o;
        try { o = c.a.s3Check(c.who, "s3:GetObject", src.bucket, src.key, "HeadObject").obj; } catch (e) {
          if (e.code === "NoSuchBucket") throw e;
          if (e.message.includes("kms:Decrypt")) throw e;
          throw new ArgError(`fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden`);
        }
        if (!o || o.marker) throw new ArgError(`fatal error: An error occurred (404) when calling the HeadObject operation: Key "${src.key}" does not exist`);
        const local = to === "." || to.endsWith("/") ? (to === "." ? "" : to) + src.key.split("/").pop() : to;
        c.a.files[local.replace(/^\.\//, "")] = o.body || "";
        say(`download: ${from} to ${local.startsWith(".") ? local : "./" + local}`);
        return;
      }
      if (dst) {
        const body = c.a.files[from.replace(/^\.\//, "")];
        if (body === undefined) throw new ArgError(`The user-provided path ${from} does not exist.`);
        const key = !dst.key || dst.key.endsWith("/") ? dst.key + from.split("/").pop() : dst.key;
        const b = c.a.s3Check(c.who, "s3:PutObject", dst.bucket, key).b;
        putObject(c.a, b, key, body, c.who.account);
        say(`upload: ./${from.replace(/^\.\//, "")} to s3://${dst.bucket}/${key}`);
        return;
      }
      throw new ArgError("Error: Invalid argument type");
    }, s3fail: (c, e) => `download failed: ${c.pos[0]} to ./${String(c.pos[0]).split("/").pop()} An error occurred (${e.code}) when calling the GetObject operation: ${e.message}` },
    mb: { own: true, write: true, run(c, say) {
      const u = s3url(c.pos[0]);
      if (!u) throw new ArgError(`<S3Uri>: ${c.pos[0] || ""} is not a valid S3 URI.`);
      createBucket(c, u.bucket, c.region);
      say(`make_bucket: ${u.bucket}`);
    }, s3fail: (c, e) => `make_bucket failed: ${c.pos[0]} An error occurred (${e.code}) when calling the CreateBucket operation: ${e.message}` },
    rm: { own: true, write: true, run(c, say) {
      const u = s3url(c.pos[0]);
      if (!u || !u.key) throw new ArgError(`<S3Uri>: ${c.pos[0] || ""} is not a valid S3 URI.`);
      const b = c.a.s3Check(c.who, "s3:DeleteObject", u.bucket, u.key).b;
      if (b.versioning) b.objects[u.key] = [{ v: hexOf("dm" + u.key + c.a.seq, 32), marker: true, modified: c.a.now, owner: ACCOUNT }, ...(b.objects[u.key] || [])];
      else delete b.objects[u.key];
      say(`delete: ${c.pos[0]}`);
    }, s3fail: (c, e) => `delete failed: ${c.pos[0]} An error occurred (${e.code}) when calling the DeleteObject operation: ${e.message}` },
    presign: { own: true, run(c, say) {
      const u = s3url(c.pos[0]);
      if (!u || !u.key) throw new ArgError(`<S3Uri>: ${c.pos[0] || ""} is not a valid S3 URI.`);
      c.a.s3Check(c.who, "s3:GetObject", u.bucket, u.key);
      (c.a.presigned = c.a.presigned || []).push(`${u.bucket}/${u.key}`);
      const exp = Number(c.opt("expires-in") || 3600);
      say(`https://${u.bucket}.s3.${REGION}.amazonaws.com/${u.key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${keyId("ASIA", "you")}%2F20261030%2F${REGION}%2Fs3%2Faws4_request&X-Amz-Date=20261030T090000Z&X-Amz-Expires=${exp}&X-Amz-SignedHeaders=host&X-Amz-Security-Token=${blob("presigntok", 40)}&X-Amz-Signature=${hexOf("sig" + u.key + c.a.seq, 64)}`);
    } },
    rb: { own: true, write: true, run(c, say) {
      const u = s3url(c.pos[0]);
      if (!u) throw new ArgError(`<S3Uri>: ${c.pos[0] || ""} is not a valid S3 URI.`);
      const b = c.a.s3Check(c.who, "s3:DeleteBucket", u.bucket).b;
      if (Object.keys(b.objects).length || b.gb) {
        if (!c.flag("force")) throw new AwsError("BucketNotEmpty", "The bucket you tried to delete is not empty");
        if (b.versioning) throw new AwsError("BucketNotEmpty", "The bucket you tried to delete is not empty. You must delete all versions in the bucket.");
      }
      delete c.a.buckets[u.bucket];
      say(`remove_bucket: ${u.bucket}`);
    }, s3fail: (c, e) => `remove_bucket failed: ${c.pos[0]} An error occurred (${e.code}) when calling the DeleteBucket operation: ${e.message}` }
  };
  const PAB_KEYS = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"];
  function pabFrom(c) {
    c.need("public-access-block-configuration");
    const s = shorthand(c.opt("public-access-block-configuration")) || {};
    return Object.fromEntries(PAB_KEYS.map((k) => [k, String(s[k]).toLowerCase() === "true"]));
  }
  function objectOf(c, action) {
    c.need("bucket", "key");
    const { b } = c.a.s3Check(c.who, action, c.opt("bucket"), c.opt("key"));
    const list = b.objects[c.opt("key")] || [];
    const vid = c.opt("version-id");
    const o = vid ? list.find((x) => x.v === vid) : list[0];
    if (vid && !o) throw new AwsError("NoSuchVersion", "The specified version does not exist.");
    return { b, o, list };
  }
  const S3API = {
    "list-buckets": { action: "s3:ListAllMyBuckets", run: (c) => ({ Buckets: Object.values(c.a.buckets).map((b) => ({ Name: b.name, CreationDate: ts(b.created) })), Owner: { ID: canonical(ACCOUNT) } }) },
    "create-bucket": { own: true, write: true, run(c) {
      c.need("bucket");
      const loc = (shorthand(c.opt("create-bucket-configuration") || "") || {}).LocationConstraint;
      if (c.region !== "us-east-1" && !loc) throw new AwsError("IllegalLocationConstraintException", "The unspecified location constraint is incompatible for the region specific endpoint this request was sent to.");
      if (loc && loc !== c.region) throw new AwsError("IllegalLocationConstraintException", `The ${loc} location constraint is incompatible for the region specific endpoint this request was sent to.`);
      if (loc === "us-east-1") throw new AwsError("InvalidLocationConstraint", "The specified location-constraint is not valid");
      createBucket(c, c.opt("bucket"), c.region);
      return { Location: c.region === "us-east-1" ? `/${c.opt("bucket")}` : `http://${c.opt("bucket")}.s3.amazonaws.com/` };
    } },
    "get-bucket-location": { own: true, run: (c) => { const b = bucketOf(c, "s3:GetBucketLocation"); return { LocationConstraint: b.region === "us-east-1" ? null : b.region }; } },
    "get-bucket-policy": { own: true, run(c) {
      const b = bucketOf(c, "s3:GetBucketPolicy");
      if (!b.policy) throw new AwsError("NoSuchBucketPolicy", "The bucket policy does not exist");
      return { Policy: b.policy };
    } },
    "put-bucket-policy": { own: true, write: true, run(c) {
      c.need("bucket", "policy");
      const b = bucketOf(c, "s3:PutBucketPolicy");
      const d = c.policy("policy", new AwsError("MalformedPolicy", "Policies must be valid JSON and the first byte must be '{'"));
      for (const st of asList(d.Statement)) {
        if (!st || !st.Principal) throw new AwsError("MalformedPolicy", "Missing required field Principal");
        if (!st.Resource) throw new AwsError("MalformedPolicy", "Missing required field Resource");
        if (!asList(st.Resource).every((r) => String(r).startsWith(`arn:aws:s3:::${b.name}`))) throw new AwsError("MalformedPolicy", "Policy has invalid resource");
      }
      const next = { ...b, policy: JSON.stringify(d) };
      if (c.a.isPublicPolicy(next) && c.a.pabOn(b, "BlockPublicPolicy")) throw new AwsError("AccessDenied", `User: ${c.who.arn} is not authorized to perform: s3:PutBucketPolicy on resource: "arn:aws:s3:::${b.name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`);
      b.policy = JSON.stringify(d);
    } },
    "delete-bucket-policy": { own: true, write: true, run: (c) => { bucketOf(c, "s3:DeleteBucketPolicy").policy = null; } },
    "get-bucket-policy-status": { own: true, run: (c) => ({ PolicyStatus: { IsPublic: c.a.isPublic(bucketOf(c, "s3:GetBucketPolicyStatus")) } }) },
    "get-public-access-block": { own: true, run(c) {
      const b = bucketOf(c, "s3:GetBucketPublicAccessBlock");
      if (!b.pab) throw new AwsError("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found");
      return { PublicAccessBlockConfiguration: { ...b.pab } };
    } },
    "put-public-access-block": { own: true, write: true, run: (c) => { const b = bucketOf(c, "s3:PutBucketPublicAccessBlock"); b.pab = pabFrom(c); } },
    "delete-public-access-block": { own: true, write: true, run: (c) => { bucketOf(c, "s3:PutBucketPublicAccessBlock").pab = null; } },
    "get-bucket-versioning": { own: true, run: (c) => { const b = bucketOf(c, "s3:GetBucketVersioning"); return b.versioning ? { Status: b.versioning, MFADelete: "Disabled" } : {}; } },
    "put-bucket-versioning": { own: true, write: true, run(c) {
      c.need("versioning-configuration");
      const b = bucketOf(c, "s3:PutBucketVersioning");
      const st = (shorthand(c.opt("versioning-configuration")) || {}).Status;
      if (!["Enabled", "Suspended"].includes(st)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      b.versioning = st;
    } },
    "list-objects-v2": { own: true, run(c) {
      const b = bucketOf(c, "s3:ListBucket");
      const pre = c.opt("prefix") || "";
      const keys = Object.keys(b.objects).filter((k) => k.startsWith(pre) && !latest(b, k).marker).sort();
      return { ...(keys.length ? { Contents: keys.map((k) => { const o = latest(b, k); return { Key: k, LastModified: ts(o.modified), ETag: etag(o), Size: o.size, StorageClass: "STANDARD" }; }) } : {}),
        Name: b.name, Prefix: pre, MaxKeys: 1000, EncodingType: "url", KeyCount: keys.length, IsTruncated: false };
    } },
    "list-object-versions": { own: true, run(c) {
      const b = bucketOf(c, "s3:ListBucketVersions");
      const pre = c.opt("prefix") || "";
      const all = Object.keys(b.objects).filter((k) => k.startsWith(pre)).sort().flatMap((k) => b.objects[k].map((o, n) => ({ k, o, latest: n === 0 })));
      const owner = (o) => ({ ID: canonical(o.owner || ACCOUNT) });
      const vers = all.filter((x) => !x.o.marker), dms = all.filter((x) => x.o.marker);
      return { ...(vers.length ? { Versions: vers.map(({ k, o, latest: l }) => ({ ETag: etag(o), Size: o.size, StorageClass: "STANDARD", Key: k, VersionId: o.v, IsLatest: l, LastModified: ts(o.modified), Owner: owner(o) })) } : {}),
        ...(dms.length ? { DeleteMarkers: dms.map(({ k, o, latest: l }) => ({ Owner: owner(o), Key: k, VersionId: o.v, IsLatest: l, LastModified: ts(o.modified) })) } : {}),
        Name: b.name, Prefix: pre, KeyMarker: "", VersionIdMarker: "", MaxKeys: 1000, IsTruncated: false };
    } },
    "head-object": { own: true, run(c) {
      let r;
      try { r = objectOf(c, c.opt("version-id") ? "s3:GetObjectVersion" : "s3:GetObject"); } catch (e) {
        if (e.code === "AccessDenied") throw new AwsError("403", "Forbidden");
        throw e;
      }
      if (!r.o || r.o.marker) throw new AwsError("404", "Not Found");
      return { AcceptRanges: "bytes", LastModified: new Date(r.o.modified).toUTCString().replace("GMT", "GMT"), ContentLength: r.o.size, ETag: etag(r.o), ...(r.b.versioning ? { VersionId: r.o.v } : {}),
        ContentType: "binary/octet-stream", ServerSideEncryption: r.b.kms ? "aws:kms" : "AES256", ...(r.b.kms ? { SSEKMSKeyId: r.b.kms } : {}), Metadata: {} };
    } },
    "get-object": { own: true, run(c) {
      const out = c.pos[0];
      if (!out) throw new ArgError("aws: [ERROR]: the following arguments are required: outfile");
      const r = objectOf(c, c.opt("version-id") ? "s3:GetObjectVersion" : "s3:GetObject");
      if (!r.o) throw new AwsError("NoSuchKey", "The specified key does not exist.");
      if (r.o.marker) throw new AwsError(c.opt("version-id") ? "MethodNotAllowed" : "NoSuchKey", c.opt("version-id") ? "The specified method is not allowed against this resource." : "The specified key does not exist.");
      c.a.files[out.replace(/^\.\//, "")] = r.o.body || "";
      return { AcceptRanges: "bytes", LastModified: new Date(r.o.modified).toUTCString(), ContentLength: r.o.size, ETag: etag(r.o), ...(r.b.versioning ? { VersionId: r.o.v } : {}), ContentType: "binary/octet-stream", ServerSideEncryption: r.b.kms ? "aws:kms" : "AES256", Metadata: {} };
    } },
    "put-object": { own: true, write: true, run(c) {
      c.need("bucket", "key");
      const { b } = c.a.s3Check(c.who, "s3:PutObject", c.opt("bucket"), c.opt("key"));
      const body = c.opt("body") ? c.a.files[c.opt("body").replace(/^\.\//, "")] : "";
      if (body === undefined) throw new ArgError(`Error parsing parameter '--body': Blob values must be a path to a file.`);
      const v = putObject(c.a, b, c.opt("key"), body, c.who.account);
      return { ETag: etag(v), ServerSideEncryption: "AES256", ...(b.versioning === "Enabled" ? { VersionId: v.v } : {}) };
    } },
    "delete-object": { own: true, write: true, run(c) {
      const vid = c.opt("version-id");
      const r = objectOf(c, vid ? "s3:DeleteObjectVersion" : "s3:DeleteObject");
      if (vid) {
        r.b.objects[c.opt("key")] = r.list.filter((x) => x !== r.o);
        if (!r.b.objects[c.opt("key")].length) delete r.b.objects[c.opt("key")];
        return { ...(r.o.marker ? { DeleteMarker: true } : {}), VersionId: vid };
      }
      if (r.b.versioning) {
        const m = { v: hexOf("dm" + c.opt("key") + c.a.seq, 32), marker: true, modified: c.a.now, owner: ACCOUNT };
        r.b.objects[c.opt("key")] = [m, ...r.list];
        return { DeleteMarker: true, VersionId: m.v };
      }
      delete r.b.objects[c.opt("key")];
      return {};
    } },
    "copy-object": { own: true, write: true, run(c) {
      c.need("bucket", "key", "copy-source");
      const m = /^([^/]+)\/([^?]+)(?:\?versionId=(.+))?$/.exec(c.opt("copy-source"));
      if (!m) throw new AwsError("InvalidArgument", "Invalid copy source object key");
      const src = c.a.s3Check(c.who, m[3] ? "s3:GetObjectVersion" : "s3:GetObject", m[1], m[2]).b;
      const o = m[3] ? (src.objects[m[2]] || []).find((x) => x.v === m[3]) : latest(src, m[2]);
      if (!o) throw new AwsError(m[3] ? "NoSuchVersion" : "NoSuchKey", m[3] ? "The specified version does not exist." : "The specified key does not exist.");
      if (o.marker) throw new AwsError("InvalidRequest", "The source of a copy request may not specifically refer to a delete marker by version id.");
      const { b } = c.a.s3Check(c.who, "s3:PutObject", c.opt("bucket"), c.opt("key"));
      const v = putObject(c.a, b, c.opt("key"), o.body, ACCOUNT);
      return { CopySourceVersionId: o.v, ...(b.versioning === "Enabled" ? { VersionId: v.v } : {}), ServerSideEncryption: "AES256", CopyObjectResult: { ETag: etag(v), LastModified: ts(c.a.now) } };
    } },
    "get-object-acl": { own: true, run(c) {
      const r = objectOf(c, "s3:GetObjectAcl");
      if (!r.o) throw new AwsError("NoSuchKey", "The specified key does not exist.");
      return { Owner: { ID: canonical(r.o.owner) }, Grants: [{ Grantee: { ID: canonical(r.o.owner), Type: "CanonicalUser" }, Permission: "FULL_CONTROL" }] };
    } },
    "put-bucket-acl": { own: true, write: true, run(c) {
      const b = bucketOf(c, "s3:PutBucketAcl");
      if (b.ownership === "BucketOwnerEnforced") throw new AwsError("AccessControlListNotSupported", "The bucket does not allow ACLs");
    } },
    "get-bucket-ownership-controls": { own: true, run: (c) => ({ OwnershipControls: { Rules: [{ ObjectOwnership: bucketOf(c, "s3:GetBucketOwnershipControls").ownership }] } }) },
    "put-bucket-ownership-controls": { own: true, write: true, run(c) {
      c.need("ownership-controls");
      const b = bucketOf(c, "s3:PutBucketOwnershipControls");
      const v = (/ObjectOwnership"?\s*[=:]\s*"?(\w+)/.exec(c.opt("ownership-controls")) || [])[1];
      if (!["BucketOwnerEnforced", "BucketOwnerPreferred", "ObjectWriter"].includes(v)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      b.ownership = v;
    } },
    "get-bucket-encryption": { own: true, run(c) {
      const b = bucketOf(c, "s3:GetEncryptionConfiguration");
      return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: b.kms ? { SSEAlgorithm: "aws:kms", KMSMasterKeyID: b.kms } : { SSEAlgorithm: "AES256" }, BucketKeyEnabled: Boolean(b.kms) }] } };
    } },
    "get-bucket-lifecycle-configuration": { own: true, run(c) {
      const b = bucketOf(c, "s3:GetLifecycleConfiguration");
      if (!b.lifecycle) throw new AwsError("NoSuchLifecycleConfiguration", "The lifecycle configuration does not exist");
      return { TransitionDefaultMinimumObjectSize: "all_storage_classes_128K", Rules: b.lifecycle.Rules };
    } },
    "put-bucket-lifecycle-configuration": { own: true, write: true, run(c) {
      c.need("lifecycle-configuration");
      const b = bucketOf(c, "s3:PutLifecycleConfiguration");
      const d = c.policy("lifecycle-configuration", new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema"));
      if (!Array.isArray(d.Rules) || !d.Rules.length || d.Rules.some((r) => !r || !["Enabled", "Disabled"].includes(r.Status) || !(r.Filter || r.Prefix !== undefined))) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      b.lifecycle = d;
      return { TransitionDefaultMinimumObjectSize: "all_storage_classes_128K" };
    } },
    "delete-bucket-lifecycle": { own: true, write: true, run: (c) => { bucketOf(c, "s3:PutLifecycleConfiguration").lifecycle = null; } },
    "get-bucket-cors": { own: true, run(c) {
      const b = bucketOf(c, "s3:GetBucketCORS");
      if (!b.cors) throw new AwsError("NoSuchCORSConfiguration", "The CORS configuration does not exist");
      return { CORSRules: b.cors };
    } },
    "put-bucket-cors": { own: true, write: true, run(c) {
      c.need("cors-configuration");
      const b = bucketOf(c, "s3:PutBucketCORS");
      const d = c.policy("cors-configuration", new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema"));
      if (!Array.isArray(d.CORSRules) || !d.CORSRules.length || d.CORSRules.some((r) => !r || !asList(r.AllowedOrigins).length || !asList(r.AllowedMethods).length)) throw new AwsError("MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
      for (const r of d.CORSRules) for (const m of asList(r.AllowedMethods)) if (!["GET", "PUT", "POST", "DELETE", "HEAD"].includes(m)) throw new AwsError("InvalidRequest", `Found unsupported HTTP method in CORS config. Unsupported method is ${m}`);
      b.cors = d.CORSRules;
    } },
    "delete-bucket-cors": { own: true, write: true, run: (c) => { bucketOf(c, "s3:PutBucketCORS").cors = null; } }
  };
  const S3CONTROL = {
    "get-public-access-block": { own: true, run(c) {
      if (!c.a.accountPab) throw new AwsError("NoSuchPublicAccessBlockConfiguration", "The public access block configuration was not found");
      return { PublicAccessBlockConfiguration: { ...c.a.accountPab } };
    } },
    "put-public-access-block": { write: true, action: "s3:PutAccountPublicAccessBlock", run(c) { c.need("account-id"); c.a.accountPab = pabFrom(c); } }
  };

  // --- KMS ---

  function keyOf(c, action) {
    c.need("key-id");
    const id = c.opt("key-id");
    const k = c.a.kmsKeys.find((x) => x.id === id || x.arn === id || x.alias === id);
    if (!k) throw new AwsError("NotFoundException", id.startsWith("alias/") ? `Alias arn:aws:kms:${REGION}:${ACCOUNT}:${id} is not found.` : `Key '${id}' does not exist`);
    c.allow(action, k.arn, { resPolicy: k.policy, kms: true });
    return k;
  }
  const keyMeta = (k) => ({ AWSAccountId: ACCOUNT, KeyId: k.id, Arn: k.arn, CreationDate: ts3(k.created), Enabled: k.state === "Enabled", Description: "", KeyUsage: "ENCRYPT_DECRYPT", KeyState: k.state,
    Origin: "AWS_KMS", KeyManager: "CUSTOMER", CustomerMasterKeySpec: "SYMMETRIC_DEFAULT", KeySpec: "SYMMETRIC_DEFAULT", EncryptionAlgorithms: ["SYMMETRIC_DEFAULT"], MultiRegion: false });
  const KMS = {
    "list-keys": (c) => ({ Keys: c.a.kmsKeys.map((k) => ({ KeyId: k.id, KeyArn: k.arn })) }),
    "list-aliases": (c) => ({ Aliases: c.a.kmsKeys.map((k) => ({ AliasName: k.alias, AliasArn: `arn:aws:kms:${REGION}:${ACCOUNT}:${k.alias}`, TargetKeyId: k.id, CreationDate: ts3(k.created) })) }),
    "describe-key": { own: true, run: (c) => ({ KeyMetadata: keyMeta(keyOf(c, "kms:DescribeKey")) }) },
    "get-key-policy": { own: true, run: (c) => ({ Policy: keyOf(c, "kms:GetKeyPolicy").policy, PolicyName: "default" }) },
    "put-key-policy": { own: true, write: true, run(c) {
      c.need("policy");
      const k = keyOf(c, "kms:PutKeyPolicy");
      const d = c.policy("policy", new AwsError("MalformedPolicyDocumentException", "The policy is not valid JSON."));
      if (asList(d.Statement).some((st) => !st || !st.Principal)) throw new AwsError("MalformedPolicyDocumentException", "Policy contains a statement with no principal.");
      // KMS refuses a policy that would lock the caller out of the key.
      if (!evaluate(c.a, c.who, "kms:PutKeyPolicy", k.arn, { resPolicy: d, kms: true }).allowed) throw new AwsError("MalformedPolicyDocumentException", "The new key policy will not allow you to update the key policy in the future.");
      k.policy = JSON.stringify(d);
    } },
    decrypt: { own: true, run(c) {
      c.need("ciphertext-blob");
      const k = c.a.kmsKeys[0];
      if (!k) throw new AwsError("InvalidCiphertextException", "");
      c.allow("kms:Decrypt", k.arn, { resPolicy: k.policy, kms: true });
      return { KeyId: k.arn, Plaintext: "c2VjcmV0LXZhbHVl", EncryptionAlgorithm: "SYMMETRIC_DEFAULT" };
    } }
  };

  // --- CloudWatch, Logs and SNS ---

  const OPS = ["GreaterThanThreshold", "GreaterThanOrEqualToThreshold", "LessThanThreshold", "LessThanOrEqualToThreshold"];
  const alarmJson = (al) => ({ AlarmName: al.name, AlarmArn: al.arn, ActionsEnabled: true, OKActions: [], AlarmActions: al.actions, InsufficientDataActions: [], StateValue: al.state, StateReason: al.reason,
    StateUpdatedTimestamp: ts3(al.updated), MetricName: al.metric, Namespace: al.ns, Statistic: al.stat, Dimensions: al.dims, Period: al.period, EvaluationPeriods: al.evalPeriods,
    DatapointsToAlarm: al.evalPeriods, Threshold: al.threshold, ComparisonOperator: al.op, TreatMissingData: "missing", StateTransitionedTimestamp: ts3(al.updated) });
  function dimsOf(list) {
    return list.map((d) => { const s = typeof d === "object" ? d : shorthand(d) || {}; return { Name: s.Name, Value: s.Value }; }).filter((d) => d.Name);
  }
  function putAlarm(a, spec) {
    const al = { name: spec.AlarmName, arn: `arn:aws:cloudwatch:${REGION}:${ACCOUNT}:alarm:${spec.AlarmName}`, ns: spec.Namespace, metric: spec.MetricName, stat: spec.Statistic || "Average",
      dims: dimsOf(asList(spec.Dimensions)), period: Number(spec.Period || 300), evalPeriods: Number(spec.EvaluationPeriods || 1), threshold: Number(spec.Threshold), op: spec.ComparisonOperator,
      actions: asList(spec.AlarmActions), state: "INSUFFICIENT_DATA", reason: "Unchecked: Initial alarm creation", updated: a.now };
    const missing = ["AlarmName", "MetricName", "Namespace", "EvaluationPeriods", "Threshold", "ComparisonOperator"].filter((k) => spec[k] === undefined || spec[k] === "");
    if (missing.length) throw new ArgError(`aws: [ERROR]: the following arguments are required: ${missing.map((k) => "--" + k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()).join(", ")}`);
    if (!OPS.includes(al.op)) throw new AwsError("ValidationError", `1 validation error detected: Value '${al.op}' at 'comparisonOperator' failed to satisfy constraint: Member must satisfy enum value set: [${OPS.join(", ")}]`);
    for (const arn of al.actions) {
      if (!a.topics.some((t) => t.arn === arn) && !a.asgs.some((g) => g.policies.some((p) => p.arn === arn))) throw new AwsError("ValidationError", `Invalid arn syntax: ${arn}`);
    }
    const old = a.alarms.find((x) => x.name === al.name);
    a.alarms = [...a.alarms.filter((x) => x !== old), al];
    [al.state, al.reason] = a.alarmState(al);
    if (al.state === "ALARM") a.fire(al);
  }
  const RETENTION = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
  function groupOf(c, name = c.opt("log-group-name")) {
    const g = c.a.logGroups.find((x) => x.name === name);
    if (!g) throw new AwsError("ResourceNotFoundException", "The specified log group does not exist.");
    return g;
  }
  const stream = (g) => `${new Date(START).toISOString().slice(0, 10).replace(/-/g, "/")}/[$LATEST]${hexOf(g.name, 32)}`;
  const CLOUDWATCH = {
    "describe-alarms": (c) => {
      const names = c.list("alarm-names"), st = c.opt("state-value");
      return { MetricAlarms: c.a.alarms.filter((al) => (!names.length || names.includes(al.name)) && (!st || al.state === st)).map(alarmJson), CompositeAlarms: [] };
    },
    "put-metric-alarm": { write: true, run(c) {
      if (c.opt("cli-input-json")) {
        let spec;
        try { spec = JSON.parse(c.opt("cli-input-json")); } catch { throw new ArgError("Error parsing parameter 'cli-input-json': Invalid JSON received."); }
        return putAlarm(c.a, spec) || undefined;
      }
      putAlarm(c.a, { AlarmName: c.opt("alarm-name"), MetricName: c.opt("metric-name"), Namespace: c.opt("namespace"), Statistic: c.opt("statistic"), Period: c.opt("period"),
        EvaluationPeriods: c.opt("evaluation-periods"), Threshold: c.opt("threshold"), ComparisonOperator: c.opt("comparison-operator"), Dimensions: c.list("dimensions"), AlarmActions: c.list("alarm-actions") });
    } },
    "get-metric-statistics": (c) => {
      c.need("namespace", "metric-name");
      const v = c.a.metric(c.opt("namespace"), c.opt("metric-name"), dimsOf(c.list("dimensions")));
      const stat = (c.list("statistics")[0] || "Average");
      const unit = /CPU/.test(c.opt("metric-name")) ? "Percent" : /Space|Bytes/.test(c.opt("metric-name")) ? "Bytes" : "Count";
      return { Label: c.opt("metric-name"), Datapoints: v === null ? [] : [0, 1, 2].map((n) => ({ Timestamp: ts(c.a.now - (n + 1) * 300e3), [stat]: v, Unit: unit })) };
    }
  };
  const LOGS = {
    "describe-log-groups": (c) => {
      const pre = c.opt("log-group-name-prefix") || "";
      return { logGroups: c.a.logGroups.filter((g) => g.name.startsWith(pre)).map((g) => ({ logGroupName: g.name, creationTime: g.created, ...(g.retention ? { retentionInDays: g.retention } : {}),
        metricFilterCount: 0, arn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${g.name}:*`, storedBytes: Math.round(c.a.storedGb(g) * 1073741824), logGroupClass: "STANDARD",
        logGroupArn: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${g.name}` })) };
    },
    "put-retention-policy": { write: true, run(c) {
      c.need("log-group-name", "retention-in-days");
      const days = c.num("retention-in-days");
      if (!RETENTION.includes(days)) throw new AwsError("InvalidParameterException", `1 validation error detected: Value '${days}' at 'retentionInDays' failed to satisfy constraint: Member must satisfy enum value set: [${RETENTION.join(", ")}]`);
      groupOf(c).retention = days;
    } },
    "delete-retention-policy": { write: true, run: (c) => { c.need("log-group-name"); groupOf(c).retention = null; } },
    "delete-log-group": { write: true, run(c) { c.need("log-group-name"); const g = groupOf(c); c.a.logGroups = c.a.logGroups.filter((x) => x !== g); } },
    tail: { action: "logs:StartLiveTail", run(c, say) {
      const g = groupOf(c, c.pos[0]);
      for (const [at, line] of g.lines.slice(-40)) say(`${ts3(at).replace("+00:00", "000+00:00")} ${stream(g)} ${line}`, "row");
    } },
    "filter-log-events": (c) => {
      c.need("log-group-name");
      const g = groupOf(c);
      const pat = (c.opt("filter-pattern") || "").replace(/^"|"$/g, "");
      return { events: g.lines.filter(([, l]) => !pat || l.includes(pat)).map(([at, message], n) => ({ logStreamName: stream(g), timestamp: at, message, ingestionTime: at + 250, eventId: hexOf(g.name + n, 32) })), searchedLogStreams: [] };
    }
  };
  const SNS = {
    "list-topics": (c) => ({ Topics: c.a.topics.map((t) => ({ TopicArn: t.arn })) }),
    "list-subscriptions-by-topic": (c) => {
      c.need("topic-arn");
      const t = c.a.topics.find((x) => x.arn === c.opt("topic-arn"));
      if (!t) throw new AwsError("NotFound", "Topic does not exist");
      return { Subscriptions: t.subs.map((s, n) => ({ SubscriptionArn: s.confirmed ? `${t.arn}:${hexOf(t.arn + n, 8)}-${hexOf(s.endpoint, 4)}-4a1b-9c2d-${hexOf(s.endpoint + n, 12)}` : "PendingConfirmation", Owner: ACCOUNT, Protocol: s.proto, Endpoint: s.endpoint, TopicArn: t.arn })) };
    }
  };

  // --- Lambda ---

  function fnOf(c) {
    c.need("function-name");
    const f = c.a.fn(c.opt("function-name"));
    if (!f) throw new AwsError("ResourceNotFoundException", `Function not found: arn:aws:lambda:${REGION}:${ACCOUNT}:function:${c.opt("function-name")}`);
    return f;
  }
  const fnJson = (a, f) => ({ FunctionName: f.name, FunctionArn: f.arn, Runtime: f.runtime, Role: iamArn("role", f.role), Handler: f.handler, CodeSize: 48213, Description: "", Timeout: f.timeout,
    MemorySize: f.memory, LastModified: new Date(f.modified).toISOString().replace("Z", "+0000"), CodeSha256: blob(f.name, 43) + "=", Version: "$LATEST",
    ...(f.vpc ? { VpcConfig: { SubnetIds: f.vpc.subnets, SecurityGroupIds: f.vpc.sgs, VpcId: a.vpcs[0].id, Ipv6AllowedForDualStack: false } } : {}),
    ...(Object.keys(f.env).length ? { Environment: { Variables: { ...f.env } } } : {}), TracingConfig: { Mode: "PassThrough" }, RevisionId: hexOf(f.name + f.modified, 8) + "-1c2d-4e5f-8a9b-" + hexOf(f.name, 12),
    State: "Active", LastUpdateStatus: "Successful", PackageType: "Zip", Architectures: ["x86_64"], EphemeralStorage: { Size: 512 }, LoggingConfig: { LogFormat: "Text", LogGroup: `/aws/lambda/${f.name}` } });
  // One invocation: the work, what it talks to, and its timeout.
  function invoke(a, f) {
    const req = `${hexOf(f.name + a.seq, 8)}-${hexOf("r" + a.seq, 4)}-4${hexOf("q" + a.seq, 3)}-a${hexOf("s" + a.seq, 3)}-${hexOf("t" + a.seq, 12)}`;
    const group = `/aws/lambda/${f.name}`;
    const log = (line) => a.log(group, line);
    const at = (ms) => ts3(a.now + ms).replace("+00:00", "Z");
    log(`INIT_START Runtime Version: nodejs:22.v41	Runtime Version ARN: arn:aws:lambda:${REGION}::runtime:${hexOf("rt", 64)}`);
    log(`START RequestId: ${req} Version: $LATEST`);
    let error = null, ms = f.workMs;
    const who = a.role(f.role, f.name);
    if (f.needs.db) {
      const db = a.db(f.needs.db);
      const port = Number(f.env.DB_PORT || db.port);
      const r = a.connect(a.lambdaEp(f), a.dbEp(db), port);
      if (r !== "ok") { ms = 5000; error = { errorType: "Error", errorMessage: `connect ${r === "refused" ? "ECONNREFUSED" : "ETIMEDOUT"} ${db.ip}:${port}` }; }
    }
    if (!error && f.needs.secret) {
      const s = a.secrets.find((x) => x.name === f.needs.secret);
      if (f.env.DB_PASSWORD !== undefined) {
        if (f.env.DB_PASSWORD !== JSON.parse(a.secretValue(s)).password) { ms = 300; error = { errorType: "error", errorMessage: "password authentication failed for user \"orders_app\"" }; }
      } else if (!f.env.SECRET_ID) { ms = 300; error = { errorType: "Error", errorMessage: "SECRET_ID is not set" }; }
      else {
        const sec = a.secrets.find((x) => x.name === f.env.SECRET_ID || x.arn === f.env.SECRET_ID);
        const r = sec ? evaluate(a, who, "secretsmanager:GetSecretValue", sec.arn) : { allowed: false };
        if (!sec) { ms = 300; error = { errorType: "ResourceNotFoundException", errorMessage: "Secrets Manager can't find the specified secret." }; }
        else if (!r.allowed) { ms = 300; error = { errorType: "AccessDeniedException", errorMessage: `User: ${who.arn} is not authorized to perform: secretsmanager:GetSecretValue on resource: ${f.env.SECRET_ID} ${r.why}` }; }
      }
    }
    if (!error && f.needs.table) {
      const t = a.tables.find((x) => x.name === f.needs.table);
      if (a.throttled(t)) { ms = 2400; error = { errorType: "ProvisionedThroughputExceededException", errorMessage: "The level of configured provisioned throughput for the table was exceeded. Consider increasing your provisioning level with the UpdateTable API." }; }
    }
    if (!error && f.needs.bucket) {
      const name = f.env[f.needs.bucket];
      try { a.s3Check(who, "s3:PutObject", name, "thumbs/latest.jpg"); } catch (e) { ms = 400; error = { errorType: e.code, errorMessage: e.code === "NoSuchBucket" ? "The specified bucket does not exist" : e.message }; }
    }
    if (ms > f.timeout * 1000) {
      log(`${at(f.timeout * 1000)} ${req} Task timed out after ${f.timeout.toFixed(2)} seconds`);
      log(`END RequestId: ${req}`);
      log(`REPORT RequestId: ${req}	Duration: ${(f.timeout * 1000).toFixed(2)} ms	Billed Duration: ${f.timeout * 1000} ms	Memory Size: ${f.memory} MB	Max Memory Used: 88 MB	Status: timeout`);
      return { error: { errorType: "Sandbox.Timedout", errorMessage: `RequestId: ${req} Error: Task timed out after ${f.timeout.toFixed(2)} seconds` }, ms: f.timeout * 1000 };
    }
    if (error) log(`${at(ms)}	${req}	ERROR	Invoke Error 	${JSON.stringify({ errorType: error.errorType, errorMessage: error.errorMessage, stack: [`${error.errorType}: ${error.errorMessage}`, "    at /var/task/index.js:41:11"] })}`);
    else log(`${at(ms)}	${req}	INFO	done in ${ms} ms`);
    log(`END RequestId: ${req}`);
    log(`REPORT RequestId: ${req}	Duration: ${ms.toFixed(2)} ms	Billed Duration: ${Math.ceil(ms)} ms	Memory Size: ${f.memory} MB	Max Memory Used: 88 MB`);
    return { error, ms };
  }
  const LAMBDA = {
    "list-functions": (c) => ({ Functions: c.a.lambdas.map((f) => fnJson(c.a, f)) }),
    "get-function-configuration": (c) => fnJson(c.a, fnOf(c)),
    "update-function-configuration": { write: true, run(c) {
      const f = fnOf(c);
      const t = c.num("timeout"), m = c.num("memory-size");
      if (t !== undefined && (t < 1 || t > 900)) throw new AwsError("ValidationException", `1 validation error detected: Value '${t}' at 'timeout' failed to satisfy constraint: Member must have value ${t < 1 ? "greater than or equal to 1" : "less than or equal to 900"}`);
      if (m !== undefined && (m < 128 || m > 10240)) throw new AwsError("ValidationException", `1 validation error detected: Value '${m}' at 'memorySize' failed to satisfy constraint: Member must have value ${m < 128 ? "greater than or equal to 128" : "less than or equal to 10240"}`);
      if (t !== undefined) f.timeout = t;
      if (m !== undefined) { f.memory = m; f.workMs = f.cpuBound ? Math.round(f.workMs * 128 / m) : f.workMs; }
      if (c.opt("environment")) {
        const raw = c.opt("environment");
        let vars;
        try { vars = JSON.parse(raw).Variables; } catch { vars = (/Variables=\{(.*)\}/.exec(raw) || [])[1]; vars = vars === undefined ? null : Object.fromEntries(vars.split(",").filter(Boolean).map((kv) => kv.split("="))); }
        if (!vars) throw new ArgError(`Error parsing parameter '--environment': Expected: '=', received: 'EOF' for input:\n${raw}`);
        f.env = vars;
      }
      f.modified = c.a.now;
      return { ...fnJson(c.a, f), LastUpdateStatus: "InProgress", LastUpdateStatusReason: "The function is being created." };
    } },
    "get-function-concurrency": (c) => { const f = fnOf(c); return f.reserved === undefined ? {} : { ReservedConcurrentExecutions: f.reserved }; },
    "put-function-concurrency": { write: true, run(c) {
      const f = fnOf(c);
      c.need("reserved-concurrent-executions");
      const n = c.num("reserved-concurrent-executions");
      if (n < 0 || n > 900) throw new AwsError("InvalidParameterValueException", "Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its minimum value of [100].");
      f.reserved = n;
      return { ReservedConcurrentExecutions: n };
    } },
    "delete-function-concurrency": { write: true, run(c) { delete fnOf(c).reserved; } },
    invoke: { write: true, run(c) {
      const f = fnOf(c);
      if (f.reserved === 0) throw new AwsError("TooManyRequestsException", "Rate Exceeded.", 2);
      const out = c.pos[0];
      if (!out) throw new ArgError("aws: [ERROR]: the following arguments are required: outfile");
      const r = invoke(c.a, f);
      c.a.files[out.replace(/^\.\//, "")] = r.error ? JSON.stringify(r.error) : JSON.stringify({ statusCode: 200, body: "{\"ok\":true}" });
      return { StatusCode: 200, ...(r.error ? { FunctionError: "Unhandled" } : {}), ExecutedVersion: "$LATEST" };
    } }
  };

  // --- RDS ---

  function dbOf(c) {
    c.need("db-instance-identifier");
    const d = c.a.db(c.opt("db-instance-identifier"));
    if (!d) throw new AwsError("DBInstanceNotFound", `DBInstance ${c.opt("db-instance-identifier")} not found.`);
    return d;
  }
  const dbJson = (a, d) => ({ DBInstanceIdentifier: d.id, DBInstanceClass: d.cls, Engine: d.engine, DBInstanceStatus: d.status, MasterUsername: "postgres", DBName: "orders",
    Endpoint: { Address: a.dbHost(d), Port: d.port, HostedZoneId: "Z2R2ITUGPM61AM" }, AllocatedStorage: d.storage, ...(d.maxStorage ? { MaxAllocatedStorage: d.maxStorage } : {}),
    InstanceCreateTime: ts3(d.created), PreferredBackupWindow: "03:00-03:30", BackupRetentionPeriod: d.backups, DBSecurityGroups: [],
    VpcSecurityGroups: d.sgs.map((id) => ({ VpcSecurityGroupId: id, Status: "active" })), AvailabilityZone: a.sub(d.subnet).az,
    DBSubnetGroup: { DBSubnetGroupName: "kitchen-db", DBSubnetGroupDescription: "Private subnets", VpcId: a.vpcs[0].id, SubnetGroupStatus: "Complete" },
    PreferredMaintenanceWindow: "sun:05:00-sun:05:30", PendingModifiedValues: { ...(d.pending || {}) }, ...(d.backups ? { LatestRestorableTime: ts3(a.now - 300e3) } : {}),
    MultiAZ: d.multiAz, EngineVersion: d.version, AutoMinorVersionUpgrade: true, PubliclyAccessible: d.public, StorageType: "gp2", StorageEncrypted: true, DeletionProtection: true,
    DBInstanceArn: `arn:aws:rds:${REGION}:${ACCOUNT}:db:${d.id}`, CopyTagsToSnapshot: true });
  const RDS = {
    "describe-db-instances": (c) => ({ DBInstances: (c.opt("db-instance-identifier") ? [dbOf(c)] : c.a.dbs).map((d) => dbJson(c.a, d)) }),
    "modify-db-instance": { write: true, run(c) {
      const d = dbOf(c);
      const now = c.flag("apply-immediately");
      const pend = {};
      const st = c.num("allocated-storage");
      if (st !== undefined) {
        if (st < Math.ceil(d.storage * 1.1)) throw new AwsError("InvalidParameterCombination", "Invalid storage size for engine name postgres and storage type gp2: the allocated storage must be increased by at least 10%.");
        pend.AllocatedStorage = st;
      }
      if (c.num("max-allocated-storage") !== undefined) d.maxStorage = c.num("max-allocated-storage");
      const ev = c.opt("engine-version");
      if (ev !== undefined) {
        if (!["12.22", "13.20", "14.17", "15.12", "16.4", "16.8", "17.4"].includes(ev)) throw new AwsError("InvalidParameterCombination", `Cannot find upgrade target from ${d.version} with requested version ${ev}.`);
        if (ev.split(".")[0] !== d.version.split(".")[0] && !c.flag("allow-major-version-upgrade")) throw new AwsError("InvalidParameterCombination", "The AllowMajorVersionUpgrade flag must be present when upgrading to a new major version.");
        pend.EngineVersion = ev;
      }
      const br = c.num("backup-retention-period");
      if (br !== undefined) { if (br > 35) throw new AwsError("InvalidParameterValue", "The backup retention period must be between 0 and 35 days."); pend.BackupRetentionPeriod = br; }
      if (c.flag("publicly-accessible")) pend.PubliclyAccessible = true;
      if (c.flag("no-publicly-accessible")) pend.PubliclyAccessible = false;
      const sgs = c.list("vpc-security-group-ids");
      if (sgs.length) { for (const id of sgs) if (!c.a.sg(id)) throw new AwsError("InvalidVPCNetworkStateFault", `Invalid security group , groupId= ${id}, groupName=.`); d.sgs = sgs.map((id) => c.a.sg(id).id); }
      const apply = () => {
        if (pend.AllocatedStorage) { d.freeGb += pend.AllocatedStorage - d.storage; d.storage = pend.AllocatedStorage; }
        if (pend.BackupRetentionPeriod !== undefined) d.backups = pend.BackupRetentionPeriod;
        if (pend.PubliclyAccessible !== undefined) d.public = pend.PubliclyAccessible;
        if (pend.EngineVersion) { d.version = pend.EngineVersion; d.status = "upgrading"; }
      };
      // Storage, backups and public access wait for the maintenance window unless applied now.
      if (now || !Object.keys(pend).length) { apply(); if (Object.keys(pend).length) d.status = "modifying"; d.pending = {}; }
      else d.pending = { ...(d.pending || {}), ...pend };
      return { DBInstance: dbJson(c.a, d) };
    } },
    "reboot-db-instance": { write: true, run(c) { const d = dbOf(c); if (d.status !== "available" && d.status !== "storage-full") throw new AwsError("InvalidDBInstanceState", `Instance ${d.id} is not in available state.`); d.status = "rebooting"; return { DBInstance: dbJson(c.a, d) }; } },
    "create-db-snapshot": { write: true, run(c) {
      c.need("db-snapshot-identifier");
      const d = dbOf(c);
      const s = { id: c.opt("db-snapshot-identifier"), db: d.id, created: c.a.now, type: "manual" };
      d.snapshots.push(s);
      return { DBSnapshot: { DBSnapshotIdentifier: s.id, DBInstanceIdentifier: d.id, Engine: d.engine, AllocatedStorage: d.storage, Status: "creating", SnapshotType: "manual", SnapshotCreateTime: ts3(c.a.now) } };
    } },
    "describe-db-snapshots": (c) => ({ DBSnapshots: c.a.dbs.flatMap((d) => d.snapshots.map((s) => ({ DBSnapshotIdentifier: s.id, DBInstanceIdentifier: d.id, SnapshotCreateTime: ts3(s.created), Engine: d.engine, AllocatedStorage: d.storage, Status: "available", SnapshotType: s.type }))) }),
    "describe-events": (c) => ({ Events: (c.a.dbEvents || []).map((e) => ({ SourceIdentifier: e.db, SourceType: "db-instance", Message: e.msg, EventCategories: [e.cat], Date: ts3(e.at), SourceArn: `arn:aws:rds:${REGION}:${ACCOUNT}:db:${e.db}` })) })
  };

  // --- Route 53 ---

  function zoneOf(c, key = "hosted-zone-id") {
    c.need(key);
    const id = c.opt(key).replace(/^\/hostedzone\//, "");
    const z = c.a.zones.find((x) => x.id === id);
    if (!z) throw new AwsError("NoSuchHostedZone", `No hosted zone found with ID: ${id}`);
    return z;
  }
  const fqdn = (n) => (String(n).endsWith(".") ? String(n) : n + ".").toLowerCase();
  const ROUTE53 = {
    "list-hosted-zones": (c) => ({ HostedZones: c.a.zones.map((z) => ({ Id: `/hostedzone/${z.id}`, Name: z.name, CallerReference: hexOf(z.id, 36), Config: { Comment: "", PrivateZone: false }, ResourceRecordSetCount: z.records.length + 2 })) }),
    "get-hosted-zone": (c) => { const z = zoneOf(c, "id"); return { HostedZone: { Id: `/hostedzone/${z.id}`, Name: z.name, CallerReference: hexOf(z.id, 36), Config: { PrivateZone: false }, ResourceRecordSetCount: z.records.length + 2 }, DelegationSet: { NameServers: z.ns } }; },
    "list-resource-record-sets": (c) => {
      const z = zoneOf(c);
      return { ResourceRecordSets: [{ Name: z.name, Type: "NS", TTL: 172800, ResourceRecords: z.ns.map((n) => ({ Value: n + "." })) },
        { Name: z.name, Type: "SOA", TTL: 900, ResourceRecords: [{ Value: `${z.ns[0]}. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400` }] }, ...clone(z.records)] };
    },
    "change-resource-record-sets": { write: true, run(c) {
      c.need("change-batch");
      const z = zoneOf(c);
      const batch = c.policy("change-batch", new ArgError("Error parsing parameter '--change-batch': Invalid JSON received."));
      const changes = asList(batch.Changes);
      if (!changes.length) throw new AwsError("InvalidChangeBatch", "[The request must contain at least one change.]");
      const next = clone(z.records);
      for (const ch of changes) {
        const r = ch && ch.ResourceRecordSet;
        if (!r || !r.Name || !r.Type) throw new AwsError("InvalidInput", "Invalid request: Missing field 'ResourceRecordSet' in Change");
        const name = fqdn(r.Name);
        if (!name.endsWith(z.name) ) throw new AwsError("InvalidChangeBatch", `[RRSet with DNS name ${name} is not permitted in zone ${z.name}]`);
        if (r.Type === "CNAME" && name === z.name) throw new AwsError("InvalidChangeBatch", `[RRSet of type CNAME with DNS name ${name} is not permitted at apex in zone ${z.name}]`);
        if (!r.AliasTarget && !(Array.isArray(r.ResourceRecords) && r.ResourceRecords.length)) throw new AwsError("InvalidInput", "Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found none in Change with [Action=" + ch.Action + ", Name=" + name + ", Type=" + r.Type + ", SetIdentifier=null]");
        if (r.AliasTarget && !c.a.albs.some((x) => fqdn(r.AliasTarget.DNSName).replace(/^dualstack\./, "") === x.dns + ".") && !c.a.dists.some((x) => fqdn(r.AliasTarget.DNSName) === x.domain + ".")) throw new AwsError("InvalidChangeBatch", `[Tried to create an alias that targets ${r.AliasTarget.DNSName}, type ${r.Type} in zone ${r.AliasTarget.HostedZoneId}, but the alias target name does not lie within the target zone]`);
        const i = next.findIndex((x) => x.Name === name && x.Type === r.Type);
        const rec = { Name: name, Type: r.Type, ...(r.AliasTarget ? { AliasTarget: { HostedZoneId: r.AliasTarget.HostedZoneId, DNSName: fqdn(r.AliasTarget.DNSName), EvaluateTargetHealth: Boolean(r.AliasTarget.EvaluateTargetHealth) } } : { TTL: Number(r.TTL || 300), ResourceRecords: r.ResourceRecords }) };
        if (ch.Action === "CREATE") { if (i >= 0) throw new AwsError("InvalidChangeBatch", `[Tried to create resource record set [name='${name}', type='${r.Type}'] but it already exists]`); next.push(rec); }
        else if (ch.Action === "UPSERT") { if (i >= 0) next[i] = rec; else next.push(rec); }
        else if (ch.Action === "DELETE") { if (i < 0) throw new AwsError("InvalidChangeBatch", `[Tried to delete resource record set [name='${name}', type='${r.Type}'] but it was not found]`); next.splice(i, 1); }
        else throw new AwsError("InvalidInput", `Invalid request: Expected a valid Action (CREATE, DELETE, UPSERT), but found ${ch.Action}`);
        if (next.some((x) => x.Name === name && x.Type === "CNAME") && next.some((x) => x.Name === name && x.Type !== "CNAME")) throw new AwsError("InvalidChangeBatch", `[RRSet of type CNAME with DNS name ${name} is not permitted as it conflicts with other records with the same DNS name in zone ${z.name}]`);
      }
      z.records = next;
      return { ChangeInfo: { Id: `/change/C${hexOf("ch" + c.a.seq, 20).toUpperCase()}`, Status: "PENDING", SubmittedAt: ts3(c.a.now) } };
    } }
  };
  const DOMAINS = {
    "get-domain-detail": (c) => {
      c.need("domain-name");
      const d = c.a.domains[c.opt("domain-name")];
      if (!d) throw new AwsError("InvalidInput", `Domain ${c.opt("domain-name")} not found in account ${ACCOUNT}`);
      return { DomainName: c.opt("domain-name"), Nameservers: d.ns.map((Name) => ({ Name, GlueIps: [] })), AutoRenew: true, AdminPrivacy: true, RegistrantPrivacy: true, TechPrivacy: true,
        RegistrarName: "Amazon Registrar, Inc.", CreationDate: ts3(START - 700 * DAY), ExpirationDate: ts3(START + 30 * DAY), StatusList: ["clientTransferProhibited"] };
    },
    "update-domain-nameservers": { write: true, run(c) {
      c.need("domain-name", "nameservers");
      const d = c.a.domains[c.opt("domain-name")];
      if (!d) throw new AwsError("InvalidInput", `Domain ${c.opt("domain-name")} not found in account ${ACCOUNT}`);
      const ns = c.list("nameservers").map((x) => (shorthand(x) || {}).Name || x).map((x) => String(x).replace(/\.$/, ""));
      if (ns.some((x) => !/^[a-z0-9.-]+\.[a-z]+$/i.test(x))) throw new AwsError("InvalidInput", "Nameserver name is invalid");
      d.ns = ns;
      return { OperationId: `${hexOf("op" + c.a.seq, 8)}-${hexOf("op1", 4)}-${hexOf("op2", 4)}-${hexOf("op3", 4)}-${hexOf("op4", 12)}` };
    } }
  };

  // --- CloudTrail, GuardDuty, Service Quotas, Cost Explorer, SSM, Organizations ---

  const eventJson = (e) => ({ EventId: `${hexOf(e.name + e.at, 8)}-${hexOf(e.user, 4)}-4${hexOf(e.name, 3)}-9${hexOf(e.user + 1, 3)}-${hexOf(e.at + e.name, 12)}`, EventName: e.name, ReadOnly: String(/^(Get|List|Describe|Lookup)/.test(e.name)),
    ...(e.key ? { AccessKeyId: e.key } : {}), EventTime: ts(e.at), EventSource: e.source, Username: e.user, Resources: e.res || [],
    CloudTrailEvent: JSON.stringify({ eventVersion: "1.11", userIdentity: { type: e.user === "root" ? "Root" : e.role ? "AssumedRole" : "IAMUser", ...(e.key ? { accessKeyId: e.key } : {}), accountId: ACCOUNT },
      eventTime: ts(e.at).replace("+00:00", "Z"), eventSource: e.source, eventName: e.name, awsRegion: e.region || REGION, sourceIPAddress: e.ip || LAPTOP, userAgent: e.agent || "aws-cli/2.31.2" }) });
  const CLOUDTRAIL = {
    "describe-trails": (c) => ({ trailList: c.a.trail ? [{ Name: c.a.trail.name, S3BucketName: c.a.trail.bucket, IncludeGlobalServiceEvents: true, IsMultiRegionTrail: c.a.trail.multiRegion, HomeRegion: REGION,
      TrailARN: `arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${c.a.trail.name}`, LogFileValidationEnabled: true, HasCustomEventSelectors: false, HasInsightSelectors: false, IsOrganizationTrail: false }] : [] }),
    "get-trail-status": (c) => {
      c.need("name");
      if (!c.a.trail || ![c.a.trail.name, `arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${c.a.trail.name}`].includes(c.opt("name"))) throw new AwsError("TrailNotFoundException", `Unknown trail: arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${c.opt("name")} for the user: ${ACCOUNT}`);
      const t = c.a.trail;
      return { IsLogging: t.logging, LatestDeliveryTime: ts3(t.logging ? c.a.now - 240e3 : t.stoppedAt), StartLoggingTime: ts3(START - 300 * DAY), ...(t.stoppedAt ? { StopLoggingTime: ts3(t.stoppedAt) } : {}),
        LatestDeliveryAttemptTime: ts(t.logging ? c.a.now - 240e3 : t.stoppedAt).replace("+00:00", "Z"), LatestDeliveryAttemptSucceeded: ts(t.logging ? c.a.now - 240e3 : t.stoppedAt).replace("+00:00", "Z") };
    },
    "start-logging": { write: true, run(c) { c.need("name"); if (!c.a.trail || c.opt("name") !== c.a.trail.name) throw new AwsError("TrailNotFoundException", `Unknown trail: arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${c.opt("name")} for the user: ${ACCOUNT}`); c.a.trail.logging = true; } },
    "stop-logging": { write: true, run(c) { c.need("name"); if (!c.a.trail || c.opt("name") !== c.a.trail.name) throw new AwsError("TrailNotFoundException", `Unknown trail: arn:aws:cloudtrail:${REGION}:${ACCOUNT}:trail/${c.opt("name")} for the user: ${ACCOUNT}`); c.a.trail.logging = false; c.a.trail.stoppedAt = c.a.now; } },
    "lookup-events": (c) => {
      const attr = shorthand(c.opt("lookup-attributes") || "") || {};
      const by = { EventName: (e) => e.name, Username: (e) => e.user, AccessKeyId: (e) => e.key, EventSource: (e) => e.source }[attr.AttributeKey];
      const list = c.a.events.filter((e) => !by || by(e) === attr.AttributeValue).slice(0, Number(c.opt("max-results") || 50));
      return { Events: list.map(eventJson) };
    }
  };
  const GUARDDUTY = {
    "list-detectors": (c) => ({ DetectorIds: [hexOf("detector", 32)] }),
    "list-findings": (c) => { c.need("detector-id"); return { FindingIds: c.a.findings.map((f) => f.id) }; },
    "get-findings": (c) => {
      c.need("detector-id", "finding-ids");
      const ids = c.list("finding-ids");
      return { Findings: c.a.findings.filter((f) => ids.includes(f.id)).map((f) => ({ AccountId: ACCOUNT, Arn: `arn:aws:guardduty:${REGION}:${ACCOUNT}:detector/${hexOf("detector", 32)}/finding/${f.id}`,
        CreatedAt: ts3(f.at).replace("+00:00", "Z"), Description: f.desc, Id: f.id, Partition: "aws", Region: REGION, Resource: f.resource, SchemaVersion: "2.0",
        Service: { Count: f.count, EventFirstSeen: ts3(f.at).replace("+00:00", "Z"), EventLastSeen: ts3(c.a.now - 60e3).replace("+00:00", "Z"), ServiceName: "guardduty" }, Severity: f.severity, Title: f.title, Type: f.type, UpdatedAt: ts3(c.a.now).replace("+00:00", "Z") })) };
    }
  };
  const quotaJson = (a) => ({ ServiceCode: "ec2", ServiceName: "Amazon Elastic Compute Cloud (Amazon EC2)", QuotaArn: `arn:aws:servicequotas:${REGION}:${ACCOUNT}:ec2/L-1216C47A`, QuotaCode: "L-1216C47A",
    QuotaName: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances", Value: a.quotas["L-1216C47A"], Unit: "None", Adjustable: true, GlobalQuota: false, UsageMetric: { MetricNamespace: "AWS/Usage", MetricName: "ResourceCount", MetricDimensions: { Class: "Standard/OnDemand", Resource: "vCPU", Service: "EC2", Type: "Resource" }, MetricStatisticRecommendation: "Maximum" } });
  const QUOTAS = {
    "get-service-quota": (c) => {
      c.need("service-code", "quota-code");
      if (c.opt("service-code") !== "ec2" || c.opt("quota-code") !== "L-1216C47A") throw new AwsError("NoSuchResourceException", `The request failed because the specified quota code doesn't exist.`);
      return { Quota: quotaJson(c.a) };
    },
    "request-service-quota-increase": { write: true, run(c) {
      c.need("service-code", "quota-code", "desired-value");
      if (c.opt("quota-code") !== "L-1216C47A") throw new AwsError("NoSuchResourceException", "The request failed because the specified quota code doesn't exist.");
      const want = Number(c.opt("desired-value"));
      if (!(want > c.a.quotas["L-1216C47A"])) throw new AwsError("IllegalArgumentException", "The desired value must be greater than the current quota value.");
      c.a.quotaRequest = want;
      return { RequestedQuota: { Id: hexOf("req" + c.a.seq, 32), ServiceCode: "ec2", ServiceName: "Amazon Elastic Compute Cloud (Amazon EC2)", QuotaCode: "L-1216C47A", QuotaName: quotaJson(c.a).QuotaName, DesiredValue: want, Status: "PENDING", Created: ts3(c.a.now), Requester: JSON.stringify({ accountId: ACCOUNT, callerArn: c.who.arn }), QuotaArn: quotaJson(c.a).QuotaArn, GlobalQuota: false, Unit: "None" } };
    } }
  };
  const USAGE_TYPES = [[/^EC2 (\S+)/, (m) => `BoxUsage:${m[1]}`], [/^EBS volumes/, () => "EBS:VolumeUsage.gp3"], [/^EBS snapshots/, () => "EBS:SnapshotUsage"], [/^NAT gateway/, () => "NatGateway-Bytes"],
    [/^Public IPv4/, () => "PublicIPv4:InUseAddress"], [/^ALB/, () => "LoadBalancerUsage"], [/^RDS Extended/, () => "ExtendedSupport:Yr1-Yr2:PostgreSQL12"], [/^RDS/, () => "InstanceUsage:db.t3.medium"], [/^S3/, () => "TimedStorage-ByteHrs"], [/^Logs/, () => "TimedStorage-ByteHrs"], [/^Interface/, () => "VpcEndpoint-Hours"]];
  const CE = {
    "get-cost-and-usage": (c) => {
      c.need("time-period", "granularity", "metrics");
      const tp = shorthand(c.opt("time-period")) || {};
      if (!tp.Start || !tp.End) throw new ArgError("Error parsing parameter '--time-period': Expected: '=', received: 'EOF' for input");
      const metric = c.list("metrics")[0];
      const gb = shorthand(c.opt("group-by") || "") || {};
      const items = c.a.lastMonth;
      const amount = (n) => ({ [metric]: { Amount: n.toFixed(10).replace(/0+$/, "").replace(/\.$/, ""), Unit: "USD" } });
      const usage = (label) => { for (const [re, f] of USAGE_TYPES) { const m = re.exec(label); if (m) return f(m); } return "Other"; };
      const keyOf = (x) => (gb.Key === "USAGE_TYPE" ? usage(x.label) : x.service);
      const groups = new Map();
      for (const x of items) groups.set(keyOf(x), (groups.get(keyOf(x)) || 0) + x.usd);
      return { GroupDefinitions: gb.Key ? [{ Type: "DIMENSION", Key: gb.Key }] : [], ResultsByTime: [{ TimePeriod: { Start: tp.Start, End: tp.End },
        ...(gb.Key ? { Total: {}, Groups: [...groups].sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ Keys: [k], Metrics: amount(v) })) } : { Total: amount(items.reduce((n, x) => n + x.usd, 0)), Groups: [] }), Estimated: false }], DimensionValueAttributes: [] };
    }
  };
  // Session Manager needs the agent to reach SSM: through a NAT or internet route, or endpoints.
  function ssmOnline(a, i) {
    if (!i || i.state !== "running" || !i.ssm || !i.role) return false;
    if (!a.identityDocs(a.role(i.role)).some((d) => scan([d], { action: "ssmmessages:OpenControlChannel", resource: "*", keys: {}, who: {} }).allow)) return false;
    return a.endpoints.some((e) => e.service.endsWith(".ssmmessages")) || a.egress(a.ep(i), "52.94.0.10", 443);
  }
  const SSM = {
    "start-session": { action: "ssm:StartSession", run(c, say) {
      c.need("target");
      const i = c.a.instances.find((x) => x.id === c.opt("target"));
      if (!i) throw new AwsError("InvalidTarget", `${c.opt("target")} is not a valid target.`);
      if (!ssmOnline(c.a, i)) throw new AwsError("TargetNotConnected", `${i.id} is not connected.`);
      c.a.session = i;
      say("");
      say(`Starting session with SessionId: you-${hexOf("ssm" + c.a.seq, 17)}`);
    } },
    "describe-instance-information": (c) => ({ InstanceInformationList: c.a.instances.filter((i) => i.ssm && i.role && i.state !== "terminated").map((i) => ({ InstanceId: i.id, PingStatus: ssmOnline(c.a, i) ? "Online" : "ConnectionLost",
      LastPingDateTime: ts3(c.a.now - (ssmOnline(c.a, i) ? 60e3 : 3 * HOUR)), AgentVersion: "3.3.1142.0", IsLatestVersion: false, PlatformType: "Linux", PlatformName: "Amazon Linux", PlatformVersion: "2023", ResourceType: "EC2Instance", IPAddress: i.ip, ComputerName: `ip-${i.ip.replace(/\./g, "-")}.ec2.internal` })) })
  };
  const ORGS = {
    "list-policies": { action: "organizations:ListPolicies", run() { throw new AwsError("AccessDeniedException", "You don't have permissions to access this resource."); } },
    "detach-policy": { action: "organizations:DetachPolicy", run() { throw new AwsError("AccessDeniedException", "You don't have permissions to access this resource."); } },
    "describe-organization": (c) => ({ Organization: { Id: "o-a1b2c3d4e5", Arn: `arn:aws:organizations::${PARTNER}:organization/o-a1b2c3d4e5`, FeatureSet: "ALL", MasterAccountArn: `arn:aws:organizations::${PARTNER}:account/o-a1b2c3d4e5/${PARTNER}`, MasterAccountId: PARTNER, AvailablePolicyTypes: [{ Type: "SERVICE_CONTROL_POLICY", Status: "ENABLED" }] } })
  };


  // --- CloudFront and ACM ---

  const CF_ZONE = "Z2FDTNDATAQYW2";
  const CF_IP = "18.160.10.20";
  const uuid = (seed) => { const x = hexOf(seed, 32); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`; };
  Account.prototype.addCert = function (domain, region, status) {
    const c = { arn: `arn:aws:acm:${region}:${ACCOUNT}:certificate/${uuid("cert" + domain + region + this.certs.length)}`, domain, region, status, created: START - 2 * DAY,
      validation: { Name: `_${hexOf("vn" + domain + region, 32)}.${domain}.`, Type: "CNAME", Value: `_${hexOf("vv" + domain + region, 32)}.${hexOf("vz" + region, 10)}.acm-validations.aws.` } };
    this.certs.push(c);
    return c;
  };
  Account.prototype.addDist = function (alias, bucket) {
    const id = "E" + hexOf("dist" + alias, 13).toUpperCase();
    const d = { id, domain: `d${hexOf("cf" + alias, 13)}.cloudfront.net`, aliases: [alias], origin: `${bucket}.s3.${REGION}.amazonaws.com`, bucket, cert: null, etag: "E" + hexOf("etag" + id, 13).toUpperCase(),
      status: "Deployed", cache: {}, invalidations: [], minTls: "TLSv1.2_2021", ttl: 86400 };
    this.dists.push(d);
    this.zones[0].records.push({ Name: alias + ".", Type: "A", AliasTarget: { HostedZoneId: CF_ZONE, DNSName: d.domain + ".", EvaluateTargetHealth: false } });
    return d;
  };
  const certCovers = (c, host) => c.domain === host || (c.domain.startsWith("*.") && host.endsWith(c.domain.slice(1)) && host.split(".").length === c.domain.split(".").length);
  // What a browser gets from https://alias: a TLS error, or the page (from cache if it is there).
  Account.prototype.cfGet = function (d, host, path) {
    const c = this.certs.find((x) => x.arn === d.cert);
    if (!host.endsWith(".cloudfront.net") && !(c && c.status === "ISSUED" && certCovers(c, host))) return { tls: `SSL: no alternative certificate subject name matches target host name '${host}'` };
    const key = path.split("?")[0] === "/" ? "/index.html" : path.split("?")[0];
    if (!d.cache[key]) {
      const o = latest(this.buckets[d.bucket] || { objects: {} }, key.slice(1));
      if (!o || o.marker) return { code: 403, body: S3_ERR("AccessDenied", "Access Denied"), headers: ["X-Cache: Error from cloudfront"] };
      d.cache[key] = { body: o.body, at: this.now };
      return { code: 200, body: o.body, headers: ["X-Cache: Miss from cloudfront"] };
    }
    return { code: 200, body: d.cache[key].body, headers: ["X-Cache: Hit from cloudfront", `Age: ${Math.round((this.now - d.cache[key].at) / 1000)}`] };
  };
  const distOf = (c, key = "id") => {
    c.need(key);
    const d = c.a.dists.find((x) => x.id === c.opt(key));
    if (!d) throw new AwsError("NoSuchDistribution", "The specified distribution does not exist.");
    return d;
  };
  const distConfig = (a, d) => ({ CallerReference: `quest-${d.id}`, Aliases: { Quantity: d.aliases.length, Items: [...d.aliases] }, DefaultRootObject: "index.html",
    Origins: { Quantity: 1, Items: [{ Id: d.bucket, DomainName: d.origin, OriginPath: "", S3OriginConfig: { OriginAccessIdentity: "" }, OriginAccessControlId: `E${hexOf("oac" + d.id, 13).toUpperCase()}` }] },
    DefaultCacheBehavior: { TargetOriginId: d.bucket, ViewerProtocolPolicy: "redirect-to-https", CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", Compress: true },
    Comment: "Quest Kitchen website", Enabled: true, PriceClass: "PriceClass_100", HttpVersion: "http2and3", IsIPV6Enabled: true,
    ViewerCertificate: d.cert ? { ACMCertificateArn: d.cert, SSLSupportMethod: "sni-only", MinimumProtocolVersion: d.minTls, Certificate: d.cert, CertificateSource: "acm" }
      : { CloudFrontDefaultCertificate: true, SSLSupportMethod: "vip", MinimumProtocolVersion: "TLSv1", CertificateSource: "cloudfront" } });
  const distJson = (a, d) => ({ Id: d.id, ARN: `arn:aws:cloudfront::${ACCOUNT}:distribution/${d.id}`, Status: d.status, LastModifiedTime: ts3(a.now - HOUR), DomainName: d.domain,
    InProgressInvalidationBatches: d.invalidations.filter((i) => i.status === "InProgress").length, DistributionConfig: distConfig(a, d) });
  const CLOUDFRONT = {
    "list-distributions": (c) => ({ DistributionList: { Items: c.a.dists.map((d) => ({ Id: d.id, ARN: `arn:aws:cloudfront::${ACCOUNT}:distribution/${d.id}`, Status: d.status, DomainName: d.domain, Aliases: { Quantity: d.aliases.length, Items: d.aliases }, Enabled: true })), Quantity: c.a.dists.length, MaxItems: 100, IsTruncated: false, Marker: "" } }),
    "get-distribution": (c) => { const d = distOf(c); return { ETag: d.etag, Distribution: distJson(c.a, d) }; },
    "get-distribution-config": (c) => { const d = distOf(c); return { ETag: d.etag, DistributionConfig: distConfig(c.a, d) }; },
    "update-distribution": { write: true, run(c) {
      const d = distOf(c);
      c.need("distribution-config");
      if (!c.opt("if-match")) throw new AwsError("InvalidIfMatchVersion", "The If-Match version is missing or not valid for the resource.");
      if (c.opt("if-match") !== d.etag) throw new AwsError("PreconditionFailed", "The request failed because it didn't meet the preconditions in one or more request-header fields.");
      let cfg;
      try { cfg = JSON.parse(c.opt("distribution-config")); } catch { throw new ArgError("Error parsing parameter '--distribution-config': Invalid JSON received."); }
      if (cfg.DistributionConfig) cfg = cfg.DistributionConfig;
      const vc = cfg.ViewerCertificate || {};
      const arn = vc.ACMCertificateArn;
      if (arn) {
        const cert = c.a.certs.find((x) => x.arn === arn);
        if (!cert || cert.region !== "us-east-1" || cert.status !== "ISSUED") throw new AwsError("InvalidViewerCertificate", "The specified SSL certificate doesn't exist, isn't in us-east-1 region, isn't valid, or doesn't include a valid certificate chain.");
        for (const al of asList((cfg.Aliases || {}).Items)) if (!certCovers(cert, al)) throw new AwsError("InvalidViewerCertificate", `The certificate that is attached to your distribution doesn't cover the alternate domain name (CNAME) that you're trying to add. For more details, see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html#alternate-domain-names-requirements`);
        if (vc.SSLSupportMethod && vc.SSLSupportMethod !== "sni-only" && vc.SSLSupportMethod !== "vip" && vc.SSLSupportMethod !== "static-ip") throw new AwsError("InvalidArgument", "The parameter SSLSupportMethod is invalid.");
      } else if (asList((cfg.Aliases || {}).Items).length && vc.CloudFrontDefaultCertificate) {
        throw new AwsError("InvalidViewerCertificate", "To add an alternate domain name (CNAME) to a CloudFront distribution, you must attach a trusted certificate that validates your authorization to use the domain name. For more details, see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html#alternate-domain-names-requirements");
      }
      d.cert = arn || null;
      if (vc.MinimumProtocolVersion) d.minTls = vc.MinimumProtocolVersion;
      d.status = "InProgress";
      d.etag = "E" + hexOf("etag" + d.id + c.a.seq, 13).toUpperCase();
      return { ETag: d.etag, Distribution: distJson(c.a, d) };
    } },
    "create-invalidation": { write: true, run(c) {
      const d = distOf(c, "distribution-id");
      c.need("paths");
      const paths = c.list("paths").flatMap((p) => (shorthand(p) || {}).Items || [p]).map(String);
      for (const p of paths) if (!p.startsWith("/")) throw new AwsError("InvalidArgument", "Your request contains one or more invalid invalidation paths.");
      const inv = { id: "I" + hexOf("inv" + c.a.seq, 25).toUpperCase(), paths, status: "InProgress", at: c.a.now };
      d.invalidations.push(inv);
      return { Location: `https://cloudfront.amazonaws.com/2020-05-31/distribution/${d.id}/invalidation/${inv.id}`, Invalidation: { Id: inv.id, Status: inv.status, CreateTime: ts3(c.a.now), InvalidationBatch: { Paths: { Quantity: paths.length, Items: paths }, CallerReference: `cli-${c.a.now / 1000}-${c.a.seq}` } } };
    } },
    "list-invalidations": (c) => { const d = distOf(c, "distribution-id"); return { InvalidationList: { Items: d.invalidations.map((i) => ({ Id: i.id, CreateTime: ts3(i.at), Status: i.status })), Quantity: d.invalidations.length, MaxItems: 100, IsTruncated: false, Marker: "" } }; }
  };
  function certOf(c) {
    c.need("certificate-arn");
    const cert = c.a.certs.find((x) => x.arn === c.opt("certificate-arn"));
    if (!cert || cert.region !== c.region) throw new AwsError("ResourceNotFoundException", `Could not find certificate ${c.opt("certificate-arn")} in account ${ACCOUNT}.`);
    return cert;
  }
  const ACM = {
    "list-certificates": (c) => ({ CertificateSummaryList: c.a.certs.filter((x) => x.region === c.region).map((x) => ({ CertificateArn: x.arn, DomainName: x.domain, SubjectAlternativeNameSummaries: [x.domain], HasAdditionalSubjectAlternativeNames: false, Status: x.status, Type: "AMAZON_ISSUED", KeyAlgorithm: "RSA-2048", InUse: c.a.dists.some((d) => d.cert === x.arn), CreatedAt: ts3(x.created) })) }),
    "describe-certificate": (c) => {
      const x = certOf(c);
      return { Certificate: { CertificateArn: x.arn, DomainName: x.domain, SubjectAlternativeNames: [x.domain], DomainValidationOptions: [{ DomainName: x.domain, ValidationDomain: x.domain, ValidationStatus: x.status === "ISSUED" ? "SUCCESS" : "PENDING_VALIDATION", ResourceRecord: { ...x.validation }, ValidationMethod: "DNS" }],
        Serial: x.status === "ISSUED" ? hexOf("serial" + x.arn, 32).match(/../g).join(":") : undefined, Subject: `CN=${x.domain}`, Issuer: "Amazon", CreatedAt: ts3(x.created), ...(x.status === "ISSUED" ? { IssuedAt: ts3(x.created + HOUR), NotBefore: ts3(x.created), NotAfter: ts3(x.created + 395 * DAY) } : {}),
        Status: x.status, KeyAlgorithm: "RSA-2048", SignatureAlgorithm: "SHA256WITHRSA", InUseBy: c.a.dists.filter((d) => d.cert === x.arn).map((d) => `arn:aws:cloudfront::${ACCOUNT}:distribution/${d.id}`), Type: "AMAZON_ISSUED", RenewalEligibility: "INELIGIBLE", Options: { CertificateTransparencyLoggingPreference: "ENABLED" } } };
    },
    "request-certificate": { write: true, run(c) {
      c.need("domain-name");
      if ((c.opt("validation-method") || "EMAIL") !== "DNS") throw new ArgError("(The playground models DNS validation only: add --validation-method DNS.)");
      return { CertificateArn: c.a.addCert(c.opt("domain-name"), c.region, "PENDING_VALIDATION").arn };
    } }
  };

  // --- ECS ---

  AWS_POLICIES.AmazonECSTaskExecutionRolePolicy = [{ Effect: "Allow", Action: ["ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }];
  AWS_POLICIES.AmazonEC2ContainerRegistryReadOnly = [{ Effect: "Allow", Action: ["ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:GetRepositoryPolicy", "ecr:DescribeRepositories", "ecr:ListImages", "ecr:DescribeImages", "ecr:BatchGetImage"], Resource: "*" }];
  const ECR_IP = "52.46.157.62";
  // Why a Fargate task of this service cannot start, or null when it can.
  Account.prototype.ecsReason = function (svc) {
    const td = this.ecs.taskDefs[svc.taskDef];
    const role = (td.executionRole || "").split("/").pop();
    const taskId = hexOf("task" + svc.name, 32);
    if (!this.iam.roles[role]) return `ResourceInitializationError: failed to validate logger args: The task cannot assume the role ${td.executionRole}.`;
    const ep = { kind: "eni", subnet: this.sub(svc.subnets[0]).id, sgs: svc.sgs.map((n) => this.sgId(n) || n), ip: "10.0.11.90", publicIp: svc.publicIp && this.hasInternetRoute(this.sub(svc.subnets[0]).id) ? PUBLIC_IP(140) : null };
    const has = (s) => this.endpoints.some((e) => e.service === `com.amazonaws.${REGION}.${s}`);
    const api = this.egress(ep, ECR_IP, 443) || (has("ecr.api") && has("ecr.dkr"));
    if (!api) return `ResourceInitializationError: unable to pull secrets or registry auth: execution resource retrieval failed: unable to retrieve ecr registry auth: service call has been retried 3 time(s): RequestError: send request failed caused by: Post "https://api.ecr.${REGION}.amazonaws.com/": dial tcp ${ECR_IP}:443: i/o timeout. Please check your task network configuration.`;
    if (!this.can(this.role(role, taskId), "ecr:GetAuthorizationToken", "*")) return `ResourceInitializationError: unable to pull secrets or registry auth: execution resource retrieval failed: unable to retrieve ecr registry auth: service call has been retried 3 time(s): AccessDeniedException: User: arn:aws:sts::${ACCOUNT}:assumed-role/${role}/${taskId} is not authorized to perform: ecr:GetAuthorizationToken on resource: * because no identity-based policy allows the ecr:GetAuthorizationToken action. Please check your task network configuration.`;
    if (!this.egress(ep, S3_IP, 443, "s3")) return `CannotPullContainerError: ref pull has been retried 5 time(s): failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://prod-${REGION}-starport-layer-bucket.s3.${REGION}.amazonaws.com/${hexOf("layer" + svc.name, 6)}-${ACCOUNT}-${hexOf("l2" + svc.name, 8)}/${uuid("layer" + svc.name)}": dial tcp ${S3_IP}:443: i/o timeout`;
    return null;
  };
  Account.prototype.ecsRunning = function (svc) { return this.ecsReason(svc) ? 0 : svc.desired; };
  function svcOf(c) {
    c.need("cluster", "service");
    const s = c.a.ecs.services.find((x) => x.name === c.opt("service") && x.cluster === c.opt("cluster"));
    if (!s) throw new AwsError("ServiceNotFoundException", "Service not found.");
    return s;
  }
  const clusterArn = (n) => `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${n}`;
  const taskArn = (cl, id) => `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${cl}/${id}`;
  function ecsTasks(a, cluster, stopped) {
    return a.ecs.services.filter((s) => s.cluster === cluster).flatMap((s) => {
      const reason = a.ecsReason(s);
      if (stopped) return reason ? [0, 1, 2].map((n) => ({ s, id: hexOf(`${s.name}stopped${n}`, 32), reason })) : [];
      return reason ? [] : Array.from({ length: s.desired }, (_, n) => ({ s, id: hexOf(`${s.name}run${n}${a.ecs.deploys}`, 32) }));
    });
  }
  const ECS = {
    "list-clusters": (c) => ({ clusterArns: [...new Set(c.a.ecs.services.map((s) => s.cluster))].map(clusterArn) }),
    "list-services": (c) => { c.need("cluster"); return { serviceArns: c.a.ecs.services.filter((s) => s.cluster === c.opt("cluster")).map((s) => `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${s.cluster}/${s.name}`) }; },
    "describe-services": (c) => {
      c.need("cluster", "services");
      return { services: c.list("services").map((n) => c.a.ecs.services.find((s) => s.name === n && s.cluster === c.opt("cluster"))).filter(Boolean).map((s) => {
        const running = c.a.ecsRunning(s);
        return { serviceArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:service/${s.cluster}/${s.name}`, serviceName: s.name, clusterArn: clusterArn(s.cluster), status: "ACTIVE", desiredCount: s.desired, runningCount: running, pendingCount: 0, launchType: "FARGATE",
          taskDefinition: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${s.taskDef}`, networkConfiguration: { awsvpcConfiguration: { subnets: s.subnets.map((n) => c.a.sub(n).id), securityGroups: s.sgs.map((n) => c.a.sgId(n) || n), assignPublicIp: s.publicIp ? "ENABLED" : "DISABLED" } },
          events: running ? [{ id: uuid("ev" + s.name + c.a.seq), createdAt: ts3(c.a.now - 60e3), message: `(service ${s.name}) has reached a steady state.` }]
            : [{ id: uuid("ev1" + s.name), createdAt: ts3(c.a.now - 120e3), message: `(service ${s.name}) has started 1 tasks: (task ${hexOf(`${s.name}stopped0`, 32)}).` }, { id: uuid("ev2" + s.name), createdAt: ts3(c.a.now - 30 * 60e3), message: `(service ${s.name}) is unable to consistently start tasks successfully. For more information, see the Troubleshooting section of the Amazon ECS Developer Guide.` }] };
      }), failures: [] };
    },
    "list-tasks": (c) => { c.need("cluster"); return { taskArns: ecsTasks(c.a, c.opt("cluster"), (c.opt("desired-status") || "RUNNING") === "STOPPED").filter((t) => !c.opt("service-name") || t.s.name === c.opt("service-name")).map((t) => taskArn(c.opt("cluster"), t.id)) }; },
    "describe-tasks": (c) => {
      c.need("cluster", "tasks");
      const all = [...ecsTasks(c.a, c.opt("cluster"), true), ...ecsTasks(c.a, c.opt("cluster"), false)];
      const want = c.list("tasks").map((t) => t.split("/").pop());
      return { tasks: all.filter((t) => want.includes(t.id)).map((t) => ({ taskArn: taskArn(c.opt("cluster"), t.id), clusterArn: clusterArn(c.opt("cluster")), taskDefinitionArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${t.s.taskDef}`, group: `service:${t.s.name}`,
        launchType: "FARGATE", platformVersion: "1.4.0", cpu: "512", memory: "1024", lastStatus: t.reason ? "STOPPED" : "RUNNING", desiredStatus: t.reason ? "STOPPED" : "RUNNING",
        containers: [{ name: t.s.name, image: c.a.ecs.taskDefs[t.s.taskDef].image, lastStatus: t.reason ? "STOPPED" : "RUNNING" }],
        ...(t.reason ? { stopCode: "TaskFailedToStart", stoppedReason: t.reason, stoppingAt: ts3(c.a.now - 90e3), stoppedAt: ts3(c.a.now - 80e3) } : { startedAt: ts3(c.a.now - 60e3) }) })), failures: [] };
    },
    "describe-task-definition": (c) => {
      c.need("task-definition");
      const key = c.opt("task-definition").split("/").pop();
      const td = c.a.ecs.taskDefs[key] || Object.entries(c.a.ecs.taskDefs).find(([k]) => k.split(":")[0] === key)?.[1];
      if (!td) throw new AwsError("ClientException", "Unable to describe task definition.");
      return { taskDefinition: { taskDefinitionArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/${td.family}:${td.revision}`, family: td.family, revision: td.revision, executionRoleArn: td.executionRole, taskRoleArn: td.taskRole,
        networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], cpu: "512", memory: "1024", status: "ACTIVE",
        containerDefinitions: [{ name: td.family, image: td.image, essential: true, logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": `/ecs/${td.family}`, "awslogs-region": REGION, "awslogs-stream-prefix": "ecs" } } }] } };
    },
    "update-service": { write: true, run(c) {
      const s = svcOf(c);
      if (c.num("desired-count") !== undefined) s.desired = c.num("desired-count");
      const nc = c.opt("network-configuration");
      if (nc) {
        const pubIp = /assignPublicIp"?\s*[=:]\s*"?(ENABLED|DISABLED)/.exec(nc);
        if (pubIp) s.publicIp = pubIp[1] === "ENABLED";
      }
      c.a.ecs.deploys++;
      return { service: { serviceName: s.name, desiredCount: s.desired, runningCount: c.a.ecsRunning(s), status: "ACTIVE", deployments: [{ id: `ecs-svc/${hash(s.name + c.a.seq)}`, status: "PRIMARY", rolloutState: "IN_PROGRESS" }] } };
    } }
  };

  // --- EKS and kubectl ---

  const EKS_POLICIES = ["AmazonEKSClusterAdminPolicy", "AmazonEKSAdminPolicy", "AmazonEKSEditPolicy", "AmazonEKSViewPolicy", "AmazonEKSAdminViewPolicy"];
  const eksPolicyArn = (n) => `arn:aws:eks::aws:cluster-access-policy/${n}`;
  function clusterOf(c, key = "cluster-name") {
    c.need(key);
    if (!c.a.eks || c.a.eks.name !== c.opt(key)) throw new AwsError("ResourceNotFoundException", `No cluster found for name: ${c.opt(key)}.`);
    return c.a.eks;
  }
  function entryOf(c, k) {
    c.need("principal-arn");
    const e = k.entries.find((x) => x.principal === c.opt("principal-arn"));
    if (!e) throw new AwsError("ResourceNotFoundException", `The specified access entry resource could not be found.`);
    return e;
  }
  const EKS = {
    "list-clusters": (c) => ({ clusters: c.a.eks ? [c.a.eks.name] : [] }),
    "describe-cluster": (c) => {
      const k = clusterOf(c, "name");
      return { cluster: { name: k.name, arn: `arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${k.name}`, createdAt: ts3(START - 200 * DAY), version: "1.33", endpoint: `https://${hexOf("eks", 32).toUpperCase()}.gr7.${REGION}.eks.amazonaws.com`,
        roleArn: iamArn("role", "eks-cluster-role"), status: "ACTIVE", platformVersion: "eks.9", accessConfig: { authenticationMode: k.authMode }, resourcesVpcConfig: { vpcId: c.a.vpcs[0].id, endpointPublicAccess: true, endpointPrivateAccess: true } } };
    },
    "update-kubeconfig": { action: "eks:DescribeCluster", run(c, say) {
      const k = clusterOf(c, "name");
      c.a.kube = { cluster: k.name, profile: c.o.profile ? c.o.profile[0] : null };
      say(`Added new context arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${k.name} to /Users/you/.kube/config`);
    } },
    "list-access-entries": (c) => ({ accessEntries: clusterOf(c).entries.map((e) => e.principal) }),
    "describe-access-entry": (c) => { const k = clusterOf(c); const e = entryOf(c, k); return { accessEntry: { clusterName: k.name, principalArn: e.principal, kubernetesGroups: [], accessEntryArn: `arn:aws:eks:${REGION}:${ACCOUNT}:access-entry/${k.name}/role/${ACCOUNT}/${e.principal.split("/").pop()}/${uuid(e.principal)}`, createdAt: ts3(e.at), username: e.principal, type: "STANDARD" } }; },
    "create-access-entry": { write: true, run(c) {
      const k = clusterOf(c);
      c.need("principal-arn");
      const p = c.opt("principal-arn");
      const m = /^arn:aws:iam::(\d{12}):(role|user)\/(.+)$/.exec(p);
      if (!m || !(m[2] === "role" ? c.a.iam.roles[m[3]] : c.a.iam.users[m[3]])) throw new AwsError("InvalidParameterException", `The specified principalArn is invalid: invalid principal ${p}`);
      if (k.entries.some((e) => e.principal === p)) throw new AwsError("ResourceInUseException", "The specified access entry resource is already in use on this cluster.");
      k.entries.push({ principal: p, policies: [], at: c.a.now });
      return { accessEntry: { clusterName: k.name, principalArn: p, kubernetesGroups: [], username: p, type: "STANDARD", createdAt: ts3(c.a.now) } };
    } },
    "associate-access-policy": { write: true, run(c) {
      const k = clusterOf(c);
      const e = entryOf(c, k);
      c.need("policy-arn", "access-scope");
      const pol = c.opt("policy-arn");
      if (!EKS_POLICIES.map(eksPolicyArn).includes(pol)) throw new AwsError("InvalidParameterException", `The specified policyArn is invalid: ${pol}`);
      const sc = shorthand(c.opt("access-scope")) || {};
      if (!["cluster", "namespace"].includes(sc.type)) throw new AwsError("InvalidParameterException", "The access scope type must be cluster or namespace.");
      e.policies = [...e.policies.filter((x) => x.arn !== pol), { arn: pol, scope: sc.type, namespaces: asList(sc.namespaces) }];
      return { clusterName: k.name, principalArn: e.principal, associatedAccessPolicy: { policyArn: pol, accessScope: { type: sc.type, namespaces: asList(sc.namespaces) }, associatedAt: ts3(c.a.now) } };
    } },
    "list-associated-access-policies": (c) => { const k = clusterOf(c); const e = entryOf(c, k); return { clusterName: k.name, principalArn: e.principal, associatedAccessPolicies: e.policies.map((p) => ({ policyArn: p.arn, accessScope: { type: p.scope, namespaces: p.namespaces } })) }; },
    "list-access-policies": () => ({ accessPolicies: EKS_POLICIES.map((n) => ({ name: n, arn: eksPolicyArn(n) })) })
  };
  // What a principal may do in the cluster, from its access entry's policies.
  Account.prototype.kubeCan = function (principal, verb, ns) {
    const e = this.eks.entries.find((x) => x.principal === principal);
    if (!e) return "unauthorized";
    const read = ["get", "list", "watch"].includes(verb);
    return e.policies.some((p) => (p.scope === "cluster" || (ns && p.namespaces.includes(ns))) && (/ClusterAdmin|AdminPolicy|EditPolicy/.test(p.arn) || (read && /View/.test(p.arn)))) ? "yes" : "forbidden";
  };
  const PODS = [["default", "shop-7d9f8c6b5d-x2kq8", "1/1", "Running", "0", "3d"], ["default", "shop-7d9f8c6b5d-p7nhz", "1/1", "Running", "0", "3d"], ["kube-system", "coredns-6b9575c64c-4vnzx", "1/1", "Running", "0", "41d"], ["kube-system", "aws-node-r5tqm", "2/2", "Running", "0", "41d"]];
  function kubectl(a, args) {
    if (!a.kube) return [["E1030 09:00:00.000000   48211 memcache.go:265] \"Unhandled Error\" err=\"couldn't get current server API group list: Get \\\"http://localhost:8080/api?timeout=32s\\\": dial tcp [::1]:8080: connect: connection refused\"", "warn"], ["The connection to the server localhost:8080 was refused - did you specify the right host or port?", "warn"]];
    const [verb, res = ""] = args.filter((x) => !x.startsWith("-"));
    if (verb === "config") return [[`arn:aws:eks:${REGION}:${ACCOUNT}:cluster/${a.kube.cluster}`]];
    let who;
    try { who = whoAmI(a, credSource(a, a.kube.profile, a.session), "GetCallerIdentity", "sts"); } catch (e) { return [[`Unable to connect to the server: getting credentials: exec: executable aws failed with exit code 255`, "warn"]]; }
    const ns = args.includes("-A") || args.includes("--all-namespaces") ? null : (args[args.indexOf("-n") + 1] && args.includes("-n") ? args[args.indexOf("-n") + 1] : "default");
    const canVerb = verb === "auth" ? (args.filter((x) => !x.startsWith("-"))[2] || "get") : verb === "get" ? "list" : verb;
    const kind = verb === "auth" ? args.filter((x) => !x.startsWith("-"))[3] || "pods" : res.replace(/^(po|pod)$/, "pods").replace(/^(no|node)$/, "nodes");
    const r = a.kubeCan(who.baseArn, canVerb, kind === "nodes" ? null : ns);
    if (r === "unauthorized") return [["error: You must be logged in to the server (Unauthorized)", "warn"]];
    if (verb === "auth") return [[r === "yes" ? "yes" : "no"]];
    if (r === "forbidden") return [[`Error from server (Forbidden): ${kind} is forbidden: User "${who.arn}" cannot ${canVerb} resource "${kind}" in API group "" ${ns && kind !== "nodes" ? `in the namespace "${ns}"` : "at the cluster scope"}`, "warn"]];
    if (verb !== "get") return [[`(The playground models kubectl get pods, get nodes and auth can-i for this cluster.)`, "dim"]];
    if (kind === "nodes") return [["NAME                          STATUS   ROLES    AGE   VERSION", "head"], ["ip-10-0-11-61.ec2.internal    Ready    <none>   41d   v1.33.4-eks-1a2b3c4", "row"], ["ip-10-0-12-62.ec2.internal    Ready    <none>   41d   v1.33.4-eks-1a2b3c4", "row"]];
    const rows = PODS.filter((p) => !ns || p[0] === ns);
    if (!rows.length) return [[`No resources found in ${ns} namespace.`]];
    return ns ? [["NAME                       READY   STATUS    RESTARTS   AGE", "head"], ...rows.map((p) => [`${p[1].padEnd(27)}${p[2].padEnd(8)}${p[3].padEnd(10)}${p[4].padEnd(11)}${p[5]}`, "row"])]
      : [["NAMESPACE     NAME                       READY   STATUS    RESTARTS   AGE", "head"], ...rows.map((p) => [`${p[0].padEnd(14)}${p[1].padEnd(27)}${p[2].padEnd(8)}${p[3].padEnd(10)}${p[4].padEnd(11)}${p[5]}`, "row"])];
  }

  // --- Secrets Manager ---

  function secretOf(c) {
    c.need("secret-id");
    const id = c.opt("secret-id");
    const s = c.a.secrets.find((x) => x.name === id || x.arn === id);
    if (!s) throw new AwsError("ResourceNotFoundException", "Secrets Manager can't find the specified secret.");
    c.allow(`secretsmanager:${c.opName}`, s.arn);
    return s;
  }
  Account.prototype.secretValue = function (s) { return JSON.stringify({ username: "orders_app", password: blob(`pw${s.name}${s.version}`, 32), host: this.dbHost(this.dbs[0]), port: 5432, dbname: "orders" }); };
  Account.prototype.rotate = function (s) { s.version++; s.rotated = this.now; };
  const SECRETS = {
    "list-secrets": (c) => ({ SecretList: c.a.secrets.map((s) => ({ ARN: s.arn, Name: s.name, RotationEnabled: s.rotation, ...(s.rotation ? { RotationRules: { AutomaticallyAfterDays: 30 }, RotationLambdaARN: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:SecretsManagerRDSPostgreSQLRotation` } : {}), LastChangedDate: ts3(s.rotated), LastRotatedDate: ts3(s.rotated) })) }),
    "describe-secret": { own: true, run(c) {
      const s = secretOf(c);
      return { ARN: s.arn, Name: s.name, RotationEnabled: s.rotation, RotationLambdaARN: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:SecretsManagerRDSPostgreSQLRotation`, RotationRules: { AutomaticallyAfterDays: 30 },
        LastRotatedDate: ts3(s.rotated), LastChangedDate: ts3(s.rotated), NextRotationDate: ts3(s.rotated + 30 * DAY), VersionIdsToStages: { [uuid(s.name + s.version)]: ["AWSCURRENT"], [uuid(s.name + (s.version - 1))]: ["AWSPREVIOUS"] } };
    } },
    "get-secret-value": { own: true, run(c) {
      const s = secretOf(c);
      return { ARN: s.arn, Name: s.name, VersionId: uuid(s.name + s.version), SecretString: c.a.secretValue(s), VersionStages: ["AWSCURRENT"], CreatedDate: ts3(s.rotated) };
    } },
    "rotate-secret": { own: true, write: true, run(c) {
      const s = secretOf(c);
      c.a.rotate(s);
      return { ARN: s.arn, Name: s.name, VersionId: uuid(s.name + s.version) };
    } }
  };

  // --- DynamoDB and SQS ---

  function tableOf(c) {
    c.need("table-name");
    const t = c.a.tables.find((x) => x.name === c.opt("table-name"));
    if (!t) throw new AwsError("ResourceNotFoundException", `Requested resource not found: Table: ${c.opt("table-name")} not found`);
    return t;
  }
  const tableJson = (a, t) => ({ AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }], TableName: t.name, KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }], TableStatus: t.status,
    CreationDateTime: ts3(START - 300 * DAY), ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: t.mode === "PROVISIONED" ? t.rcu : 0, WriteCapacityUnits: t.mode === "PROVISIONED" ? t.wcu : 0 },
    TableSizeBytes: 912384113, ItemCount: 1840221, TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${t.name}`, TableId: uuid(t.name), BillingModeSummary: { BillingMode: t.mode, LastUpdateToPayPerRequestDateTime: t.mode === "PAY_PER_REQUEST" ? ts3(a.now) : undefined }, DeletionProtectionEnabled: true });
  Account.prototype.throttled = function (t) { return t.mode === "PROVISIONED" && t.wcu < t.writes; };
  const DYNAMODB = {
    "list-tables": (c) => ({ TableNames: c.a.tables.map((t) => t.name) }),
    "describe-table": (c) => ({ Table: tableJson(c.a, tableOf(c)) }),
    "update-table": { write: true, run(c) {
      const t = tableOf(c);
      const mode = c.opt("billing-mode");
      const pt = shorthand(c.opt("provisioned-throughput") || "") || {};
      if (mode && !["PROVISIONED", "PAY_PER_REQUEST"].includes(mode)) throw new ArgError(`aws: [ERROR]: argument --billing-mode: Found invalid choice '${mode}'`);
      if ((mode === "PROVISIONED" || (!mode && t.mode === "PROVISIONED")) && c.opt("provisioned-throughput") && (!pt.ReadCapacityUnits || !pt.WriteCapacityUnits)) throw new AwsError("ValidationException", "One or more parameter values were invalid: ReadCapacityUnits and WriteCapacityUnits must both be specified when BillingMode is PROVISIONED");
      if (mode === "PAY_PER_REQUEST" && c.opt("provisioned-throughput")) throw new AwsError("ValidationException", "One or more parameter values were invalid: Neither ReadCapacityUnits nor WriteCapacityUnits can be specified when BillingMode is PAY_PER_REQUEST");
      if (mode) t.mode = mode;
      if (pt.ReadCapacityUnits) { t.rcu = Number(pt.ReadCapacityUnits); t.wcu = Number(pt.WriteCapacityUnits); }
      t.status = "UPDATING";
      return { TableDescription: tableJson(c.a, t) };
    } }
  };
  function queueOf(c) {
    c.need("queue-url");
    const q = c.a.queues.find((x) => x.url === c.opt("queue-url"));
    if (!q) throw new AwsError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
    return q;
  }
  const SQS_ATTRS = ["VisibilityTimeout", "MessageRetentionPeriod", "ReceiveMessageWaitTimeSeconds", "DelaySeconds", "RedrivePolicy", "MaximumMessageSize"];
  const SQS = {
    "list-queues": (c) => ({ QueueUrls: c.a.queues.map((q) => q.url) }),
    "get-queue-url": (c) => {
      c.need("queue-name");
      const q = c.a.queues.find((x) => x.name === c.opt("queue-name"));
      if (!q) throw new AwsError("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
      return { QueueUrl: q.url };
    },
    "get-queue-attributes": (c) => {
      const q = queueOf(c);
      const all = { QueueArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${q.name}`, ApproximateNumberOfMessages: String(q.depth), ApproximateNumberOfMessagesNotVisible: String(q.inflight), ApproximateNumberOfMessagesDelayed: "0",
        CreatedTimestamp: String(Math.round((START - 300 * DAY) / 1000)), LastModifiedTimestamp: String(Math.round(q.modified / 1000)), VisibilityTimeout: String(q.visibility), MaximumMessageSize: "262144",
        MessageRetentionPeriod: String(q.retention), DelaySeconds: "0", ReceiveMessageWaitTimeSeconds: "20", SqsManagedSseEnabled: "true", ...(q.dlq ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${q.dlq}`, maxReceiveCount: 5 }) } : {}) };
      const names = c.list("attribute-names");
      return { Attributes: !names.length || names.includes("All") ? all : Object.fromEntries(names.filter((n) => all[n] !== undefined).map((n) => [n, all[n]])) };
    },
    "set-queue-attributes": { write: true, run(c) {
      const q = queueOf(c);
      c.need("attributes");
      let attrs;
      try { attrs = JSON.parse(c.opt("attributes")); } catch { attrs = shorthand(c.opt("attributes")) || {}; }
      for (const [k, v] of Object.entries(attrs)) {
        if (!SQS_ATTRS.includes(k)) throw new AwsError("InvalidAttributeName", `Unknown Attribute ${k}.`);
        if (k === "VisibilityTimeout" && !(Number(v) >= 0 && Number(v) <= 43200)) throw new AwsError("InvalidAttributeValue", `Invalid value for the parameter VisibilityTimeout. Reason: Must be between 0 and 43200, if provided.`);
      }
      if (attrs.VisibilityTimeout !== undefined) q.visibility = Number(attrs.VisibilityTimeout);
      if (attrs.MessageRetentionPeriod !== undefined) q.retention = Number(attrs.MessageRetentionPeriod);
      q.modified = c.a.now;
    } },
    "purge-queue": { write: true, run(c) { const q = queueOf(c); q.depth = 0; q.inflight = 0; q.purged = true; } }
  };

  // The nightly inventory script: hundreds of DescribeInstances calls in parallel.
  function inventory(a) {
    const p = a.profiles.default || {};
    const mode = a.env.AWS_RETRY_MODE || p.retry_mode || "legacy";
    const attempts = Number(a.env.AWS_MAX_ATTEMPTS || p.max_attempts || (mode === "legacy" ? 5 : 3));
    const par = Number((/PARALLEL=(\d+)/.exec(a.files["inventory.conf"] || "") || [])[1] || 32);
    const out = [[`inventory: ${par} parallel jobs, ${14 * 6} accounts and Regions`, "dim"]];
    const ok = (mode === "adaptive" && attempts >= 5) || (mode === "standard" && attempts >= 8) || par <= 4;
    a.inventoryOk = ok;
    if (ok) return [...out, ["inventory: 1,208 instances written to inventory.csv"]];
    return [...out, ["", null], [`An error occurred (RequestLimitExceeded) when calling the DescribeInstances operation (reached max retries: ${attempts - 1}): Request limit exceeded.`, "warn"], ["inventory: failed after 61 of 84 account/Region pairs", "warn"]];
  }

  const SERVICES = { sts: STS, iam: iamOps, configure: CONFIGURE, sso: SSO, ec2: EC2, elbv2: ELBV2, autoscaling: AUTOSCALING, s3: S3, s3api: S3API, s3control: S3CONTROL, kms: KMS,
    cloudwatch: CLOUDWATCH, logs: LOGS, sns: SNS, lambda: LAMBDA, rds: RDS, route53: ROUTE53, route53domains: DOMAINS, cloudtrail: CLOUDTRAIL, guardduty: GUARDDUTY,
    "service-quotas": QUOTAS, ce: CE, ssm: SSM, organizations: ORGS, cloudfront: CLOUDFRONT, acm: ACM, ecs: ECS, eks: EKS, secretsmanager: SECRETS, dynamodb: DYNAMODB, sqs: SQS };
  const HELP_AWS = ["The playground models these aws CLI services (type 'aws <service> help' for their commands):", "  " + Object.keys(SERVICES).join(", "),
    "Global options: --region, --profile, --output json|text, --query (a JMESPath subset)."];

  // --- the instance metadata service --------------------------------------------------

  const IMDS = "169.254.169.254";
  const HTML_ERR = (code, text) => ['<?xml version="1.0" encoding="iso-8859-1"?>', '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"', '\t"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">', " <head>", `  <title>${code} - ${text}</title>`, " </head>", " <body>", `  <h1>${code} - ${text}</h1>`, " </body>", "</html>"].join("\n");
  // IMDSv1 answers any GET; IMDSv2 wants a session token from a PUT first,
  // which a server-side request forgery cannot send.
  function imds(a, i, method, path, headers) {
    if (i.imds.endpoint !== "enabled") return { err: "refused" };
    a.imdsTokens = a.imdsTokens || new Set();
    if (method === "PUT") {
      if (path !== "/latest/api/token" || !headers["x-aws-ec2-metadata-token-ttl-seconds"]) return { code: 400, body: HTML_ERR(400, "Missing or Invalid Parameters") };
      const t = "AQAEA" + blob("imds" + i.id + a.seq, 51) + "==";
      a.imdsTokens.add(t);
      return { code: 200, body: t };
    }
    if (i.imds.tokens === "required" && !a.imdsTokens.has(headers["x-aws-ec2-metadata-token"])) return { code: 401, body: HTML_ERR(401, "Unauthorized") };
    const md = "/latest/meta-data/";
    const role = i.role;
    const pages = { [md]: "ami-id\nhostname\niam/\ninstance-id\ninstance-type\nlocal-ipv4\nplacement/\nsecurity-groups", [md + "instance-id"]: i.id, [md + "instance-type"]: i.type,
      [md + "local-ipv4"]: i.ip, [md + "ami-id"]: i.ami, [md + "hostname"]: `ip-${i.ip.replace(/\./g, "-")}.ec2.internal`, [md + "placement/availability-zone"]: a.sub(i.subnet).az,
      [md + "security-groups"]: i.sgs.map((id) => (a.sg(id) || {}).name).join("\n"), [md + "iam/"]: role ? "info\nsecurity-credentials/" : undefined,
      [md + "iam/security-credentials/"]: role || undefined };
    if (role && path === `${md}iam/security-credentials/${role}`) {
      const id = keyId("ASIA", role + i.id);
      a.creds[id] = a.creds[id] || { id, secret: blob("imdssecret" + id, 40), token: blob("imdstok" + id, 120), session: true, who: { kind: "role", role, session: i.id }, status: "Active", created: a.now, expires: a.now + 6 * HOUR };
      return { code: 200, body: json({ Code: "Success", LastUpdated: ts(a.now).replace("+00:00", "Z"), Type: "AWS-HMAC", AccessKeyId: id, SecretAccessKey: a.creds[id].secret, Token: a.creds[id].token, Expiration: ts(a.now + 6 * HOUR).replace("+00:00", "Z") }).replace(/ {4}/g, "  ") };
    }
    const body = pages[path] ?? pages[path + "/"];
    return body === undefined ? { code: 404, body: HTML_ERR(404, "Not Found") } : { code: 200, body };
  }
  Account.prototype.appGet = function (i, path) {
    const [p, q] = path.split("?");
    if (p === "/preview" && q && APPS[i.app] === APPS.shop) {
      const target = decodeURIComponent((/(?:^|&)url=([^&]*)/.exec(q) || [])[1] || "");
      const m = /^https?:\/\/([^/:]+)(?::\d+)?(\/.*)?$/.exec(target);
      if (m && m[1] === IMDS) { const r = imds(this, i, "GET", m[2] || "/", {}); return r.err ? { code: 502, body: "preview failed: connect ECONNREFUSED 169.254.169.254:80" } : { code: 200, body: r.body }; }
      return { code: 200, body: "<img src=\"data:image/png;base64,iVBORw0KGgo=\">" };
    }
    const page = ((APPS[i.app] || {}).paths || {})[p];
    return page ? { code: page[0], body: page[1] } : { code: 404, body: "Not Found" };
  };

  // --- other commands: the laptop and, inside a session, the instance ----------------

  const HELP = [
    "This is a simulation of an AWS account. Nothing here reaches AWS or costs money.",
    "aws ...           the AWS CLI: sts, iam, ec2, elbv2, autoscaling, s3, s3api, kms, rds, lambda,",
    "                  logs, cloudwatch, route53, cloudtrail, guardduty, ce, ssm, service-quotas,",
    "                  cloudfront, acm, ecs, eks, secretsmanager, dynamodb, sqs",
    "kubectl get pods, kubectl auth can-i   on the EKS cluster, after aws eks update-kubeconfig",
    "aws <service> help    list what a service can do here",
    "curl, dig, nslookup, nc -vz, ssh, psql   test from your laptop (or from an instance)",
    "aws ssm start-session --target <instance-id>   open a shell on an instance; 'exit' leaves",
    "export, unset, env, echo, cat, ls, grep, git log, git grep   files and environment",
    "Pipes: | grep, | head, | wc -l, | jq.  Options: --query, --output text, --profile.",
    "hint   a hint (three per scenario)     reset   start the scenario again",
    "next   the next scenario               clear   clear the screen"
  ];
  const PROMPT_HOST = (i) => `ip-${i.ip.replace(/\./g, "-")}`;

  // Where a request leaves from: your laptop on the internet, or an instance.
  const fromOf = (a) => (a.session ? a.session : { kind: "internet", ip: LAPTOP });
  function target(a, host, port) {
    const r = a.resolve(host, Boolean(a.session));
    if (!r || r.servfail || r.nx) return { err: "resolve", r };
    if (r.alb) return { alb: r.alb, ip: r.ip };
    if (r.cf) return { cf: r.cf, ip: r.ip, internet: true };
    if (r.db) return { ep: a.dbEp(r.db), ip: r.ip, db: r.db };
    if (r.s3 !== undefined || r.ip === S3_IP) return { s3: r.s3, ip: S3_IP };
    const at = a.atIp(r.ip);
    if (at && at.inst) return { ep: at.inst, ip: r.ip, inst: at.inst };
    if (at && at.alb) return { alb: at.alb, ip: r.ip };
    if (at && at.db) return { ep: a.dbEp(at.db), ip: r.ip, db: at.db };
    if (at && at.external) return { internet: true, ip: r.ip };
    const inner = a.session && a.instances.find((x) => x.ip === r.ip);
    if (inner) return { ep: inner, ip: r.ip, inst: inner };
    const db = a.session && a.dbs.find((d) => d.ip === r.ip);
    if (db) return { ep: a.dbEp(db), ip: r.ip, db };
    return { ep: { kind: "eni", subnet: null, sgs: [], ip: r.ip, publicIp: null, up: false, listens: () => false }, ip: r.ip, nowhere: true };
  }
  function tcp(a, t, port) {
    const from = fromOf(a);
    if (t.alb) return a.connect(from, { kind: "eni", subnet: t.alb.subnets[0], sgs: t.alb.sgs, ip: t.alb.ip, publicIp: t.alb.ips[0], listens: (p) => t.alb.listeners.some((l) => l.port === p) }, port);
    if (t.internet || t.s3 !== undefined) return a.session ? a.connect(from, { kind: "internet", ip: t.ip, service: t.s3 !== undefined ? "s3" : null }, port) : "ok";
    if (t.nowhere) return "timeout";
    // From an instance to another's public IP: out to the internet and back in.
    if (a.session && t.inst && t.ip === a.publicIpOf(t.inst)) return a.egress(a.ep(from), t.ip, port) ? a.connect({ kind: "internet", ip: natIpOf(a) || PUBLIC_IP(1) }, t.inst, port) : "timeout";
    return a.connect(from, t.ep, port);
  }

  function curl(a, args) {
    const o = { headers: {}, method: "GET" };
    let url = null;
    for (let i = 0; i < args.length; i++) {
      const x = args[i];
      if (x === "-H" || x === "--header") { const [k, ...v] = String(args[++i] || "").split(":"); o.headers[k.trim().toLowerCase()] = v.join(":").trim(); }
      else if (x === "-X" || x === "--request") o.method = String(args[++i] || "GET").toUpperCase();
      else if (x === "-o" || x === "--output") o.out = args[++i];
      else if (x === "-m" || x === "--max-time" || x === "--connect-timeout") o.max = Number(args[++i]);
      else if (/^-[a-zA-Z]+$/.test(x)) { if (x.includes("I")) o.head = true; if (x.includes("i")) o.inc = true; if (x.includes("s")) o.silent = true; if (x.includes("f")) o.fail = true; }
      else if (!x.startsWith("--")) url = x;
    }
    if (!url) return [["curl: try 'curl --help' or 'curl --manual' for more information", "warn"]];
    const m = /^(?:(https?):\/\/)?([^/:?]+)(?::(\d+))?(\/[^\s]*)?$/.exec(url);
    if (!m) return [[`curl: (3) URL rejected: Malformed input to a URL function`, "warn"]];
    const scheme = m[1] || "http", host = m[2], port = Number(m[3] || (scheme === "https" ? 443 : 80)), path = m[4] || "/";
    const ms = (n) => (o.max ? Math.min(o.max * 1000, n) : n);
    const fail = (code, text) => [[`curl: (${code}) ${text}`, "warn"]];
    let res;
    if (host === IMDS) {
      if (!a.session) return fail(28, `Failed to connect to ${host} port ${port} after ${ms(75004)} ms: Couldn't connect to server`);
      res = imds(a, a.session, o.method, path, o.headers);
      if (res.err) return fail(7, `Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`);
    } else {
      const t = target(a, host, port);
      if (t.err) return fail(6, `Could not resolve host: ${host}`);
      const conn = tcp(a, t, port);
      if (conn === "timeout") return fail(28, `Failed to connect to ${host} port ${port} after ${ms(130217)} ms: Couldn't connect to server`);
      if (conn === "refused") return fail(7, `Failed to connect to ${host} port ${port} after 3 ms: Couldn't connect to server`);
      if (t.cf) {
        if (scheme === "http") res = { code: 301, body: "", headers: [`Location: https://${host}${path}`, "Server: CloudFront"] };
        else res = a.cfGet(t.cf, host, path);
        if (res.tls) return fail(60, `${res.tls}\nMore details here: https://curl.se/docs/sslcerts.html`);
      } else if (t.alb) res = a.albGet(t.alb, path, fromOf(a));
      else if (t.inst) res = a.appGet(t.inst, path);
      else if (t.db) return fail(52, "Empty reply from server");
      else if (t.s3 !== undefined) res = s3Http(a, t.s3, path, o);
      else res = { code: 200, body: host === "checkip.amazonaws.com" ? (a.session ? natIpOf(a) : LAPTOP) : `{"status":"ok","host":"${host}"}` };
      if (res.err) return fail(28, `Failed to connect to ${host} port ${port} after ${ms(130217)} ms: Couldn't connect to server`);
    }
    const reason = { 301: "Moved Permanently", 200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 502: "Bad Gateway", 503: "Service Temporarily Unavailable", 504: "Gateway Time-out" }[res.code];
    const head = [`HTTP/1.1 ${res.code} ${reason}`, `Date: ${new Date(a.now).toUTCString()}`, `Content-Type: ${/^</.test(res.body) ? "text/html" : "text/plain"}`, `Content-Length: ${res.body.length}`, "Connection: keep-alive",
      ...(res.code >= 502 && res.code <= 504 ? ["Server: awselb/2.0"] : []), ...(res.headers || [])];
    if (o.fail && res.code >= 400) return fail(22, `The requested URL returned error: ${res.code}`);
    if (o.head) return head.map((t) => [t]);
    if (o.out) { a.files[o.out.replace(/^\.\//, "")] = res.body; return o.silent ? [] : [["  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current", "dim"], [`100  ${String(res.body.length).padStart(4)}  100  ${String(res.body.length).padStart(4)}    0     0   9812      0 --:--:-- --:--:-- --:--:--  9851`, "dim"]]; }
    return [...(o.inc ? [...head, ""] : []), ...res.body.split("\n")].map((t) => [t]);
  }
  function natIpOf(a) {
    const n = a.natPath(a.session.subnet);
    const e = n && a.eips.find((x) => x.alloc === n.alloc);
    return e ? e.ip : a.publicIpOf(a.session) || "";
  }
  // Anonymous HTTP to S3: what the internet sees of a bucket.
  function s3Http(a, hostBucket, rawPath, o = { headers: {}, method: "GET" }) {
    const [path, qs = ""] = rawPath.split("?");
    const parts = path.replace(/^\//, "").split("/");
    const bucket = hostBucket || parts.shift();
    const key = decodeURIComponent(hostBucket ? path.replace(/^\//, "") : parts.join("/"));
    const origin = o.headers.origin;
    const b = a.buckets[bucket];
    const rule = (method) => b && origin && (b.cors || []).find((r) => asList(r.AllowedOrigins).some((x) => glob(x, origin)) && asList(r.AllowedMethods).includes(method));
    if (o.method === "OPTIONS" && b) {
      const want = (o.headers["access-control-request-method"] || "GET").toUpperCase();
      if (!rule(want)) return { code: 403, body: S3_ERR("AccessForbidden", "CORSResponse: This CORS request is not allowed. This is usually because the evalution of Origin, request method / Access-Control-Request-Method or Access-Control-Request-Headers are not whitelisted by the resource's CORS spec.", `<Method>${want}</Method><ResourceType>OBJECT</ResourceType>`) };
      return { code: 200, body: "", headers: [`Access-Control-Allow-Origin: ${origin}`, `Access-Control-Allow-Methods: ${asList(rule(want).AllowedMethods).join(", ")}`, "Vary: Origin, Access-Control-Request-Headers, Access-Control-Request-Method"] };
    }
    const cors = rule(o.method === "HEAD" ? "HEAD" : "GET") ? [`Access-Control-Allow-Origin: ${origin}`, "Vary: Origin, Access-Control-Request-Headers, Access-Control-Request-Method"] : [];
    const signed = /X-Amz-Signature=/.test(qs) && (a.presigned || []).includes(`${bucket}/${key}`);
    try {
      const r = signed ? { b, obj: latest(b, key) } : a.s3Check({ anonymous: true, account: "anonymous" }, key ? "s3:GetObject" : "s3:ListBucket", bucket, key || undefined);
      if (key && (!r.obj || r.obj.marker)) return { code: 404, body: S3_ERR("NoSuchKey", "The specified key does not exist.", `<Key>${key}</Key>`) };
      if (signed) return { code: 200, body: r.obj.body || "", headers: cors };
      if (key && (!r.obj || r.obj.marker)) return { code: 404, body: S3_ERR("NoSuchKey", "The specified key does not exist.", `<Key>${key}</Key>`) };
      return { code: 200, body: key ? r.obj.body || "%PDF-1.7 (invoice)" : `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>${bucket}</Name><KeyCount>${Object.keys(r.b.objects).length}</KeyCount></ListBucketResult>` };
    } catch (e) {
      return e.code === "NoSuchBucket" ? { code: 404, body: S3_ERR("NoSuchBucket", "The specified bucket does not exist", `<BucketName>${bucket}</BucketName>`) } : { code: 403, body: S3_ERR("AccessDenied", "Access Denied") };
    }
  }

  function dig(a, args) {
    const short = args.includes("+short");
    const rest = args.filter((x) => !x.startsWith("+") && !x.startsWith("@"));
    const type = rest.find((x) => /^(A|AAAA|CNAME|NS|MX|TXT|SOA)$/i.test(x)) || "A";
    const name = (rest.find((x) => !/^(A|AAAA|CNAME|NS|MX|TXT|SOA)$/i.test(x)) || "").toLowerCase().replace(/\.$/, "");
    if (!name) return [["; <<>> DiG 9.10.6 <<>>", "dim"]];
    const answers = [];
    let status = "NOERROR";
    const zone = a.zones.find((z) => name === z.name.slice(0, -1));
    if (type.toUpperCase() === "NS" && zone) {
      const r = a.resolve(name);
      if (r && r.servfail) status = "SERVFAIL"; else answers.push(...a.domains[name].ns.map((n) => [name + ".", 172800, "NS", n + "."]));
    } else {
      let host = name;
      for (let hop = 0; hop < 4; hop++) {
        const z = a.zones.find((x) => host === x.name.slice(0, -1) || host.endsWith("." + x.name.slice(0, -1)));
        const r = a.resolve(host, Boolean(a.session));
        if (!r) { status = "NXDOMAIN"; break; }
        if (r.servfail) { status = "SERVFAIL"; break; }
        if (r.nx) { status = "NXDOMAIN"; break; }
        const rec = z && z.records.find((x) => x.Name === host + "." && x.Type === "CNAME");
        if (rec) { answers.push([host + ".", rec.TTL || 300, "CNAME", fqdn(rec.ResourceRecords[0].Value)]); host = fqdn(rec.ResourceRecords[0].Value).slice(0, -1); continue; }
        const ips = r.alb ? r.alb.ips : [r.ip];
        answers.push(...ips.map((ip) => [host + ".", r.alb ? 60 : 300, "A", ip]));
        break;
      }
    }
    if (short) return answers.map((x) => [x[3]]);
    const id = hash(name) % 65536;
    return [["", null], [`; <<>> DiG 9.10.6 <<>> ${args.join(" ")}`], [";; global options: +cmd"], [";; Got answer:"], [`;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${id}`, status === "NOERROR" ? null : "warn"],
      [`;; flags: qr rd ra; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: 0, ADDITIONAL: 1`], [""], [";; QUESTION SECTION:"], [`;${name}.\t\t\tIN\t${type.toUpperCase()}`], [""],
      ...(answers.length ? [[";; ANSWER SECTION:"], ...answers.map(([n, ttl, t, v]) => [`${n}\t${ttl}\tIN\t${t}\t${v}`, "row"]), [""]] : []),
      [";; Query time: 24 msec"], [`;; SERVER: ${a.session ? "10.0.0.2#53(10.0.0.2)" : "192.168.1.1#53(192.168.1.1)"}`], [`;; WHEN: ${new Date(a.now).toUTCString().replace(",", "")}`], [`;; MSG SIZE  rcvd: ${48 + answers.length * 16}`]];
  }
  function nslookup(a, args) {
    const name = (args.find((x) => !x.startsWith("-")) || "").toLowerCase().replace(/\.$/, "");
    const r = a.resolve(name, Boolean(a.session));
    const server = a.session ? "10.0.0.2" : "192.168.1.1";
    const out = [[`Server:\t\t${server}`], [`Address:\t${server}#53`], [""]];
    if (!r || r.nx) return [...out, [`** server can't find ${name}: NXDOMAIN`, "warn"]];
    if (r.servfail) return [...out, [`** server can't find ${name}: SERVFAIL`, "warn"]];
    return [...out, ["Non-authoritative answer:"], ...(r.alb ? r.alb.ips : [r.ip]).flatMap((ip) => [[`Name:\t${name}`], [`Address: ${ip}`]])];
  }
  const SERVICE_NAMES = { 22: "ssh", 80: "http", 443: "https", 3306: "mysql", 5432: "postgresql", 8080: "http-alt" };
  function nc(a, args) {
    const pos = args.filter((x) => !x.startsWith("-") && !/^\d+$/.test(x) || false);
    const host = pos[0], port = Number(args.filter((x) => /^\d+$/.test(x)).pop());
    if (!host || !port) return [["usage: nc [-46AacCDdEFhklMnOortUuvz] [-K tc] [-b boundif] [-i interval] [-p source_port] [-w timeout] [-X proxy_version] [destination] [port]", "warn"]];
    const t = host === IMDS ? null : target(a, host, port);
    const r = !t || t.err ? "resolve" : tcp(a, t, port);
    if (a.session) {
      if (r === "resolve") return [[`Ncat: Could not resolve hostname "${host}": Name or service not known. QUITTING.`, "warn"]];
      return r === "ok" ? [[`Ncat: Version 7.93 ( https://nmap.org/ncat )`, "dim"], [`Ncat: Connected to ${t.ip}:${port}.`], ["Ncat: 0 bytes sent, 0 bytes received in 0.01 seconds."]]
        : [[`Ncat: Version 7.93 ( https://nmap.org/ncat )`, "dim"], [r === "refused" ? "Ncat: Connection refused." : "Ncat: TIMEOUT.", "warn"]];
    }
    if (r === "resolve") return [[`nc: getaddrinfo: nodename nor servname provided, or not known`, "warn"]];
    return r === "ok" ? [[`Connection to ${host} port ${port} [tcp/${SERVICE_NAMES[port] || "*"}] succeeded!`]]
      : [[`nc: connectx to ${host} port ${port} (tcp) failed: ${r === "refused" ? "Connection refused" : "Operation timed out"}`, "warn"]];
  }
  function psql(a, args) {
    const o = parseOpts(args.map((x) => x.replace(/^-h$/, "--host").replace(/^-p$/, "--port").replace(/^-U$/, "--user").replace(/^-d$/, "--db")));
    const host = (o.o.host || [])[0] || (/host=([\w.-]+)/.exec(args.join(" ")) || [])[1];
    const port = Number((o.o.port || [])[0] || 5432);
    if (!host) return [["psql: error: connection to server on socket \"/var/run/postgresql/.s.PGSQL.5432\" failed: No such file or directory", "warn"], ["\tIs the server running locally and accepting connections on that socket?", "warn"]];
    const t = target(a, host, port);
    if (t.err) return [[`psql: error: could not translate host name "${host}" to address: Name or service not known`, "warn"]];
    const r = tcp(a, t, port);
    if (r === "ok" && t.db) return [[`psql (16.4)`], ["SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off, ALPN: postgresql)"], ['Type "help" for help.'], [""], ["orders=> \\q", "dim"]];
    return [[`psql: error: connection to server at "${host}" (${t.ip}), port ${port} failed: ${r === "refused" || r === "ok" ? "Connection refused" : "Connection timed out"}`, "warn"], ["\tIs the server running on that host and accepting TCP/IP connections?", "warn"]];
  }
  function ssh(a, args) {
    const dest = args.filter((x, n) => !x.startsWith("-") && !["-i", "-p", "-o"].includes(args[n - 1])).shift() || "";
    const host = dest.includes("@") ? dest.split("@")[1] : dest;
    if (!host) return [["usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address] destination [command [argument ...]]", "warn"]];
    const t = target(a, host, 22);
    if (t.err) return [[`ssh: Could not resolve hostname ${host}: nodename nor servname provided, or not known`, "warn"]];
    const r = tcp(a, t, 22);
    if (r === "timeout") return [[`ssh: connect to host ${host} port 22: Operation timed out`, "warn"]];
    if (r === "refused") return [[`ssh: connect to host ${host} port 22: Connection refused`, "warn"]];
    if (!t.inst) return [[`kex_exchange_identification: read: Connection reset by peer`, "warn"]];
    if (!args.includes("-i") && !a.session) return [[`${dest.includes("@") ? dest.split("@")[0] : "you"}@${host}: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).`, "warn"]];
    a.session = t.inst;
    a.sessionUser = dest.includes("@") ? dest.split("@")[0] : "ec2-user";
    return [["   ,     #_"], ["   ~\\_  ####_        Amazon Linux 2023"], ["  ~~  \\_#####\\"], ["  ~~     \\###|"], ["  ~~       \\#/ ___   https://aws.amazon.com/linux/amazon-linux-2023"]];
  }
  // A small jq: '.', '.a.b', '.a[0].b', '.a[].b' and -r.
  function jq(text, args) {
    const raw = args.includes("-r");
    const filter = args.find((x) => !x.startsWith("-")) || ".";
    let data;
    try { data = JSON.parse(text); } catch { return [["jq: error (at <stdin>:1): Cannot index string", "warn"]]; }
    let v;
    if (filter === ".") v = data;
    else {
      try { v = query(filter.replace(/^\./, "").replace(/\.\[/g, "["), data); } catch { return [[`jq: error: syntax error, unexpected INVALID_CHARACTER (Unix shell quoting issues?) at <top-level>, line 1:`, "warn"], [filter, "warn"]]; }
    }
    const list = /\[\]/.test(filter) && Array.isArray(v) ? v : [v];
    return list.flatMap((x) => (raw && typeof x === "string" ? x : JSON.stringify(x, null, 2)).split("\n")).map((t) => [t]);
  }

  // Runs one simple command. Returns [lines, exitCode].
  function command(a, argv, input) {
    const [cmd, ...args] = argv;
    const ok = (lines) => [lines, lines.some((l) => l[1] === "warn") ? 1 : 0];
    switch (cmd) {
      case "aws": { const lines = aws(a, args, a.session); return [lines, lines.some((l) => l[1] === "warn") ? 254 : 0]; }
      case "sudo": return args.length ? command(a, args, input) : [[["usage: sudo -h | -K | -k | -V", "warn"]], 1];
      case "export":
        for (const kv of args) { const i = kv.indexOf("="); if (i > 0) a.env[kv.slice(0, i)] = kv.slice(i + 1); }
        return [[], 0];
      case "unset": for (const k of args) delete a.env[k]; return [[], 0];
      case "env": case "printenv": {
        const vars = { HOME: a.session ? "/home/ssm-user" : "/Users/you", SHELL: "/bin/zsh", ...a.env };
        if (cmd === "printenv" && args[0]) return vars[args[0]] !== undefined ? [[[vars[args[0]]]], 0] : [[], 1];
        return [Object.entries(vars).map(([k, v]) => [`${k}=${v}`]), 0];
      }
      case "echo": return [[[args.filter((x) => x !== "-n").join(" ")]], 0];
      case "pwd": return [[[a.session ? "/usr/bin" : "/Users/you/quest-kitchen"]], 0];
      case "whoami": return [[[a.session ? a.sessionUser || "ssm-user" : "you"]], 0];
      case "hostname": return [[[a.session ? `${PROMPT_HOST(a.session)}.ec2.internal` : "laptop.local"]], 0];
      case "ls": {
        const dir = (args.find((x) => !x.startsWith("-")) || "").replace(/\/$/, "");
        const names = [...new Set(Object.keys(a.files).filter((f) => !dir || f.startsWith(dir + "/")).map((f) => (dir ? f.slice(dir.length + 1) : f).split("/")[0] + ((dir ? f.slice(dir.length + 1) : f).includes("/") ? "/" : "")))].sort();
        if (dir && !names.length) return [[[`ls: ${dir}: No such file or directory`, "warn"]], 1];
        return [names.length ? [[names.join("  ")]] : [], 0];
      }
      case "cat": {
        if (!args.length) return [(input || []).map((t) => [t]), 0];
        const out = [];
        for (const f of args) {
          const t = a.files[f.replace(/^\.\//, "")];
          if (t === undefined) return [[...out, [`cat: ${f}: No such file or directory`, "warn"]], 1];
          out.push(...t.replace(/\n$/, "").split("\n").map((x) => [x]));
        }
        return [out, 0];
      }
      case "grep": {
        const flags = args.filter((x) => /^-[a-zA-Z]+$/.test(x)).join("");
        const [pat, ...paths] = args.filter((x) => !/^-[a-zA-Z]+$/.test(x));
        if (pat === undefined) return [[["usage: grep [-abcdDEFGHhIiJLlMmnOopqRSsUVvwXxZz] [-A num] [-B num] [-C[num]] [pattern] [file ...]", "warn"]], 2];
        let re;
        try { re = new RegExp(pat, flags.includes("i") ? "i" : ""); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags.includes("i") ? "i" : ""); }
        if (!paths.length && input) {
          const hits = input.filter((l) => re.test(l) !== flags.includes("v"));
          return [flags.includes("c") ? [[String(hits.length)]] : hits.map((t) => [t]), hits.length ? 0 : 1];
        }
        const files = Object.keys(a.files).filter((f) => paths.some((p) => p === "." || f === p.replace(/^\.\//, "") || f.startsWith(p.replace(/^\.\/|\/$/g, "") + "/")));
        const hits = files.flatMap((f) => a.files[f].split("\n").map((l, n) => [f, n + 1, l]).filter(([, , l]) => re.test(l)));
        return [hits.map(([f, n, l]) => [`${f}:${flags.includes("n") ? n + ":" : ""}${l}`]), hits.length ? 0 : 1];
      }
      case "git": {
        if (args[0] === "log") return ok((a.git || []).map(([sha, msg]) => [`${sha} ${msg}`]));
        if (args[0] === "grep") return command(a, ["grep", "-n", ...args.slice(1).filter((x) => !x.startsWith("-")), "."], input);
        if (args[0] === "status") return [[["On branch main"], ["nothing to commit, working tree clean"]], 0];
        return [[[`git: '${args[0] || ""}' is not a git command here. The playground has git log, git grep and git status.`, "warn"]], 1];
      }
      case "curl": return ok(curl(a, args));
      case "kubectl": return ok(kubectl(a, args));
      case "./inventory.sh": case "bash": case "sh":
        if (cmd !== "./inventory.sh" && !/inventory\.sh$/.test(args[0] || "")) return [[[`${cmd}: the playground runs only ./inventory.sh`, "warn"]], 127];
        if (a.files["inventory.sh"] === undefined) return [[[`zsh: no such file or directory: ./inventory.sh`, "warn"]], 127];
        return ok(inventory(a));
      case "dig": return ok(dig(a, args));
      case "nslookup": case "host": return ok(nslookup(a, args));
      case "nc": case "ncat": case "telnet": return ok(nc(a, args));
      case "psql": return ok(psql(a, args));
      case "ssh": return ok(ssh(a, args));
      case "ping": {
        const host = args.find((x) => !x.startsWith("-") && !/^\d+$/.test(x)) || "";
        const t = target(a, host, 0);
        if (t.err) return [[[`ping: cannot resolve ${host}: Unknown host`, "warn"]], 68];
        return [[[`PING ${host} (${t.ip}): 56 data bytes`], ["Request timeout for icmp_seq 0", "warn"], ["Request timeout for icmp_seq 1", "warn"], [""], [`--- ${host} ping statistics ---`], ["2 packets transmitted, 0 packets received, 100.0% packet loss"],
          ["(Security groups block ICMP unless a rule allows it, so ping says little here. Test the real port with nc -vz or curl.)", "dim"]], 2];
      }
      case "head": case "tail": {
        const n = Number((args.find((x) => /^-?\d+$/.test(x)) || "10").replace("-", "")) || 10;
        const list = input || [];
        return [(cmd === "head" ? list.slice(0, n) : list.slice(-n)).map((t) => [t]), 0];
      }
      case "wc": return [[[String(args.includes("-l") ? (input || []).length : (input || []).join("\n").length)]], 0];
      case "sort": return [[...(input || [])].sort().map((t) => [t]), 0];
      case "jq": return ok(jq((input || []).join("\n"), args));
      case "exit": case "logout":
        if (!a.session) return [[["(You are on your laptop; there is nothing to exit.)", "dim"]], 0];
        a.session = null;
        return [[[""], [`Exiting session with sessionId: you-${hexOf("ssm" + a.seq, 17)}.`]], 0];
      default:
        return [[[`${a.session ? "sh" : "zsh"}: command not found: ${cmd}`, "warn"]], 127];
    }
  }

  // A line: VAR=$(...) assignments, ; && || sequences, pipes and > redirects.
  function shell(a, line) {
    const out = [];
    const assign = /^\s*(\w+)=\$\((.*)\)\s*$/.exec(line);
    if (assign) {
      const r = shell(a, assign[2]);
      a.env[assign[1]] = r.filter((l) => l[1] !== "warn").map((l) => l[0]).join("\n").trim();
      return r.filter((l) => l[1] === "warn");
    }
    const plain = /^\s*(\w+)=(\S*)\s*$/.exec(line);
    if (plain) { a.env[plain[1]] = plain[2]; return []; }
    a.history.push(line);
    const toks = lex(line, a.env);
    if (!toks) return [["zsh: unmatched quote", "warn"]];
    let status = 0, skip = false;
    let seg = [];
    const flush = () => {
      if (!seg.length) return;
      if (!skip) status = pipeline(a, seg, out);
      seg = [];
    };
    for (const t of toks) {
      if (t.op === ";" || t.op === "&&" || t.op === "||") {
        flush();
        skip = (t.op === "&&" && status !== 0) || (t.op === "||" && status === 0);
        if (t.op === ";") skip = false;
      } else seg.push(t);
    }
    flush();
    a.tick();
    return out;
  }
  function pipeline(a, toks, out) {
    const stages = [[]];
    let redirect = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.op === "|") stages.push([]);
      else if (t.op === ">" || t.op === ">>") redirect = { file: (toks[++i] || {}).w, append: t.op === ">>" };
      else if (t.w !== undefined) stages[stages.length - 1].push(t.w);
    }
    let lines = null, code = 0, errs = [];
    for (const argv of stages) {
      if (!argv.length) { errs.push(["zsh: parse error near `|'", "warn"]); return 1; }
      const [res, c] = command(a, argv, lines && lines.map((l) => l[0]));
      errs = errs.concat(res.filter((l) => l[1] === "warn" && lines !== null));
      lines = res;
      code = c;
    }
    if (redirect && redirect.file) {
      const f = redirect.file.replace(/^\.\//, "");
      const text = lines.filter((l) => l[1] !== "warn").map((l) => l[0]).join("\n") + "\n";
      a.files[f] = (redirect.append ? a.files[f] || "" : "") + text;
      lines = lines.filter((l) => l[1] === "warn");
    }
    out.push(...lines);
    return code;
  }

  // Fill a reference command's <blanks> from what the open scenario has, so a
  // cheat sheet command runs as written.
  function fillBlanks(a, cmd) {
    const b = a.scenario.blanks || {};
    const bucket = b.bucket || Object.keys(a.buckets).find((n) => n !== "quest-kitchen-assets") || "quest-kitchen-assets";
    const inst = a.inst(b.instance || "") || a.instances[0];
    const tg = a.tg(b.tg || "") || a.tgs[0];
    const fn = a.lambdas[0];
    const values = {
      bucket, "instance-id": inst && inst.id, "sg-id": (a.sg(b.sg || "") || a.sg(inst ? inst.sgs[0] : "") || a.sgs[1]).id, role: b.role || "web-role", user: b.user || Object.keys(a.iam.users).find((n) => n !== "breakglass") || "breakglass",
      function: fn && fn.name, "log-group": b.logGroup || (a.logGroups[0] || {}).name, "tg-arn": tg && tg.arn, "alb-arn": a.albs[0] && a.albs[0].arn, "listener-arn": a.albs[0] && a.albs[0].listeners[0].arn,
      "zone-id": a.zones[0] && a.zones[0].id, "alloc-id": (a.eips.find((e) => !e.assoc) || a.eips[0] || {}).alloc, "vpc-id": a.vpcs[0].id, "subnet-id": (a.sub(b.subnet || "") || a.sub("public-a")).id,
      "rtb-id": (a.rt(b.rtb || "") || a.rt("private-rt")).id, "key-id": a.kmsKeys[0] && a.kmsKeys[0].alias, "nat-id": a.nats[0] && a.nats[0].id, "volume-id": (a.volumes.find((v) => !v.attached) || a.volumes[0]).id,
      "snapshot-id": a.snapshots[0] && a.snapshots[0].id, db: a.dbs[0].id, asg: a.asgs[0].name, "acl-id": a.nacls[a.nacls.length - 1].id, "access-key-id": ((a.iam.users[b.user || ""] || {}).keys || [])[0] || (Object.values(a.creds).find((k) => !k.session) || {}).id,
      policy: Object.keys((a.iam.users[b.user || ""] || Object.values(a.iam.users).find((u) => Object.keys(u.inline).length) || { inline: {} }).inline)[0],
      cluster: a.eks ? a.eks.name : (a.ecs.services[0] || { cluster: "kitchen" }).cluster, service: (a.ecs.services[0] || {}).name,
      "task-arn": a.ecs.services[0] ? `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${a.ecs.services[0].cluster}/${hexOf(`${a.ecs.services[0].name}stopped0`, 32)}` : null,
      "secret-id": (a.secrets[0] || {}).name, table: (a.tables[0] || {}).name, "queue-url": (a.queues[0] || {}).url, "dist-id": (a.dists[0] || {}).id,
      "pcx-id": (a.peerings[0] || {}).id, key: Object.keys((a.buckets[bucket] || { objects: {} }).objects)[0],
      "detector-id": hexOf("detector", 32), prefix: ((Object.keys((a.buckets[bucket] || { objects: {} }).objects)[0] || "").split("/")[0] || "") + "/", profile: b.profile || "default", alarm: (a.alarms[0] || {}).name, domain: "example.com", "trail": a.trail.name, "account-id": ACCOUNT
    };
    return cmd.replace(/<([a-z-]+)>/g, (m, k) => (values[k] ? values[k] : m));
  }

  // --- scenarios -------------------------------------------------------------------

  const SUB = (n) => rid("subnet", n);
  const SGI = (n) => rid("sg", n);
  const II = (n) => rid("i", n);
  const pretty = (d) => JSON.stringify(d, null, 2) + "\n";
  const AMI = "ami-0c02fb55b34e7ea4f";
  // What a request from your laptop gets: an HTTP status, or why it failed.
  function fromLaptop(a, host, path = "/", port = 80) {
    const saved = a.session;
    a.session = null;
    try {
      const t = target(a, host, port);
      if (t.err) return "resolve";
      const c = tcp(a, t, port);
      if (c !== "ok") return c;
      const r = t.alb ? a.albGet(t.alb, path, { kind: "internet", ip: LAPTOP }) : t.inst ? a.appGet(t.inst, path) : { code: 0 };
      return r.err || r.code;
    } finally { a.session = saved; }
  }
  function fromLaptopHttps(a, host) {
    const saved = a.session;
    a.session = null;
    try {
      const t = target(a, host, 443);
      if (t.err) return "does not resolve";
      if (!t.cf) return "not CloudFront";
      const r = a.cfGet(t.cf, host, "/");
      return r.tls ? "certificate error" : r.code;
    } finally { a.session = saved; }
  }
  const said = (r) => (typeof r === "number" ? `HTTP ${r}` : r === "resolve" ? "does not resolve" : r === "timeout" ? "times out" : "connection refused");
  // A rule open to 0.0.0.0/0 for anything but the listed single ports.
  const worldOpen = (a, sg, allowed = []) => (a.sg(sg) || { in: [] }).in.some((r) => r.cidr === "0.0.0.0/0" && !(r.proto === "tcp" && r.from === r.to && allowed.includes(r.from)));
  const broadCidr = (a, sg) => (a.sg(sg) || { in: [] }).in.some((r) => r.cidr && Number(r.cidr.split("/")[1]) < 24);
  function s3can(a, who, action, bucket, key) { try { a.s3Check(who, action, bucket, key); return true; } catch { return false; } }
  function blogSetup(a, o = {}) {
    a.addSg("blog-sg", "Company blog", o.rules || [{ proto: "tcp", from: 22, to: 22, cidr: "192.0.2.0/24", desc: "office" }, { proto: "tcp", from: 80, to: 80, cidr: "0.0.0.0/0" }]);
    const i = a.addInstance({ name: "blog", type: "t3.micro", subnet: o.subnet || "public-a", sgs: ["blog-sg"], ip: o.ip || "10.0.1.30", app: "blog", publicIp: o.publicIp === undefined ? PUBLIC_IP(10) : o.publicIp, role: "web-role", state: o.state, tags: { env: "prod" } });
    if (o.dns !== false) a.zones[0].records.push({ Name: "blog.example.com.", Type: "A", TTL: 300, ResourceRecords: [{ Value: PUBLIC_IP(10) }] });
    return i;
  }
  function profileKey(a, profile, user) {
    const k = a.addKey(a.iam.users[user], user);
    a.profiles[profile] = { key: k.id, secret: k.secret };
    return k;
  }
  const allTargetsHealthy = (a, tg) => tg.targets.length > 0 && tg.targets.every((t) => a.health(tg, t).State === "healthy");
  const strictMatcher = (m) => String(m).split(",").every((x) => { const [lo, hi] = x.split("-").map(Number); return lo >= 200 && (hi || lo) <= 399; });
  const pub = (a, n) => a.publicIpOf(a.inst(n));

  const SCENARIOS = [
    // IAM and access
    {
      id: "s3list", title: "AccessDenied on ListBucket", level: "01",
      story: "Priya in finance runs aws s3 ls s3://quest-kitchen-reports --profile analyst and gets AccessDenied. She can download a report if she knows its name, but cannot list the folder.",
      goal: "Let the analyst profile list quest-kitchen-reports, and nothing more.",
      done: "The analyst can list the reports bucket, and only that bucket.",
      setup(a) {
        a.addBucket("quest-kitchen-reports", { objects: { "monthly/2026-09.csv": { size: 48211 }, "monthly/2026-10.csv": { size: 50177 } } });
        a.addBucket("quest-kitchen-payroll", { objects: { "2026/10/payroll.csv": { size: 9120 } } });
        const d = doc({ Sid: "ReadReports", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::quest-kitchen-reports/*" });
        a.addUser("analyst", [], { "reports-read": d });
        profileKey(a, "analyst", "analyst");
        a.files["reports-read.json"] = pretty(d);
      },
      won: (a) => s3can(a, a.user("analyst"), "s3:ListBucket", "quest-kitchen-reports") && !s3can(a, a.user("analyst"), "s3:ListBucket", "quest-kitchen-payroll") &&
        !s3can(a, a.user("analyst"), "s3:GetObject", "quest-kitchen-payroll", "2026/10/payroll.csv") && !s3can(a, a.user("analyst"), "s3:PutObject", "quest-kitchen-reports", "x"),
      check: (a) => ({ label: "analyst: list reports, not payroll", text: `${s3can(a, a.user("analyst"), "s3:ListBucket", "quest-kitchen-reports") ? "can list reports" : "cannot list reports"}${s3can(a, a.user("analyst"), "s3:GetObject", "quest-kitchen-payroll", "2026/10/payroll.csv") ? ", can read payroll" : ""}` }),
      hints: [
        "Run it yourself: aws s3 ls s3://quest-kitchen-reports --profile analyst. Read the whole message: which action, on which resource, and why.",
        "aws iam get-user-policy --user-name analyst --policy-name reports-read. Listing is s3:ListBucket on the bucket ARN; s3:GetObject is on the objects, bucket/*.",
        "Add a statement to reports-read.json allowing s3:ListBucket on arn:aws:s3:::quest-kitchen-reports, then: aws iam put-user-policy --user-name analyst --policy-name reports-read --policy-document file://reports-read.json"
      ],
      lesson: "s3:ListBucket acts on the bucket and s3:GetObject on the objects in it: two ARNs. Grant each on its own resource; AmazonS3ReadOnlyAccess would also have opened the payroll bucket.",
      tries: ["aws s3 ls s3://quest-kitchen-reports --profile analyst", "aws iam get-user-policy --user-name analyst --policy-name reports-read"],
      edit: ["reports-read.json"], blanks: { bucket: "quest-kitchen-reports", user: "analyst", profile: "analyst" }
    },
    {
      id: "explicitdeny", title: "Explicit deny wins", level: "03",
      story: "dev-box has run all weekend for nothing. The on-call engineer has AmazonEC2FullAccess, yet aws ec2 stop-instances fails with UnauthorizedOperation.",
      goal: "Let the oncall profile stop dev-box, while instances tagged env=prod stay protected.",
      done: "oncall can stop dev-box; production is still protected.",
      setup(a) {
        a.addInstance({ name: "dev-box", type: "t3.large", subnet: "private-b", sgs: ["default"], tags: { env: "dev" }, launched: START - 3 * DAY });
        const d = doc({ Sid: "ProtectProduction", Effect: "Deny", Action: ["ec2:StopInstances", "ec2:TerminateInstances"], Resource: "*" });
        a.addUser("oncall", [awsPolicyArn("AmazonEC2FullAccess")], { "protect-prod": d });
        profileKey(a, "oncall", "oncall");
        a.files["protect-prod.json"] = pretty(d);
      },
      won(a) {
        const can = (n) => evaluate(a, a.user("oncall"), "ec2:StopInstances", instArn(a.inst(n)), { keys: Object.fromEntries(Object.entries(a.inst(n).tags).flatMap(([k, v]) => [[`aws:ResourceTag/${k}`, v], [`ec2:ResourceTag/${k}`, v]])) }).allowed;
        return can("dev-box") && !can("web-1") && !can("web-2");
      },
      check(a) {
        const can = (n) => evaluate(a, a.user("oncall"), "ec2:StopInstances", instArn(a.inst(n)), { keys: Object.fromEntries(Object.entries(a.inst(n).tags).flatMap(([k, v]) => [[`aws:ResourceTag/${k}`, v], [`ec2:ResourceTag/${k}`, v]])) }).allowed;
        return { label: "oncall: stop dev-box / stop web-1", text: `${can("dev-box") ? "allowed" : "denied"} / ${can("web-1") ? "allowed" : "denied"}` };
      },
      hints: [
        "aws ec2 stop-instances --instance-ids <dev-box id> --profile oncall, then decode the message: aws sts decode-authorization-message --encoded-message <message> --query DecodedMessage --output text",
        "\"explicitDeny\":true. aws iam list-user-policies --user-name oncall and get-user-policy for protect-prod: the Deny has Resource \"*\", so it hits every instance.",
        "Scope the deny: add \"Condition\": {\"StringEquals\": {\"aws:ResourceTag/env\": \"prod\"}} to the statement in protect-prod.json, then aws iam put-user-policy --user-name oncall --policy-name protect-prod --policy-document file://protect-prod.json"
      ],
      lesson: "An explicit Deny beats every Allow, so attaching AdministratorAccess changes nothing. Make the guard rail say exactly what it protects, here with a tag condition, rather than deleting it.",
      tries: ["aws ec2 describe-instances --filters Name=tag:Name,Values=dev-box --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text", "aws iam list-user-policies --user-name oncall"],
      edit: ["protect-prod.json"], blanks: { instance: "dev-box", user: "oncall", profile: "oncall" }
    },
    {
      id: "trust", title: "Role cannot be assumed", level: "02",
      story: "The deploy pipeline broke overnight: its first step, aws sts assume-role for deploy-role, fails with AccessDenied. Nobody changed the pipeline, but old IAM users were tidied up last week.",
      goal: "Let ci-bot assume deploy-role, and only ci-bot.",
      done: "ci-bot can assume deploy-role, and the trust policy names only ci-bot.",
      setup(a) {
        a.addUser("ci-bot", [], { "assume-deploy": doc({ Effect: "Allow", Action: "sts:AssumeRole", Resource: `arn:aws:iam::${ACCOUNT}:role/deploy-role` }) });
        a.addUser("intern");
        profileKey(a, "ci", "ci-bot");
        const trust = doc({ Effect: "Allow", Principal: { AWS: keyId("AIDA", "cirunner") }, Action: "sts:AssumeRole" });
        a.addRole("deploy-role", trust, [awsPolicyArn("PowerUserAccess")]);
        a.files["trust.json"] = pretty(trust);
      },
      won: (a) => a.canAssume(a.user("ci-bot"), "deploy-role") && !a.trustNames(a.iam.roles["deploy-role"], a.outsider()) && !a.trustNames(a.iam.roles["deploy-role"], a.user("intern")),
      check: (a) => ({ label: "ci-bot assumes deploy-role", text: a.canAssume(a.user("ci-bot"), "deploy-role") ? (a.trustNames(a.iam.roles["deploy-role"], a.outsider()) ? "allowed, but so is anyone" : "allowed") : "AccessDenied" }),
      hints: [
        `Try it: aws sts assume-role --role-arn arn:aws:iam::${ACCOUNT}:role/deploy-role --role-session-name deploy --profile ci`,
        "aws iam get-role --role-name deploy-role. The trust policy names a principal like AIDA...: IAM shows that when the user it trusted has been deleted.",
        `Put ci-bot's ARN (arn:aws:iam::${ACCOUNT}:user/ci-bot) in trust.json, then: aws iam update-assume-role-policy --role-name deploy-role --policy-document file://trust.json`
      ],
      lesson: "Assuming a role takes two yeses: the caller's policy allows sts:AssumeRole, and the role's trust policy names the caller. A deleted user's ARN turns into its unique ID, and a recreated user with the same name is a different principal.",
      tries: [`aws sts assume-role --role-arn arn:aws:iam::${ACCOUNT}:role/deploy-role --role-session-name deploy --profile ci`, "aws iam get-role --role-name deploy-role"],
      edit: ["trust.json"], blanks: { role: "deploy-role", user: "ci-bot", profile: "ci" }
    },
    {
      id: "oidc", title: "GitHub Actions cannot assume its role", level: "18",
      story: "The repository moved from SandeepKomal/kitchen-old to SandeepKomal/quest-kitchen. Since then the deploy workflow fails at configure-aws-credentials with: Not authorized to perform sts:AssumeRoleWithWebIdentity.",
      goal: "Let the main branch of SandeepKomal/quest-kitchen assume gh-deploy, and no other repository.",
      done: "Only quest-kitchen's main branch can assume gh-deploy.",
      setup(a) {
        const fed = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
        const trust = doc({ Effect: "Allow", Principal: { Federated: fed }, Action: "sts:AssumeRoleWithWebIdentity",
          Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": "repo:SandeepKomal/kitchen-old:ref:refs/heads/main" } } });
        a.addRole("gh-deploy", trust, [awsPolicyArn("PowerUserAccess")]);
        a.files["trust.json"] = pretty(trust);
        a.files["token-claims.json"] = pretty({ iss: "https://token.actions.githubusercontent.com", aud: "sts.amazonaws.com", sub: "repo:SandeepKomal/quest-kitchen:ref:refs/heads/main", repository: "SandeepKomal/quest-kitchen", ref: "refs/heads/main", workflow: "deploy" });
        a.webToken = { sub: "repo:SandeepKomal/quest-kitchen:ref:refs/heads/main", aud: "sts.amazonaws.com" };
      },
      won(a) {
        const can = (sub) => webIdentityOk(a, "gh-deploy", { sub, aud: "sts.amazonaws.com" });
        return can("repo:SandeepKomal/quest-kitchen:ref:refs/heads/main") && !can("repo:someone-else/fork:ref:refs/heads/main") && !can("repo:SandeepKomal/quest-kitchen:pull_request");
      },
      check: (a) => ({ label: "quest-kitchen main / any other repo", text: `${webIdentityOk(a, "gh-deploy", { sub: "repo:SandeepKomal/quest-kitchen:ref:refs/heads/main", aud: "sts.amazonaws.com" }) ? "allowed" : "denied"} / ${webIdentityOk(a, "gh-deploy", { sub: "repo:someone-else/fork:ref:refs/heads/main", aud: "sts.amazonaws.com" }) ? "allowed" : "denied"}` }),
      hints: [
        "The workflow's token claims are in token-claims.json (cat token-claims.json). Try: aws sts assume-role-with-web-identity --role-arn arn:aws:iam::111122223333:role/gh-deploy --role-session-name gh --web-identity-token file://token-claims.json",
        "aws iam get-role --role-name gh-deploy --query Role.AssumeRolePolicyDocument. Compare the sub condition with the token's sub.",
        "In trust.json set the sub to repo:SandeepKomal/quest-kitchen:ref:refs/heads/main, then: aws iam update-assume-role-policy --role-name gh-deploy --policy-document file://trust.json"
      ],
      lesson: "With GitHub OIDC there are no stored keys: the trust policy's sub condition decides which repository and branch get the role. Never widen it to repo:* or *; that hands your account to every repository on GitHub.",
      tries: ["cat token-claims.json", "aws iam get-role --role-name gh-deploy --query Role.AssumeRolePolicyDocument"],
      edit: ["trust.json"], blanks: { role: "gh-deploy" }
    },
    {
      id: "expired", title: "ExpiredToken", level: "00",
      story: "Yesterday you pasted temporary credentials into this terminal to debug something. This morning every aws command fails with ExpiredToken, and logging in to SSO again did not help.",
      goal: "Make the CLI use your SSO profile again, with fresh credentials.",
      done: "The CLI uses your SSO profile again.",
      setup(a) {
        const id = keyId("ASIA", "yesterday");
        a.creds[id] = { id, secret: blob("old" + id, 40), token: blob("oldtok", 120), session: true, who: { kind: "role", role: "PlatformAdmin", session: "debug" }, status: "Active", created: START - 20 * HOUR, expires: START - 19 * HOUR };
        Object.assign(a.env, { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: a.creds[id].secret, AWS_SESSION_TOKEN: a.creds[id].token });
        a.sso.valid = false;
      },
      won(a) { try { const src = credSource(a, null, null); return src.kind === "profile" && Boolean(whoAmI(a, src, "GetCallerIdentity", "sts")); } catch { return false; } },
      check(a) {
        try { const who = whoAmI(a, credSource(a, null, null), "GetCallerIdentity", "sts"); return { label: "aws sts get-caller-identity", text: `${who.arn.split("/").slice(-2).join("/")} via ${credSource(a, null, null).kind}` }; }
        catch (e) { return { label: "aws sts get-caller-identity", text: e.code || "SSO token expired" }; }
      },
      hints: [
        "aws sts get-caller-identity, then aws configure list. Which Type does the access_key come from?",
        "Environment variables win over your profile. env | grep AWS shows yesterday's leftovers.",
        "unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN, then aws sso login (your SSO session expired too)."
      ],
      lesson: "The CLI takes credentials from --profile first, then the AWS_* environment variables, then the profile. Stale session variables hide a good profile, so logging in again changes nothing until you unset them.",
      tries: ["aws sts get-caller-identity", "aws configure list"]
    },
    {
      id: "passrole", title: "UnauthorizedOperation: iam:PassRole", level: "02",
      story: "A developer launches a test server with the web-role instance profile and gets UnauthorizedOperation with a long encoded message. The same command without the profile works.",
      goal: "Let dev launch the instance with web-role, without letting dev pass any other role.",
      done: "dev launched the instance with web-role, and can pass no other role.",
      setup(a) {
        const d = doc({ Sid: "LaunchInstances", Effect: "Allow", Action: ["ec2:RunInstances", "ec2:Describe*", "ec2:CreateTags"], Resource: "*" }, { Sid: "ReadErrors", Effect: "Allow", Action: "sts:DecodeAuthorizationMessage", Resource: "*" });
        a.addUser("dev", [], { "dev-ec2": d });
        profileKey(a, "dev", "dev");
        a.addRole("break-glass", trustService("ec2.amazonaws.com"), [awsPolicyArn("AdministratorAccess")]);
        a.files["dev-ec2.json"] = pretty(d);
      },
      won: (a) => a.instances.some((i) => i.by === a.user("dev").arn && i.role === "web-role") && !a.can(a.user("dev"), "iam:PassRole", iamArn("role", "break-glass"), { keys: { "iam:PassedToService": "ec2.amazonaws.com" } }),
      check: (a) => ({ label: "dev: pass web-role / break-glass", text: `${a.can(a.user("dev"), "iam:PassRole", iamArn("role", "web-role"), { keys: { "iam:PassedToService": "ec2.amazonaws.com" } }) ? "allowed" : "denied"} / ${a.can(a.user("dev"), "iam:PassRole", iamArn("role", "break-glass"), { keys: { "iam:PassedToService": "ec2.amazonaws.com" } }) ? "allowed" : "denied"}` }),
      hints: [
        "Run the launch (the first Try below) and copy the encoded message.",
        "aws sts decode-authorization-message --encoded-message <message> --query DecodedMessage --output text. Which action was denied, on which resource?",
        `Add a statement to dev-ec2.json allowing iam:PassRole on arn:aws:iam::${ACCOUNT}:role/web-role, then aws iam put-user-policy --user-name dev --policy-name dev-ec2 --policy-document file://dev-ec2.json, and launch again.`
      ],
      lesson: "Giving an instance a role means passing the role, which needs iam:PassRole on that role. Scope it to the role (and iam:PassedToService): iam:PassRole on * lets a developer hand any role, an admin one included, to code they control.",
      tries: [`aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id ${SUB("private-a")} --iam-instance-profile Name=web-role --profile dev`, "aws iam get-user-policy --user-name dev --policy-name dev-ec2"],
      edit: ["dev-ec2.json"], blanks: { user: "dev", profile: "dev" }
    },
    {
      id: "scp", title: "Denied by a service control policy", level: "03",
      story: "Legal wants the EU order archive stored in Europe. You are an administrator, yet aws s3 mb s3://quest-kitchen-archive-eu --region eu-central-1 fails with AccessDenied.",
      goal: "Create the archive bucket in an EU Region your organization allows.",
      done: "The archive bucket exists in an allowed EU Region.",
      setup(a) {
        a.scps = [JSON.stringify(doc({ Sid: "FullAWSAccess", Effect: "Allow", Action: "*", Resource: "*" })), JSON.stringify(doc({ Sid: "DenyOtherRegions", Effect: "Deny",
          NotAction: ["iam:*", "organizations:*", "route53:*", "sts:*", "support:*", "cloudfront:*", "s3:ListAllMyBuckets"], Resource: "*", Condition: { StringNotEquals: { "aws:RequestedRegion": ["us-east-1", "eu-west-1"] } } }))];
        a.files["scp-note.txt"] = "Organization guard rail, from the platform team:\nworkloads may run only in us-east-1 and eu-west-1.\nFor anything else, open a ticket with the cloud platform team.\n";
      },
      won: (a) => Object.values(a.buckets).some((b) => b.name.startsWith("quest-kitchen-archive") && b.region === "eu-west-1"),
      check: (a) => ({ label: "EU archive bucket", text: (Object.values(a.buckets).find((b) => b.name.startsWith("quest-kitchen-archive")) || { region: "not created" }).region }),
      hints: [
        "Read the end of the error: with an explicit deny in a service control policy. SCPs are set by your organization's management account, above every policy in this account.",
        "You cannot read or change it from here (try aws organizations list-policies --filter SERVICE_CONTROL_POLICY). Which Regions are allowed? cat scp-note.txt",
        "aws s3 mb s3://quest-kitchen-archive-eu --region eu-west-1"
      ],
      lesson: "A service control policy caps what any principal in the account can do, administrators and the root user included. No IAM change in the account overrides it; work inside it or ask the organization's owners.",
      tries: ["aws s3 mb s3://quest-kitchen-archive-eu --region eu-central-1", "cat scp-note.txt"]
    },

    // Networking
    {
      id: "sgweb", title: "Website times out: security group", level: "06",
      story: "The new company blog at http://blog.example.com times out for everyone. The instance is running and nginx is up.",
      goal: "Make the blog answer on port 80 from the internet, without opening any other port to it.",
      done: "The blog answers on port 80, and nothing else is open to the world.",
      setup(a) { blogSetup(a, { rules: [{ proto: "tcp", from: 22, to: 22, cidr: "192.0.2.0/24", desc: "office" }, { proto: "tcp", from: 80, to: 80, cidr: "10.0.0.0/16" }] }); },
      won: (a) => fromLaptop(a, "blog.example.com") === 200 && !worldOpen(a, "blog-sg", [80, 443]),
      check: (a) => ({ label: "curl http://blog.example.com", text: said(fromLaptop(a, "blog.example.com")) + (worldOpen(a, "blog-sg", [80, 443]) ? ", but other ports are open to the world" : "") }),
      hints: [
        "curl -m 5 http://blog.example.com times out: packets are dropped. A timeout points at a security group, NACL or route; connection refused would mean nothing is listening.",
        "aws ec2 describe-security-groups --group-names blog-sg. Port 80 is allowed only from 10.0.0.0/16, inside the VPC.",
        `aws ec2 authorize-security-group-ingress --group-id ${SGI("blog-sg")} --protocol tcp --port 80 --cidr 0.0.0.0/0`
      ],
      lesson: "A security group allows only what it lists, and a timeout is its signature. Open exactly the port the service needs; opening all traffic to 0.0.0.0/0 to make it work turns a broken site into an exposed server.",
      tries: ["curl -m 5 http://blog.example.com", "aws ec2 describe-security-groups --group-names blog-sg"],
      blanks: { instance: "blog", sg: "blog-sg" }
    },
    {
      id: "nopublicip", title: "No public IP address", level: "05",
      story: "The blog server sits in a public subnet with port 80 open to the world, yet nobody can reach it: it has no public address at all.",
      goal: "Give the blog a stable public address that answers on port 80.",
      done: "The blog has an Elastic IP and answers on it.",
      setup(a) { a.sub("public-a").mapPublic = false; blogSetup(a, { publicIp: null, dns: false }); },
      won: (a) => a.eips.some((e) => e.assoc === II("blog")) && fromLaptop(a, pub(a, "blog") || "0.0.0.0") === 200,
      check: (a) => ({ label: "blog public address", text: pub(a, "blog") ? `${pub(a, "blog")}: ${said(fromLaptop(a, pub(a, "blog")))}` : "none" }),
      hints: [
        "aws ec2 describe-instances --filters Name=tag:Name,Values=blog --query 'Reservations[].Instances[].[PrivateIpAddress,PublicIpAddress]' --output text. None means no public IP.",
        "Stopping and starting will not add one: public-a does not auto-assign public IPs (aws ec2 describe-subnets shows MapPublicIpOnLaunch). An Elastic IP gives a fixed address.",
        `aws ec2 allocate-address, then aws ec2 associate-address --instance-id ${II("blog")} --allocation-id <the AllocationId>`
      ],
      lesson: "A public subnet only means its route table points at an internet gateway. An instance there still needs a public IPv4 address, and since 2024 every public IPv4 address is billed by the hour.",
      tries: ["aws ec2 describe-instances --filters Name=tag:Name,Values=blog --query 'Reservations[].Instances[].[PrivateIpAddress,PublicIpAddress]' --output text", "aws ec2 describe-subnets --query 'Subnets[].[Tags[0].Value,MapPublicIpOnLaunch]' --output text"],
      blanks: { instance: "blog", sg: "blog-sg" }
    },
    {
      id: "routeigw", title: "Subnet with no route to the internet", level: "04",
      story: "The blog was moved to a new subnet, public-c. It has a public IP and its security group allows port 80, but every request times out.",
      goal: "Route public-c to the internet gateway, without exposing the private subnets.",
      done: "public-c routes to the internet gateway; the private subnets do not.",
      setup(a) {
        a.subnets.push({ id: SUB("public-c"), name: "public-c", cidr: "10.0.3.0/24", az: "us-east-1c", vpc: a.vpcs[0].id, mapPublic: true });
        a.nacls[0].subnets.push(SUB("public-c"));
        blogSetup(a, { subnet: "public-c", ip: "10.0.3.30" });
      },
      won: (a) => fromLaptop(a, "blog.example.com") === 200 && !a.hasInternetRoute(SUB("private-a")) && !a.hasInternetRoute(SUB("private-b")),
      check: (a) => ({ label: "curl http://blog.example.com", text: said(fromLaptop(a, "blog.example.com")) + (a.hasInternetRoute(SUB("private-a")) ? ", and private-a is now public" : "") }),
      hints: [
        `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=${SUB("public-c")}. No result means the subnet uses the VPC's main route table.`,
        "aws ec2 describe-route-tables --filters Name=association.main,Values=true shows only the local route. Compare it with public-rt.",
        `aws ec2 associate-route-table --route-table-id ${rid("rtb", "public")} --subnet-id ${SUB("public-c")}`
      ],
      lesson: "Every subnet uses exactly one route table: its own association, or the VPC's main table. A 0.0.0.0/0 route to an attached internet gateway in that table is what makes a subnet public.",
      tries: ["curl -m 5 http://blog.example.com", "aws ec2 describe-route-tables --query 'RouteTables[].[RouteTableId,Tags[0].Value]' --output text"],
      blanks: { instance: "blog", subnet: "public-c", rtb: "public-rt" }
    },
    {
      id: "nacl", title: "Network ACL drops the replies", level: "06",
      story: "A security review tightened the network ACL on public-a. Since then the blog times out, although its security group has not changed.",
      goal: "Make the blog answer again while keeping the tightened network ACL.",
      done: "The blog answers, through the custom network ACL.",
      setup(a) {
        blogSetup(a);
        const id = rid("acl", "public-nacl");
        a.nacls[0].subnets = a.nacls[0].subnets.filter((s) => s !== SUB("public-a"));
        a.nacls.push({ id, name: "public-nacl", vpc: a.vpcs[0].id, isDefault: false, subnets: [SUB("public-a")], entries: [
          { n: 100, egress: false, proto: "6", from: 80, to: 80, cidr: "0.0.0.0/0", action: "allow" }, { n: 110, egress: false, proto: "6", from: 22, to: 22, cidr: "192.0.2.0/24", action: "allow" },
          { n: 100, egress: true, proto: "6", from: 80, to: 80, cidr: "0.0.0.0/0", action: "allow" }, { n: 110, egress: true, proto: "6", from: 443, to: 443, cidr: "0.0.0.0/0", action: "allow" }] });
      },
      won: (a) => fromLaptop(a, "blog.example.com") === 200 && a.naclOf(SUB("public-a")).id === rid("acl", "public-nacl") && !a.naclAllows(SUB("public-a"), false, 3389, "198.51.100.9"),
      check: (a) => ({ label: "curl http://blog.example.com", text: said(fromLaptop(a, "blog.example.com")) }),
      hints: [
        `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=${SUB("public-a")}. Read both directions: Egress true and false.`,
        "Network ACLs are stateless. The reply to your request leaves port 80 for a high port on your laptop (1024-65535), and outbound only allows ports 80 and 443.",
        `aws ec2 create-network-acl-entry --network-acl-id ${rid("acl", "public-nacl")} --egress --rule-number 120 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`
      ],
      lesson: "Security groups are stateful; network ACLs are not. Every reply must be allowed out explicitly, which for clients on the internet means the ephemeral ports 1024-65535.",
      tries: ["curl -m 5 http://blog.example.com", `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=${SUB("public-a")}`],
      blanks: { instance: "blog", sg: "blog-sg" }
    },
    {
      id: "nat", title: "Private instance cannot reach the internet", level: "05",
      story: "The worker in private-a must call the GitHub API, but every request times out. The VPC was built without a NAT gateway to save money.",
      goal: "Give private-a outbound internet access, without a public IP on the worker.",
      done: "The worker reaches the internet through a NAT gateway.",
      setup(a) {
        a.nats = [];
        a.eips = [];
        a.rt("private-rt").routes = a.rt("private-rt").routes.filter((r) => r.target === "local");
        for (const s of ["ssm", "ssmmessages", "ec2messages"]) a.endpoints.push({ id: rid("vpce", s), service: `com.amazonaws.${REGION}.${s}`, type: "Interface", rts: [] });
        a.addInstance({ name: "worker", type: "t3.small", subnet: "private-a", sgs: ["default"], ip: "10.0.11.40", app: "worker", role: "web-role" });
      },
      won: (a) => a.egress(a.ep(a.inst("worker")), EXTERNAL["api.github.com"], 443) && !pub(a, "worker") && !a.hasInternetRoute(SUB("private-a")),
      check: (a) => ({ label: "worker → api.github.com:443", text: a.egress(a.ep(a.inst("worker")), EXTERNAL["api.github.com"], 443) ? "connects" : "times out" }),
      hints: [
        `aws ssm start-session --target ${II("worker")}, then curl -m 5 https://api.github.com, then exit.`,
        "aws ec2 describe-route-tables --filters Name=tag:Name,Values=private-rt: only the local route. Private subnets reach out through a NAT gateway that sits in a public subnet.",
        `aws ec2 allocate-address; aws ec2 create-nat-gateway --subnet-id ${SUB("public-a")} --allocation-id <AllocationId>; then aws ec2 create-route --route-table-id ${rid("rtb", "private")} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id <NatGatewayId>`
      ],
      lesson: "A NAT gateway lives in a public subnet and gives private subnets outbound-only access. It is not free: about $33 a month per gateway plus $0.045 per GB it processes, so watch what flows through it.",
      tries: [`aws ssm start-session --target ${II("worker")}`, "aws ec2 describe-route-tables --filters Name=tag:Name,Values=private-rt"],
      blanks: { instance: "worker", subnet: "public-a", rtb: "private-rt" }
    },

    // Compute
    {
      id: "stopped", title: "Instance stopped", level: "07",
      story: "http://blog.example.com stopped answering at 02:10. Nobody remembers touching it.",
      goal: "Bring the blog back.",
      done: "The blog answers again.",
      setup(a) {
        const i = blogSetup(a, { state: "stopped", publicIp: null });
        const e = a.addEip("blog-eip", 10);
        e.assoc = i.id;
        a.events.push({ name: "StopInstances", source: "ec2.amazonaws.com", user: "contractor-tmp", key: keyId("AKIA", "contractor"), at: START - 7 * HOUR, res: [{ ResourceType: "AWS::EC2::Instance", ResourceName: i.id }], ip: "198.51.100.23" });
      },
      won: (a) => fromLaptop(a, "blog.example.com") === 200,
      check: (a) => ({ label: "curl http://blog.example.com", text: said(fromLaptop(a, "blog.example.com")) }),
      hints: [
        "aws ec2 describe-instances --filters Name=tag:Name,Values=blog --query 'Reservations[].Instances[].State.Name'",
        "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopInstances shows who stopped it, and when.",
        `aws ec2 start-instances --instance-ids ${II("blog")}`
      ],
      lesson: "Start with the state of the thing, then ask CloudTrail who changed it. The Elastic IP kept the address through the stop; without one the instance would come back with a new public IP and the DNS record would point at nothing.",
      tries: ["curl -m 5 http://blog.example.com", "aws ec2 describe-instances --filters Name=tag:Name,Values=blog --query 'Reservations[].Instances[].State.Name'"],
      blanks: { instance: "blog" }
    },
    {
      id: "statuscheck", title: "System status check failed", level: "07",
      story: "The blog times out. The instance is running, but the console shows 1/2 status checks passed.",
      goal: "Get the blog answering again.",
      done: "The blog moved to healthy hardware and answers.",
      setup(a) { const i = blogSetup(a); i.system = "impaired"; const e = a.addEip("blog-eip", 10); e.assoc = i.id; i.publicIp = null; },
      won: (a) => a.inst("blog").system === "ok" && fromLaptop(a, "blog.example.com") === 200,
      check: (a) => ({ label: "blog: system check / HTTP", text: `${a.inst("blog").system === "ok" ? "passed" : "impaired"} / ${said(fromLaptop(a, "blog.example.com"))}` }),
      hints: [
        `aws ec2 describe-instance-status --instance-ids ${II("blog")}. Which check failed: SystemStatus or InstanceStatus?`,
        "A failed system check is a problem with the host underneath. A reboot keeps the instance on the same host.",
        `Stop and start it, which moves an EBS-backed instance to new hardware: aws ec2 stop-instances --instance-ids ${II("blog")}, check it is stopped, then aws ec2 start-instances --instance-ids ${II("blog")}`
      ],
      lesson: "System status checks watch AWS's hardware and network; instance status checks watch your operating system. For a system failure, stop and start moves the instance to a healthy host; a CloudWatch alarm with the recover action can do it for you.",
      tries: [`aws ec2 describe-instance-status --instance-ids ${II("blog")}`, "curl -m 5 http://blog.example.com"],
      blanks: { instance: "blog" }
    },
    {
      id: "capacity", title: "InsufficientInstanceCapacity", level: "07",
      story: "The month-end batch job needs a c7i.8xlarge. The launch command in the runbook fails with InsufficientInstanceCapacity.",
      goal: "Launch a c7i.8xlarge for the batch job.",
      done: "The batch instance is running.",
      setup(a) { a.capacityOut = ["c7i.8xlarge@us-east-1a"]; },
      won: (a) => a.instances.some((i) => i.type === "c7i.8xlarge" && ["pending", "running"].includes(i.state)),
      check: (a) => ({ label: "c7i.8xlarge running", text: a.instances.some((i) => i.type === "c7i.8xlarge" && ["pending", "running"].includes(i.state)) ? "yes" : "no" }),
      hints: [
        "Run the launch (first Try below) and read the whole message.",
        "Capacity is per Availability Zone, and the error lists zones that have it. Which zone is private-a in? aws ec2 describe-subnets --query 'Subnets[].[Tags[0].Value,AvailabilityZone,SubnetId]' --output text",
        `Launch in private-b (us-east-1b): the same command with --subnet-id ${SUB("private-b")}`
      ],
      lesson: "InsufficientInstanceCapacity means AWS is short of that type in one zone right now, not that your account hit a limit. Try another zone or a similar type; Auto Scaling groups that span zones and types ride this out on their own.",
      tries: [`aws ec2 run-instances --image-id ${AMI} --instance-type c7i.8xlarge --subnet-id ${SUB("private-a")} --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=batch}]'`, "aws ec2 describe-subnets --query 'Subnets[].[Tags[0].Value,AvailabilityZone,SubnetId]' --output text"]
    },
    {
      id: "vcpu", title: "VcpuLimitExceeded", level: "07",
      story: "The ETL instance, an m5.2xlarge, will not launch: VcpuLimitExceeded. Last week's load test ran in this account.",
      goal: "Launch the m5.2xlarge named etl, without touching production.",
      done: "etl is running and production is untouched.",
      setup(a) {
        a.quotas["L-1216C47A"] = 32;
        for (const n of [1, 2, 3]) a.addInstance({ name: `loadtest-${n}`, type: "m5.2xlarge", subnet: "private-b", sgs: ["default"], tags: { purpose: "loadtest" }, launched: START - 9 * DAY });
      },
      won: (a) => a.instances.some((i) => i.name === "etl" && i.type === "m5.2xlarge" && ["pending", "running"].includes(i.state)) && ["web-1", "web-2"].every((n) => a.inst(n).state === "running"),
      check: (a) => ({ label: "vCPUs in use / limit", text: `${vcpusUsed(a)} / ${a.quotas["L-1216C47A"]}` }),
      hints: [
        "aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A: the limit counts vCPUs of running instances in the standard families.",
        "aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`]|[0].Value]' --output text. What is left from the load test?",
        "aws ec2 terminate-instances --instance-ids <the three loadtest ids>, then launch again (first Try below)."
      ],
      lesson: "On-Demand limits are counted in vCPUs per family group, for running instances only. Forgotten instances eat quota and money; a quota increase is the other way out, but it takes time to approve.",
      tries: [`aws ec2 run-instances --image-id ${AMI} --instance-type m5.2xlarge --subnet-id ${SUB("private-a")} --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=etl}]'`, "aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A"]
    },
    {
      id: "lambdatimeout", title: "Lambda task timed out", level: "13",
      story: "The nightly orders report has failed every night this week. The function calls a slow partner API that takes about seven seconds.",
      goal: "Make orders-report finish successfully.",
      done: "orders-report finishes within its timeout.",
      setup(a) {
        a.addRole("report-role", trustService("lambda.amazonaws.com"), [awsPolicyArn("AWSLambdaVPCAccessExecutionRole")]);
        a.addLambda({ name: "orders-report", role: "report-role", timeout: 3, memory: 128, workMs: 7200 });
        invoke(a, a.lambdas[a.lambdas.length - 1]);
      },
      won: (a) => a.fn("orders-report").timeout * 1000 > a.fn("orders-report").workMs,
      check: (a) => ({ label: "orders-report timeout / run time", text: `${a.fn("orders-report").timeout} s / ${(a.fn("orders-report").workMs / 1000).toFixed(1)} s` }),
      hints: [
        "aws lambda invoke --function-name orders-report out.json, then cat out.json.",
        "aws logs tail /aws/lambda/orders-report shows Task timed out after 3.00 seconds. aws lambda get-function-configuration --function-name orders-report --query '[Timeout,MemorySize]'",
        "aws lambda update-function-configuration --function-name orders-report --timeout 15"
      ],
      lesson: "Lambda's default timeout is 3 seconds. Set it a little above the slowest real run; more memory buys more CPU, which does not make a slow network call any faster.",
      tries: ["aws lambda invoke --function-name orders-report out.json", "aws logs tail /aws/lambda/orders-report"]
    },
    {
      id: "throttled", title: "Lambda throttled: TooManyRequestsException", level: "13",
      story: "Every call to the orders-api function fails with TooManyRequestsException: Rate Exceeded, even at night with almost no traffic.",
      goal: "Let orders-api run again, with a sensible concurrency limit.",
      done: "orders-api runs again.",
      setup(a) {
        a.addRole("orders-api-role", trustService("lambda.amazonaws.com"), [awsPolicyArn("AWSLambdaVPCAccessExecutionRole")]);
        a.addLambda({ name: "orders-api", role: "orders-api-role", timeout: 10, memory: 256 }).reserved = 0;
        a.events.push({ name: "PutFunctionConcurrency20171031", source: "lambda.amazonaws.com", user: "oncall", at: START - 30 * HOUR, res: [] });
      },
      won: (a) => a.fn("orders-api").reserved !== 0,
      check: (a) => ({ label: "orders-api reserved concurrency", text: a.fn("orders-api").reserved === undefined ? "none (shares the account pool)" : String(a.fn("orders-api").reserved) }),
      hints: [
        "aws lambda invoke --function-name orders-api out.json",
        "aws lambda get-function-concurrency --function-name orders-api. A reserved concurrency of 0 is how you switch a function off in an emergency; someone did, and forgot.",
        "aws lambda put-function-concurrency --function-name orders-api --reserved-concurrent-executions 50 (or delete-function-concurrency to share the account pool)."
      ],
      lesson: "TooManyRequestsException from Lambda is throttling: the function hit its reserved concurrency or the account's concurrency limit. Reserved concurrency both guarantees and caps a function; 0 stops it completely.",
      tries: ["aws lambda invoke --function-name orders-api out.json", "aws lambda get-function-concurrency --function-name orders-api"]
    },
    {
      id: "asgmax", title: "Auto Scaling stuck at its maximum", level: "10",
      story: "Lunchtime orders are slow and the web servers run at 95% CPU. The scale-out alarm has been in ALARM for twenty minutes, yet there are still two servers.",
      goal: "Let web-asg scale out for lunch.",
      done: "web-asg scaled out by itself.",
      setup(a) {
        const g = a.asgs[0];
        Object.assign(g, { max: 2 });
        a.load["web-asg"] = 190;
        g.policies.push({ name: "scale-out", arn: policyArn(g, "scale-out"), type: "SimpleScaling", adjustment: 1 });
        putAlarm(a, { AlarmName: "cpu-high", Namespace: "AWS/EC2", MetricName: "CPUUtilization", Statistic: "Average", Period: 300, EvaluationPeriods: 2, Threshold: 70, ComparisonOperator: "GreaterThanThreshold", Dimensions: [{ Name: "AutoScalingGroupName", Value: "web-asg" }], AlarmActions: [policyArn(g, "scale-out")] });
        a.alarms[0].updated = START - 20 * 60e3;
      },
      won: (a) => a.inService(a.asgs[0]) >= 3,
      check: (a) => ({ label: "web-asg in service / max", text: `${a.inService(a.asgs[0])} / ${a.asgs[0].max}` }),
      hints: [
        "aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg: nothing new today.",
        "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg --query 'AutoScalingGroups[].[MinSize,MaxSize,DesiredCapacity]'. The alarm fires, but the group is already at MaxSize.",
        "aws autoscaling update-auto-scaling-group --auto-scaling-group-name web-asg --max-size 6"
      ],
      lesson: "Scaling policies move the desired capacity only between MinSize and MaxSize. A maximum equal to today's count quietly turns every scale-out into nothing; set it to what you are willing to pay for at peak.",
      tries: ["aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg", "aws cloudwatch describe-alarms --state-value ALARM"]
    },

    // Storage
    {
      id: "publicbucket", title: "Bucket open to the internet", level: "09",
      story: "A customer opened someone else's invoice by guessing its URL: https://quest-kitchen-invoices.s3.amazonaws.com/2026/10/inv-1042.pdf. The invoice app must keep working.",
      goal: "Stop anonymous access to quest-kitchen-invoices; the invoice-app role must still read invoices.",
      done: "The bucket is private and the invoice app still reads it.",
      setup(a) {
        a.addBucket("quest-kitchen-invoices", { pab: null, policy: doc({ Sid: "PublicRead", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::quest-kitchen-invoices/*" }),
          objects: { "2026/10/inv-1041.pdf": { size: 84211, body: "%PDF-1.7 invoice 1041" }, "2026/10/inv-1042.pdf": { size: 79310, body: "%PDF-1.7 invoice 1042" } } });
        a.addRole("invoice-app", trustService("ec2.amazonaws.com"), [], { "read-invoices": doc({ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::quest-kitchen-invoices", "arn:aws:s3:::quest-kitchen-invoices/*"] }) });
      },
      won: (a) => s3Http(a, "quest-kitchen-invoices", "/2026/10/inv-1042.pdf").code === 403 && s3can(a, a.role("invoice-app"), "s3:GetObject", "quest-kitchen-invoices", "2026/10/inv-1042.pdf"),
      check: (a) => ({ label: "anonymous GET inv-1042.pdf", text: s3Http(a, "quest-kitchen-invoices", "/2026/10/inv-1042.pdf").code === 200 ? "200, public" : `403${s3can(a, a.role("invoice-app"), "s3:GetObject", "quest-kitchen-invoices", "2026/10/inv-1042.pdf") ? "" : ", and the app is locked out"}` }),
      hints: [
        "curl https://quest-kitchen-invoices.s3.amazonaws.com/2026/10/inv-1042.pdf, then aws s3api get-bucket-policy-status --bucket quest-kitchen-invoices",
        "aws s3api get-bucket-policy --bucket quest-kitchen-invoices: Principal \"*\" means anyone. aws s3api get-public-access-block --bucket quest-kitchen-invoices: there is no block.",
        "aws s3api put-public-access-block --bucket quest-kitchen-invoices --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true, then aws s3api delete-bucket-policy --bucket quest-kitchen-invoices"
      ],
      lesson: "Block Public Access overrides public policies and ACLs, so turn it on for every bucket (and the account) unless a bucket is meant to be a public website. The app keeps working because its access comes from its IAM role, not from the public statement.",
      tries: ["curl https://quest-kitchen-invoices.s3.amazonaws.com/2026/10/inv-1042.pdf", "aws s3api get-bucket-policy-status --bucket quest-kitchen-invoices"],
      blanks: { bucket: "quest-kitchen-invoices" }
    },
    {
      id: "ownership", title: "403 on objects another account uploaded", level: "09",
      story: "A partner uploads order files into quest-kitchen-imports every night. The import job, which runs as the import-job role, gets 403 on every new file, though its policy allows s3:GetObject.",
      goal: "Let import-job read the partner's files, without making the bucket public.",
      done: "import-job reads the partner's files.",
      setup(a) {
        a.addBucket("quest-kitchen-imports", { ownership: "ObjectWriter", policy: doc({ Sid: "PartnerUploads", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${PARTNER}:root` }, Action: "s3:PutObject", Resource: "arn:aws:s3:::quest-kitchen-imports/orders/*" }),
          objects: { "orders/2026-10-29.csv": { owner: PARTNER, size: 18220, body: "order_id,total\n1001,42.50\n" }, "orders/2026-10-30.csv": { owner: PARTNER, size: 19004, body: "order_id,total\n1002,18.00\n" } } });
        a.addRole("import-job", trustService("ec2.amazonaws.com"), [], { "read-imports": doc({ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::quest-kitchen-imports", "arn:aws:s3:::quest-kitchen-imports/*"] }) });
        a.profiles.import = { sso: true, role: "import-job", session: "you" };
      },
      won: (a) => s3can(a, a.role("import-job"), "s3:GetObject", "quest-kitchen-imports", "orders/2026-10-30.csv") && !a.isPublic(a.buckets["quest-kitchen-imports"]),
      check: (a) => ({ label: "import-job reads orders/2026-10-30.csv", text: s3can(a, a.role("import-job"), "s3:GetObject", "quest-kitchen-imports", "orders/2026-10-30.csv") ? "allowed" : "403 Forbidden" }),
      hints: [
        "aws s3 cp s3://quest-kitchen-imports/orders/2026-10-30.csv . --profile import",
        "aws s3api list-object-versions --bucket quest-kitchen-imports --prefix orders/ --query 'Versions[].[Key,Owner.ID]' --output text, and compare with your own ID: aws s3api list-buckets --query Owner.ID. Then aws s3api get-bucket-ownership-controls --bucket quest-kitchen-imports",
        "aws s3api put-bucket-ownership-controls --bucket quest-kitchen-imports --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'"
      ],
      lesson: "With ObjectWriter ownership an object belongs to the account that uploaded it, and your IAM policies cannot grant access to someone else's object. BucketOwnerEnforced turns ACLs off and makes you own every object; it is the default for new buckets.",
      tries: ["aws s3 cp s3://quest-kitchen-imports/orders/2026-10-30.csv . --profile import", "aws s3api get-bucket-ownership-controls --bucket quest-kitchen-imports"],
      blanks: { bucket: "quest-kitchen-imports", role: "import-job", profile: "import" }
    },
    {
      id: "undelete", title: "Recover a deleted object", level: "09",
      story: "A cleanup script deleted prod/app.json from quest-kitchen-config last night. The web servers read it at start-up, so the next deploy will fail.",
      goal: "Bring back the latest version of prod/app.json.",
      done: "prod/app.json is back, at its latest version.",
      setup(a) {
        const b = a.addBucket("quest-kitchen-config", { versioning: "Enabled" });
        b.objects["prod/app.json"] = [{ v: hexOf("marker", 32), marker: true, modified: START - 9 * HOUR, owner: ACCOUNT },
          { v: hexOf("v2", 32), size: 61, modified: START - 3 * DAY, owner: ACCOUNT, body: '{"featureFlags":{"newCheckout":true},"db":"orders-db"}' },
          { v: hexOf("v1", 32), size: 42, modified: START - 40 * DAY, owner: ACCOUNT, body: '{"featureFlags":{},"db":"orders-db-old"}' }];
        b.objects["prod/nginx.conf"] = [{ v: hexOf("ngx", 32), size: 912, modified: START - 20 * DAY, owner: ACCOUNT, body: "server { listen 8080; }" }];
      },
      won: (a) => { const o = latest(a.buckets["quest-kitchen-config"], "prod/app.json"); return Boolean(o && !o.marker && o.body.includes("newCheckout")); },
      check: (a) => { const o = latest(a.buckets["quest-kitchen-config"], "prod/app.json"); return { label: "s3://quest-kitchen-config/prod/app.json", text: !o || o.marker ? "deleted" : o.body.includes("newCheckout") ? "latest version" : "an older version" }; },
      hints: [
        "aws s3 ls s3://quest-kitchen-config/prod/ shows no app.json. aws s3api get-bucket-versioning --bucket quest-kitchen-config",
        "aws s3api list-object-versions --bucket quest-kitchen-config --prefix prod/app.json: the newest entry is a delete marker.",
        "Delete the delete marker: aws s3api delete-object --bucket quest-kitchen-config --key prod/app.json --version-id <the marker's VersionId>"
      ],
      lesson: "In a versioned bucket a delete only adds a delete marker; the data is still there. Removing the marker, or copying the previous version on top, restores the object. Without versioning it would be gone.",
      tries: ["aws s3 ls s3://quest-kitchen-config/prod/", "aws s3api list-object-versions --bucket quest-kitchen-config --prefix prod/app.json"],
      blanks: { bucket: "quest-kitchen-config" }
    },
    {
      id: "nosuchbucket", title: "NoSuchBucket from a Lambda function", level: "09",
      story: "Since yesterday's release, image thumbnails are missing. The thumbnailer function fails on every upload.",
      goal: "Make thumbnailer write to the uploads bucket again.",
      done: "thumbnailer writes to quest-kitchen-uploads.",
      setup(a) {
        a.addBucket("quest-kitchen-uploads", { gb: 140 });
        a.addRole("thumb-role", trustService("lambda.amazonaws.com"), [], { "write-thumbs": doc({ Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: "arn:aws:s3:::quest-kitchen-uploads/*" }) });
        a.addLambda({ name: "thumbnailer", role: "thumb-role", env: { BUCKET: "quest-kitchen-uplaods", SIZE: "320" }, needs: { bucket: "BUCKET" } });
        invoke(a, a.lambdas[a.lambdas.length - 1]);
      },
      won: (a) => a.fn("thumbnailer").env.BUCKET === "quest-kitchen-uploads",
      check: (a) => ({ label: "thumbnailer BUCKET", text: a.fn("thumbnailer").env.BUCKET || "unset" }),
      hints: [
        "aws lambda invoke --function-name thumbnailer out.json, then cat out.json",
        "aws lambda get-function-configuration --function-name thumbnailer --query Environment. Compare the name with aws s3 ls.",
        "aws lambda update-function-configuration --function-name thumbnailer --environment 'Variables={BUCKET=quest-kitchen-uploads,SIZE=320}'"
      ],
      lesson: "NoSuchBucket means no bucket has that name, not that you lack access. Check the exact name your code uses; creating a bucket with the misspelled name would silence the error and send the data to the wrong place.",
      tries: ["aws lambda invoke --function-name thumbnailer out.json", "aws lambda get-function-configuration --function-name thumbnailer --query Environment"],
      blanks: { bucket: "quest-kitchen-uploads" }
    },
    {
      id: "bucketexists", title: "BucketAlreadyExists", level: "09",
      story: "You need a bucket for menu photos in eu-west-1. aws s3 mb s3://menu-photos --region eu-west-1 fails.",
      goal: "Create a bucket for the menu photos in eu-west-1.",
      done: "The menu photos bucket exists in eu-west-1.",
      setup() { TAKEN.add("menu-photos"); },
      won: (a) => Object.values(a.buckets).some((b) => b.region === "eu-west-1" && b.created >= START),
      check: (a) => ({ label: "new bucket in eu-west-1", text: (Object.values(a.buckets).find((b) => b.region === "eu-west-1" && b.created >= START) || { name: "none yet" }).name }),
      hints: [
        "Bucket names are global, across every AWS account in the partition. Someone else already owns menu-photos.",
        "Make the name yours: add the company and the account, like quest-kitchen-menu-photos-111122223333.",
        "aws s3 mb s3://quest-kitchen-menu-photos-111122223333 --region eu-west-1 (with s3api create-bucket outside us-east-1, also pass --create-bucket-configuration LocationConstraint=eu-west-1)."
      ],
      lesson: "S3 bucket names share one global namespace, so short generic names are long gone. Use a naming pattern with your organization, purpose and account or Region, and create buckets with infrastructure as code so the name is decided once.",
      tries: ["aws s3 mb s3://menu-photos --region eu-west-1", "aws s3 ls"]
    },

    // Databases
    {
      id: "lambdards", title: "Lambda cannot reach RDS", level: "11",
      story: "The new orders-api function runs in the VPC, but every call fails after five seconds with connect ETIMEDOUT to the database. The web servers reach the same database fine.",
      goal: "Let orders-api connect to orders-db, without opening the database to anything else.",
      done: "orders-api connects to orders-db.",
      setup(a) {
        a.addSg("lambda-sg", "orders-api function", []);
        a.addRole("orders-api-role", trustService("lambda.amazonaws.com"), [awsPolicyArn("AWSLambdaVPCAccessExecutionRole")]);
        a.addLambda({ name: "orders-api", role: "orders-api-role", timeout: 30, memory: 256, vpc: { subnets: ["private-a", "private-b"], sgs: ["lambda-sg"], ip: "10.0.12.77" }, needs: { db: "orders-db" } });
        invoke(a, a.lambdas[a.lambdas.length - 1]);
      },
      won: (a) => a.connect(a.lambdaEp(a.fn("orders-api")), a.dbEp(a.db("orders-db")), 5432) === "ok" && !broadCidr(a, "db-sg") && !a.db("orders-db").public,
      check: (a) => ({ label: "orders-api → orders-db:5432", text: a.connect(a.lambdaEp(a.fn("orders-api")), a.dbEp(a.db("orders-db")), 5432) === "ok" ? (broadCidr(a, "db-sg") ? "connects, but so can a whole range" : "connects") : "times out" }),
      hints: [
        "aws lambda invoke --function-name orders-api out.json; cat out.json. ETIMEDOUT means packets are dropped, not refused.",
        "aws lambda get-function-configuration --function-name orders-api --query VpcConfig, then aws ec2 describe-security-groups --group-names db-sg. Who may reach port 5432?",
        `aws ec2 authorize-security-group-ingress --group-id ${SGI("db-sg")} --protocol tcp --port 5432 --source-group ${SGI("lambda-sg")}`
      ],
      lesson: "Reference security groups, not addresses. db-sg allowing 5432 from lambda-sg keeps working as Lambda's network interfaces come and go, and lets nothing else in.",
      tries: ["aws lambda invoke --function-name orders-api out.json", "aws ec2 describe-security-groups --group-names db-sg"],
      blanks: { sg: "db-sg" }
    },
    {
      id: "rdspublic", title: "Database open to the internet", level: "11",
      story: "An external scan reports that orders-db answers on port 5432 from the internet. It was created in the public subnets, with public access on. The web servers must keep their access.",
      goal: "Make orders-db private again; the web servers must still connect.",
      done: "orders-db is private and the web servers still connect.",
      setup(a) {
        const d = a.db("orders-db");
        Object.assign(d, { public: true, subnet: SUB("public-a"), ip: "10.0.1.25" });
        a.sg("db-sg").in.push({ proto: "tcp", from: 5432, to: 5432, cidr: "0.0.0.0/0", desc: "temporary" });
      },
      won: (a) => !a.db("orders-db").public && !worldOpen(a, "db-sg") && a.connect(a.inst("web-1"), a.dbEp(a.db("orders-db")), 5432) === "ok",
      check: (a) => ({ label: "orders-db from the internet / from web-1", text: `${a.db("orders-db").public && a.connect({ kind: "internet", ip: LAPTOP }, a.dbEp(a.db("orders-db")), 5432) === "ok" ? "reachable" : "blocked"} / ${a.connect(a.inst("web-1"), a.dbEp(a.db("orders-db")), 5432) === "ok" ? "ok" : "blocked"}` }),
      hints: [
        `From your laptop: nc -vz ${"orders-db.c3kq8vx0zw1m.us-east-1.rds.amazonaws.com"} 5432. Then aws rds describe-db-instances --query 'DBInstances[].[PubliclyAccessible,Endpoint.Address]'`,
        "Two things expose it: PubliclyAccessible gives the endpoint a public address, and db-sg allows 5432 from 0.0.0.0/0.",
        `aws ec2 revoke-security-group-ingress --group-id ${SGI("db-sg")} --protocol tcp --port 5432 --cidr 0.0.0.0/0, and aws rds modify-db-instance --db-instance-identifier orders-db --no-publicly-accessible --apply-immediately`
      ],
      lesson: "Keep databases in private subnets with public access off, and let only the application's security group in. Either control alone is one mistake away from exposure. Without --apply-immediately, RDS waits for the maintenance window.",
      tries: ["nc -vz orders-db.c3kq8vx0zw1m.us-east-1.rds.amazonaws.com 5432", "aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,PubliclyAccessible]' --output text"],
      blanks: { sg: "db-sg" }
    },
    {
      id: "rdsstorage", title: "Database storage full", level: "11",
      story: "Orders stopped saving at 11:40. The application logs say: could not extend file: No space left on device.",
      goal: "Get orders-db accepting writes again, with room to grow.",
      done: "orders-db has free space and is available.",
      setup(a) {
        Object.assign(a.db("orders-db"), { status: "storage-full", freeGb: 0 });
        a.dbEvents = [{ db: "orders-db", at: START - 3 * HOUR, cat: "low storage", msg: "The free storage capacity for DB Instance orders-db is low at 2% of the provisioned storage [Provisioned Storage: 100.00 GB, Free Storage: 1.98 GB]. You may want to increase the provisioned storage to address this issue." },
          { db: "orders-db", at: START - 40 * 60e3, cat: "low storage", msg: "DB instance orders-db has run out of storage space. The DB instance is in storage-full state." }];
      },
      won: (a) => a.db("orders-db").status === "available" && a.db("orders-db").freeGb > 10,
      check: (a) => ({ label: "orders-db status / free", text: `${a.db("orders-db").status} / ${a.db("orders-db").freeGb} GB` }),
      hints: [
        "aws rds describe-db-instances --db-instance-identifier orders-db --query 'DBInstances[].[DBInstanceStatus,AllocatedStorage]', then aws rds describe-events --source-type db-instance",
        "A reboot frees nothing. Storage can only grow, by at least 10% at a time, and without --apply-immediately it waits for the maintenance window.",
        "aws rds modify-db-instance --db-instance-identifier orders-db --allocated-storage 200 --max-allocated-storage 500 --apply-immediately"
      ],
      lesson: "A full RDS volume stops writes. Grow it now with --apply-immediately, set MaxAllocatedStorage so storage autoscaling grows it next time, and alarm on FreeStorageSpace well before zero.",
      tries: ["aws rds describe-db-instances --db-instance-identifier orders-db --query 'DBInstances[].[DBInstanceStatus,AllocatedStorage]'", "aws rds describe-events --source-type db-instance"]
    },
    {
      id: "rdsbackup", title: "No automated backups", level: "11",
      story: "An audit found that orders-db has no automated backups: if someone drops a table, there is no point-in-time recovery.",
      goal: "Turn on automated backups for orders-db with at least 7 days of retention.",
      done: "Automated backups are on.",
      setup(a) { a.db("orders-db").backups = 0; },
      won: (a) => a.db("orders-db").backups >= 7,
      check: (a) => ({ label: "orders-db backup retention", text: `${a.db("orders-db").backups} days${a.db("orders-db").pending && a.db("orders-db").pending.BackupRetentionPeriod ? " (change pending)" : ""}` }),
      hints: [
        "aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,BackupRetentionPeriod]' --output text",
        "A manual snapshot is a one-off copy. Point-in-time recovery needs automated backups, which a retention period above 0 turns on.",
        "aws rds modify-db-instance --db-instance-identifier orders-db --backup-retention-period 7 --apply-immediately"
      ],
      lesson: "Automated backups plus transaction logs give point-in-time recovery to any second in the retention window. Keep manual snapshots for before risky changes, and test a restore now and then.",
      tries: ["aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,BackupRetentionPeriod]' --output text"]
    },
    {
      id: "rdsupgrade", title: "Database on an end-of-support version", level: "11",
      story: "The bill has a new line: RDS Extended Support for orders-db, which still runs PostgreSQL 12, past the end of its standard support.",
      goal: "Upgrade orders-db to PostgreSQL 16, after taking a snapshot.",
      done: "orders-db runs PostgreSQL 16 and a pre-upgrade snapshot exists.",
      setup(a) { Object.assign(a.db("orders-db"), { version: "12.22", extended: true }); },
      won: (a) => a.db("orders-db").version.startsWith("16.") && a.db("orders-db").snapshots.length > 0,
      check: (a) => ({ label: "orders-db engine / snapshot", text: `PostgreSQL ${a.db("orders-db").version} / ${a.db("orders-db").snapshots.length ? "taken" : "none"}` }),
      hints: [
        "aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,EngineVersion]' --output text",
        "Take a manual snapshot first: aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-before-pg16. A major upgrade needs its own flag.",
        "aws rds modify-db-instance --db-instance-identifier orders-db --engine-version 16.4 --allow-major-version-upgrade --apply-immediately"
      ],
      lesson: "Major engine versions reach end of standard support; after that RDS keeps them running for a per-vCPU Extended Support charge. Snapshot, test the upgrade on a restored copy, then upgrade in a quiet window.",
      tries: ["aws rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,EngineVersion]' --output text"]
    },

    // Load balancing and DNS
    {
      id: "alb503", title: "ALB returns 503", level: "10",
      story: "For the blue/green release, the load balancer's listener was switched to the new target group web-tg-v2. Since then http://shop.example.com returns 503 Service Temporarily Unavailable.",
      goal: "Make http://shop.example.com answer through web-tg-v2.",
      done: "The shop answers through web-tg-v2.",
      setup(a) { a.addTg("web-tg-v2", 8080, "/health", []); a.albs[0].listeners[0].tg = a.tg("web-tg-v2").arn; },
      won: (a) => a.albs[0].listeners[0].tg === a.tg("web-tg-v2").arn && fromLaptop(a, "shop.example.com") === 200,
      check: (a) => ({ label: "curl http://shop.example.com", text: said(fromLaptop(a, "shop.example.com")) }),
      hints: [
        "curl -i http://shop.example.com. A 503 from awselb/2.0 means the load balancer had nowhere to send the request.",
        "aws elbv2 describe-target-health --target-group-arn <web-tg-v2 ARN> shows no targets. The Auto Scaling group still registers its servers in web-tg.",
        "aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name web-asg --target-group-arns <web-tg-v2 ARN>"
      ],
      lesson: "An ALB answers 503 when the target group has no targets to try. With Auto Scaling, attach the group to the target group so new instances register themselves, instead of registering instances by hand.",
      tries: ["curl -i http://shop.example.com", "aws elbv2 describe-target-groups --query 'TargetGroups[].[TargetGroupName,TargetGroupArn]' --output text"],
      blanks: { tg: "web-tg-v2" }
    },
    {
      id: "alb502", title: "ALB returns 502", level: "10",
      story: "The shop returns 502 Bad Gateway since the web servers were re-registered with the load balancer. The app is running on both servers.",
      goal: "Make the shop answer 200 with every target healthy.",
      done: "Every target is healthy and the shop answers.",
      setup(a) { a.tg("web-tg").targets.forEach((t) => { t.port = 80; }); a.sg("web-sg").in.push({ proto: "tcp", from: 80, to: 80, sg: SGI("alb-sg"), desc: "from the load balancer" }); },
      won: (a) => fromLaptop(a, "shop.example.com") === 200 && allTargetsHealthy(a, a.tg("web-tg")),
      check: (a) => ({ label: "curl http://shop.example.com", text: said(fromLaptop(a, "shop.example.com")) + (allTargetsHealthy(a, a.tg("web-tg")) ? "" : ", targets unhealthy") }),
      hints: [
        "aws elbv2 describe-target-health --target-group-arn <web-tg ARN>: unhealthy, Health checks failed. A 502 means the target refused or reset the connection.",
        "Which port are the targets registered on, and which port does the app listen on? (web-sg's rules and the target group's port tell you: the app listens on 8080.)",
        "aws elbv2 register-targets --target-group-arn <ARN> --targets Id=<web-1 id>,Port=8080 Id=<web-2 id>,Port=8080, then aws elbv2 deregister-targets --target-group-arn <ARN> --targets Id=<web-1 id>,Port=80 Id=<web-2 id>,Port=80"
      ],
      lesson: "502 from an ALB means it reached the target but got no valid HTTP answer: nothing listening on that port, a crash, or a reset. 504 means it never connected in time. Register targets on the port the app really uses.",
      tries: ["curl -i http://shop.example.com", "aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[].TargetGroupArn' --output text"],
      blanks: { tg: "web-tg" }
    },
    {
      id: "healthpath", title: "Targets unhealthy: health check path", level: "10",
      story: "The shop works, but the UnHealthyHostCount alarm paged all night: every target in web-tg is unhealthy. Traffic still flows only because an ALB fails open when no target is healthy.",
      goal: "Make the targets healthy with a health check that still means something.",
      done: "Every target passes a real health check.",
      setup(a) {
        const tg = a.tg("web-tg");
        tg.path = "/status";
        putAlarm(a, { AlarmName: "web-unhealthy-hosts", Namespace: "AWS/ApplicationELB", MetricName: "UnHealthyHostCount", Statistic: "Maximum", Period: 60, EvaluationPeriods: 3, Threshold: 0, ComparisonOperator: "GreaterThanThreshold",
          Dimensions: [{ Name: "TargetGroup", Value: tg.arn.split(":").pop() }, { Name: "LoadBalancer", Value: a.albs[0].arn.split("loadbalancer/")[1] }], AlarmActions: [a.topics[0].arn] });
      },
      won: (a) => allTargetsHealthy(a, a.tg("web-tg")) && strictMatcher(a.tg("web-tg").matcher),
      check: (a) => ({ label: "web-tg targets healthy", text: `${a.tg("web-tg").targets.filter((t) => a.health(a.tg("web-tg"), t).State === "healthy").length} of ${a.tg("web-tg").targets.length}${strictMatcher(a.tg("web-tg").matcher) ? "" : " (matcher accepts errors)"}` }),
      hints: [
        "aws elbv2 describe-target-health --target-group-arn <web-tg ARN>: Health checks failed with these codes: [404].",
        "aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[].[HealthCheckPath,Matcher.HttpCode]'. The app serves its health check at /health.",
        "aws elbv2 modify-target-group --target-group-arn <web-tg ARN> --health-check-path /health"
      ],
      lesson: "A health check should ask the app a question it answers only when it can serve. Widening the matcher to 200-499 makes a 404 count as healthy and hides real failures.",
      tries: ["aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[].[TargetGroupArn,HealthCheckPath]' --output text", "aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].AlarmName'"],
      blanks: { tg: "web-tg" }
    },
    {
      id: "alb504", title: "ALB returns 504", level: "10",
      story: "The load balancer was replaced last night. Since then the shop answers 504 Gateway Time-out after a long wait.",
      goal: "Let the load balancer reach the web servers, without opening them to anyone else.",
      done: "The load balancer reaches the web servers.",
      setup(a) { a.sg("web-sg").in = [{ proto: "tcp", from: 8080, to: 8080, sg: SGI("old-alb-sg"), desc: "from the load balancer" }]; },
      won: (a) => fromLaptop(a, "shop.example.com") === 200 && !broadCidr(a, "web-sg"),
      check: (a) => ({ label: "curl http://shop.example.com", text: said(fromLaptop(a, "shop.example.com")) + (broadCidr(a, "web-sg") ? ", and web-sg is wide open" : "") }),
      hints: [
        "aws elbv2 describe-target-health --target-group-arn <web-tg ARN>: Request timed out. Timeouts between an ALB and its targets are usually security groups.",
        "aws ec2 describe-security-groups --group-names web-sg: 8080 is allowed from a group that no longer exists. Which group does the new ALB use? aws elbv2 describe-load-balancers --query 'LoadBalancers[].SecurityGroups'",
        `aws ec2 authorize-security-group-ingress --group-id ${SGI("web-sg")} --protocol tcp --port 8080 --source-group ${SGI("alb-sg")}`
      ],
      lesson: "504 means the ALB could not get an answer from the target in time, usually because a security group or NACL drops the traffic. Allow the target port from the ALB's security group, not from the whole internet.",
      tries: ["curl -i http://shop.example.com", "aws ec2 describe-security-groups --group-names web-sg"],
      blanks: { tg: "web-tg", sg: "web-sg" }
    },
    {
      id: "r53record", title: "DNS points at an old server", level: "12",
      story: "The shop moved behind the load balancer this morning. For customers, http://shop.example.com still times out.",
      goal: "Point shop.example.com at the load balancer.",
      done: "shop.example.com resolves to the load balancer.",
      setup(a) {
        a.zones[0].records = [{ Name: "shop.example.com.", Type: "A", TTL: 300, ResourceRecords: [{ Value: PUBLIC_IP(77) }] }];
        a.files["change.json"] = pretty({ Comment: "Point shop at the load balancer", Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: "shop.example.com", Type: "A", TTL: 300, ResourceRecords: [{ Value: PUBLIC_IP(77) }] } }] });
      },
      won: (a) => Boolean((a.resolve("shop.example.com") || {}).alb) && fromLaptop(a, "shop.example.com") === 200,
      check: (a) => { const r = a.resolve("shop.example.com") || {}; return { label: "shop.example.com", text: r.alb ? "the load balancer" : r.ip || "nothing" }; },
      hints: [
        "dig +short shop.example.com, then aws elbv2 describe-load-balancers --query 'LoadBalancers[].[DNSName,CanonicalHostedZoneId]' --output text",
        "aws route53 list-resource-record-sets --hosted-zone-id <zone id>: the A record still holds the old server's IP. An ALB's IPs change, so use an alias to its DNS name.",
        "In change.json replace TTL and ResourceRecords with \"AliasTarget\": {\"HostedZoneId\": \"Z35SXDOTRQ7X7K\", \"DNSName\": \"<ALB DNS name>\", \"EvaluateTargetHealth\": true}, then aws route53 change-resource-record-sets --hosted-zone-id <zone id> --change-batch file://change.json"
      ],
      lesson: "Point records at a load balancer with an alias (or a CNAME below the apex), never at its IP addresses, which change. Alias records also work at the zone apex and cost nothing to query.",
      tries: ["dig +short shop.example.com", "aws route53 list-hosted-zones"],
      edit: ["change.json"]
    },
    {
      id: "r53ns", title: "Domain does not resolve: name servers", level: "12",
      story: "During a cleanup someone deleted the example.com hosted zone and recreated it with the same records. Everything looks right in Route 53, yet the whole domain fails to resolve.",
      goal: "Make example.com resolve again.",
      done: "The registrar points at the new zone's name servers.",
      setup(a) { a.domains["example.com"].ns = ["ns-1203.awsdns-22.org", "ns-41.awsdns-05.com", "ns-1781.awsdns-30.co.uk", "ns-700.awsdns-23.net"]; },
      won: (a) => a.domains["example.com"].ns.slice().sort().join() === a.zones[0].ns.slice().sort().join(),
      check: (a) => ({ label: "dig shop.example.com", text: (a.resolve("shop.example.com") || {}).servfail ? "SERVFAIL" : "NOERROR" }),
      hints: [
        "dig shop.example.com: status SERVFAIL. aws route53 list-resource-record-sets shows the records are all there.",
        "Compare the name servers the registrar hands out (aws route53domains get-domain-detail --domain-name example.com --query Nameservers) with the new zone's (aws route53 get-hosted-zone --id <zone id> --query DelegationSet.NameServers).",
        "aws route53domains update-domain-nameservers --domain-name example.com --nameservers Name=<ns 1> Name=<ns 2> Name=<ns 3> Name=<ns 4>"
      ],
      lesson: "Every new hosted zone gets a new set of four name servers. Until the domain's registration points at them, resolvers ask the old, deleted zone and fail. Protect production zones from deletion.",
      tries: ["dig shop.example.com", "aws route53domains get-domain-detail --domain-name example.com --query Nameservers"]
    },

    // Observability
    {
      id: "asgalarm", title: "Scaling alarm on the wrong metric", level: "14",
      story: "Lunch traffic pushes the web servers to 92% CPU and nothing scales. The cpu-high alarm, which drives the scale-out policy, says INSUFFICIENT_DATA.",
      goal: "Make cpu-high watch the right group so web-asg scales out by itself.",
      done: "cpu-high scaled web-asg out.",
      setup(a) {
        const g = a.asgs[0];
        Object.assign(g, { max: 6 });
        a.load["web-asg"] = 184;
        g.policies.push({ name: "scale-out", arn: policyArn(g, "scale-out"), type: "SimpleScaling", adjustment: 1 });
        const spec = { AlarmName: "cpu-high", AlarmDescription: "Scale out web-asg", ActionsEnabled: true, AlarmActions: [policyArn(g, "scale-out")], MetricName: "CPUUtilization", Namespace: "AWS/EC2", Statistic: "Average",
          Dimensions: [{ Name: "AutoScalingGroupName", Value: "web-asg-2025" }], Period: 300, EvaluationPeriods: 2, Threshold: 70, ComparisonOperator: "GreaterThanThreshold" };
        putAlarm(a, spec);
        a.files["alarm.json"] = pretty(spec);
      },
      won: (a) => a.inService(a.asgs[0]) >= 3 && !a.asgs[0].manual,
      check: (a) => ({ label: "cpu-high / web-asg in service", text: `${(a.alarms.find((x) => x.name === "cpu-high") || { state: "deleted" }).state} / ${a.inService(a.asgs[0])}` }),
      hints: [
        "aws cloudwatch describe-alarms --alarm-names cpu-high --query 'MetricAlarms[].[StateValue,Dimensions]'",
        "INSUFFICIENT_DATA means no data points for exactly that metric with exactly those dimensions. The group is web-asg; the alarm watches web-asg-2025, last year's name.",
        "Fix the dimension's Value in alarm.json, then: aws cloudwatch put-metric-alarm --cli-input-json file://alarm.json"
      ],
      lesson: "An alarm matches a metric by namespace, name and every dimension. Renamed resources leave alarms watching nothing; INSUFFICIENT_DATA that never changes is a broken alarm. Target tracking policies avoid this by managing their own alarms.",
      tries: ["aws cloudwatch describe-alarms --alarm-names cpu-high", "aws autoscaling describe-policies --auto-scaling-group-name web-asg"],
      edit: ["alarm.json"]
    },
    {
      id: "alarmnoaction", title: "Alarm fired, nobody was paged", level: "14",
      story: "Yesterday customers saw errors for three hours. The orders-5xx alarm was in ALARM the whole time, but nobody was paged.",
      goal: "Make orders-5xx notify the on-call pager topic.",
      done: "orders-5xx pages the on-call topic.",
      setup(a) {
        a.metrics["AWS/ApplicationELB:HTTPCode_ELB_5XX_Count"] = 340;
        const spec = { AlarmName: "orders-5xx", AlarmDescription: "Load balancer 5xx errors", ActionsEnabled: true, AlarmActions: [], MetricName: "HTTPCode_ELB_5XX_Count", Namespace: "AWS/ApplicationELB", Statistic: "Sum",
          Dimensions: [{ Name: "LoadBalancer", Value: a.albs[0].arn.split("loadbalancer/")[1] }], Period: 300, EvaluationPeriods: 1, Threshold: 50, ComparisonOperator: "GreaterThanThreshold" };
        putAlarm(a, spec);
        a.files["alarm.json"] = pretty(spec);
      },
      won: (a) => a.notifications.some((n) => n.alarm === "orders-5xx" && n.topic === a.topics[0].arn),
      check: (a) => ({ label: "orders-5xx actions", text: ((a.alarms.find((x) => x.name === "orders-5xx") || { actions: [] }).actions.length ? "pages on-call" : "none") }),
      hints: [
        "aws cloudwatch describe-alarms --alarm-names orders-5xx --query 'MetricAlarms[].[StateValue,AlarmActions]'",
        "An alarm only changes state; its actions do something. aws sns list-topics, then aws sns list-subscriptions-by-topic --topic-arn <arn>: the pager topic has a confirmed subscription.",
        `Put the topic ARN (arn:aws:sns:${REGION}:${ACCOUNT}:oncall-pager) in AlarmActions in alarm.json, then aws cloudwatch put-metric-alarm --cli-input-json file://alarm.json`
      ],
      lesson: "An alarm with no actions is a dashboard light nobody watches. Wire alarms to a notification topic, confirm the subscription, and test the path end to end (aws cloudwatch set-alarm-state does that).",
      tries: ["aws cloudwatch describe-alarms --state-value ALARM", "aws sns list-topics"],
      edit: ["alarm.json"]
    },
    {
      id: "cloudtrail", title: "CloudTrail stopped logging", level: "14",
      story: "Security noticed that the audit logs from the last 20 hours are missing from the CloudTrail bucket.",
      goal: "Get main-trail logging again, and find out who stopped it.",
      done: "main-trail is logging again.",
      setup(a) {
        Object.assign(a.trail, { logging: false, stoppedAt: START - 20 * HOUR });
        a.events.push({ name: "StopLogging", source: "cloudtrail.amazonaws.com", user: "contractor-tmp", key: keyId("AKIA", "contractor"), at: START - 20 * HOUR, ip: "198.51.100.23", res: [{ ResourceType: "AWS::CloudTrail::Trail", ResourceName: "main-trail" }] });
      },
      won: (a) => a.trail.logging,
      check: (a) => ({ label: "main-trail", text: a.trail.logging ? "logging" : "stopped" }),
      hints: [
        "aws cloudtrail get-trail-status --name main-trail",
        "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopLogging shows who and when (management events stay searchable for 90 days even while the trail is off).",
        "aws cloudtrail start-logging --name main-trail"
      ],
      lesson: "Stopping CloudTrail is a classic first move for an intruder. Alert on StopLogging and DeleteTrail, and deny them with a service control policy so no one in the account can turn auditing off.",
      tries: ["aws cloudtrail get-trail-status --name main-trail", "aws cloudtrail describe-trails"]
    },

    // Cost
    {
      id: "natcost", title: "NAT gateway data bill", level: "17",
      story: "The bill shows about $220 a month for a single NAT gateway. The nightly backups copy about 4 TB a month from the private web servers to S3.",
      goal: "Stop paying NAT charges for S3 traffic, without breaking internet access from the private subnets.",
      done: "S3 traffic goes through a free gateway endpoint.",
      setup(a) { a.traffic = { internetGb: 60, s3Gb: 4100 }; },
      won: (a) => a.routeFor(SUB("private-a"), S3_IP, "s3").target.startsWith("vpce-") && a.routeFor(SUB("private-b"), S3_IP, "s3").target.startsWith("vpce-") && Boolean(a.natPath(SUB("private-a"))) && a.nats.some((n) => n.state === "available"),
      check: (a) => ({ label: "NAT gateway per month", text: money(a.nats.filter((n) => n.state === "available").reduce((s, n) => s + PRICES.natHour * PRICES.hours + a.natGb(n) * PRICES.natGb, 0)) }),
      hints: [
        "aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE",
        "From a private subnet, traffic to S3 goes through the NAT gateway and is charged per GB. A gateway VPC endpoint for S3 costs nothing and routes it privately.",
        `aws ec2 create-vpc-endpoint --vpc-id ${rid("vpc", "kitchen")} --service-name com.amazonaws.us-east-1.s3 --route-table-ids ${rid("rtb", "private")}`
      ],
      lesson: "NAT gateways charge for every GB they process. Gateway endpoints for S3 and DynamoDB are free and take that traffic off the NAT; check the usage types in Cost Explorer before guessing.",
      tries: ["aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE", "aws ec2 describe-vpc-endpoints"]
    },
    {
      id: "ebsforgotten", title: "Forgotten volumes and snapshots", level: "08",
      story: "EC2 - Other is the third-largest line on the bill. Nothing new was launched: it is storage nobody uses, volumes left behind by terminated instances and snapshots from 2024.",
      goal: "Delete the unattached volumes and the 2024 snapshots, but keep the snapshot behind the AMI in use.",
      done: "The unused storage is gone; the AMI's snapshot stays.",
      setup(a) {
        const vol = (name, size) => a.volumes.push({ id: rid("vol", name), size, type: "gp2", attached: null, device: null, created: START - 300 * DAY, name });
        vol("old-db-data", 500); vol("loadtest-1-root", 100); vol("scratch", 1000);
        const snap = (name, size, days, desc) => a.snapshots.push({ id: rid("snap", name), vol: rid("vol", name), size, created: START - days * DAY, desc, name });
        snap("web-2025-10", 20, 30, "Created by CreateImage(i-0a1b2c3d4e5f60718) for ami-0f1e2d3c4b5a69788");
        snap("db-2024-03", 500, 590, "nightly backup"); snap("db-2024-04", 500, 560, "nightly backup"); snap("migration-2024", 200, 450, "before migration");
        a.amis.push({ id: "ami-0f1e2d3c4b5a69788", name: "web-2025-10", snap: rid("snap", "web-2025-10"), created: START - 30 * DAY });
      },
      won: (a) => !a.volumes.some((v) => !v.attached) && a.snapshots.length === 1 && a.snapshots[0].id === rid("snap", "web-2025-10"),
      check: (a) => ({ label: "unattached volumes / snapshots", text: `${a.volumes.filter((v) => !v.attached).length} / ${a.snapshots.length}` }),
      hints: [
        "aws ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[].[VolumeId,Size,Tags[0].Value]' --output text",
        "aws ec2 describe-snapshots --owner-ids self --query 'Snapshots[].[SnapshotId,StartTime,VolumeSize,Description]' --output text. One backs an AMI: aws ec2 describe-images --owners self",
        "aws ec2 delete-volume --volume-id <id> for each available volume, and aws ec2 delete-snapshot --snapshot-id <id> for each 2024 snapshot."
      ],
      lesson: "Volumes outlive their instances unless DeleteOnTermination is set, and snapshots stay until deleted. Tag storage with an owner, review available volumes monthly, and let Data Lifecycle Manager expire snapshots.",
      tries: ["aws ec2 describe-volumes --filters Name=status,Values=available", "aws ec2 describe-snapshots --owner-ids self"]
    },
    {
      id: "eipidle", title: "Idle Elastic IP addresses", level: "17",
      story: "Every public IPv4 address now costs money, attached or not. The account holds four Elastic IPs; the staging server they belonged to was retired last month and is stopped.",
      goal: "Release every Elastic IP that serves nothing, and keep the bastion's.",
      done: "Only the bastion's Elastic IP is left.",
      setup(a) {
        a.addSg("bastion-sg", "Bastion", [{ proto: "tcp", from: 22, to: 22, cidr: "192.0.2.0/24", desc: "office" }]);
        const bastion = a.addInstance({ name: "bastion", type: "t3.micro", subnet: "public-a", sgs: ["bastion-sg"], ip: "10.0.1.40", app: "bastion" });
        const staging = a.addInstance({ name: "staging", type: "t3.medium", subnet: "public-a", sgs: ["default"], ip: "10.0.1.41", state: "stopped" });
        a.addEip("bastion-eip", 20).assoc = bastion.id;
        a.addEip("staging-eip", 21).assoc = staging.id;
        a.addEip("old-ftp", 22);
        a.addEip("promo-2025", 23);
      },
      won: (a) => a.eips.filter((e) => e.name !== "nat-a-eip").length === 1 && a.eips.some((e) => e.assoc === II("bastion")),
      check: (a) => ({ label: "Elastic IPs (bastion + idle)", text: `${a.eips.filter((e) => e.name !== "nat-a-eip").length} held, ${a.eips.filter((e) => !e.assoc || (a.inst(e.assoc) && a.inst(e.assoc).state !== "running")).length} idle` }),
      hints: [
        "aws ec2 describe-addresses --query 'Addresses[].[PublicIp,AllocationId,AssociationId,InstanceId]' --output text",
        "About $3.65 a month each. Two serve nothing; one sits on the stopped staging server. Releasing an address that is still associated fails.",
        "aws ec2 release-address --allocation-id <id> for the free ones; for staging's, aws ec2 disassociate-address --association-id <id> first."
      ],
      lesson: "Since February 2024 AWS charges for every public IPv4 address by the hour, in use or idle. Release what serves nothing, and prefer a load balancer or IPv6 to one address per server.",
      tries: ["aws ec2 describe-addresses --query 'Addresses[].[PublicIp,AllocationId,InstanceId]' --output text"]
    },
    {
      id: "logretention", title: "CloudWatch Logs kept forever", level: "17",
      story: "CloudWatch is the second-largest line on the bill: about 4 TB of logs, all set to never expire. Company policy keeps application logs 30 days and VPC flow logs one year.",
      goal: "Set retention to 30 days for the application log groups and 365 days for /vpc/flow-logs.",
      done: "Every log group has the retention the policy asks for.",
      setup(a) {
        a.logGroups = [];
        a.addLogGroup("/aws/lambda/orders-api", { gb: 900, ingestGb: 60 });
        a.addLogGroup("/ecs/web", { gb: 1200, ingestGb: 90 });
        a.addLogGroup("/vpc/flow-logs", { gb: 2000, ingestGb: 150 });
      },
      won(a) {
        const g = (n) => a.logGroups.find((x) => x.name === n);
        return ["/aws/lambda/orders-api", "/ecs/web"].every((n) => g(n) && g(n).retention && g(n).retention <= 30) && g("/vpc/flow-logs") && g("/vpc/flow-logs").retention >= 365 && g("/vpc/flow-logs").retention <= 400;
      },
      check: (a) => ({ label: "Logs stored", text: `${Math.round(a.logGroups.reduce((n, g) => n + a.storedGb(g), 0)).toLocaleString("en-US")} GB` }),
      hints: [
        "aws logs describe-log-groups --query 'logGroups[].[logGroupName,retentionInDays,storedBytes]' --output text. None means never expire.",
        "Storage is billed per GB-month for as long as you keep it. Retention deletes old events for you; deleting a group throws away what policy says to keep.",
        "aws logs put-retention-policy --log-group-name /aws/lambda/orders-api --retention-in-days 30 (the same for /ecs/web), and --retention-in-days 365 for /vpc/flow-logs"
      ],
      lesson: "New log groups keep everything forever by default. Set retention when you create them (in infrastructure as code), and export to S3 for cheap long-term storage if you need years.",
      tries: ["aws logs describe-log-groups --query 'logGroups[].[logGroupName,retentionInDays,storedBytes]' --output text"]
    },
    {
      id: "s3versions", title: "Old versions piling up in S3", level: "17",
      story: "quest-kitchen-backups grows by about 900 GB a month although the backups stay the same size: the nightly job overwrites them, and versioning keeps every old copy. Someone left a lifecycle.json in the repository.",
      goal: "Expire old versions after 30 days, without expiring the current backups.",
      done: "Old versions expire after 30 days; current backups stay.",
      setup(a) {
        const b = a.addBucket("quest-kitchen-backups", { versioning: "Enabled", gb: 900, noncurrentGb: 14000, churnGb: 30 });
        b.objects["nightly/orders.dump"] = Array.from({ length: 6 }, (_, n) => ({ v: hexOf("dump" + n, 32), size: 30e9, modified: START - n * DAY, owner: ACCOUNT, body: "" }));
        a.files["lifecycle.json"] = pretty({ Rules: [{ ID: "tidy-backups", Status: "Enabled", Filter: { Prefix: "nightly/" }, Expiration: { Days: 30 } }] });
      },
      won(a) {
        const rules = ((a.buckets["quest-kitchen-backups"] || {}).lifecycle || { Rules: [] }).Rules.filter((r) => r.Status === "Enabled");
        return rules.some((r) => r.NoncurrentVersionExpiration && Number(r.NoncurrentVersionExpiration.NoncurrentDays) <= 30) && !rules.some((r) => r.Expiration && r.Expiration.Days);
      },
      check: (a) => ({ label: "Noncurrent versions kept", text: `${Math.round(a.noncurrent(a.buckets["quest-kitchen-backups"])).toLocaleString("en-US")} GB` }),
      hints: [
        "aws s3api get-bucket-versioning --bucket quest-kitchen-backups, then aws s3api list-object-versions --bucket quest-kitchen-backups --prefix nightly/ --query 'length(Versions)'",
        "Read lifecycle.json before applying it: Expiration acts on current versions, the backups you still need. Old versions are NoncurrentVersionExpiration.",
        "Make it {\"Rules\": [{\"ID\": \"expire-old-versions\", \"Status\": \"Enabled\", \"Filter\": {}, \"NoncurrentVersionExpiration\": {\"NoncurrentDays\": 30}}]}, then aws s3api put-bucket-lifecycle-configuration --bucket quest-kitchen-backups --lifecycle-configuration file://lifecycle.json"
      ],
      lesson: "Versioning keeps every overwritten copy until a lifecycle rule expires it, and each copy is billed. Suspending versioning does not delete the old versions. Pair versioning with NoncurrentVersionExpiration from day one.",
      tries: ["aws s3api get-bucket-versioning --bucket quest-kitchen-backups", "cat lifecycle.json"],
      edit: ["lifecycle.json"], blanks: { bucket: "quest-kitchen-backups" }
    },

    // Security
    {
      id: "imdsv1", title: "IMDSv1: credentials one request away", level: "16",
      story: "A penetration test found that the shop's image preview fetches any URL it is given, including the instance metadata service.",
      goal: "Make the metadata service refuse requests without a token on both web servers; the app must keep its role credentials.",
      done: "Both web servers require IMDSv2.",
      setup(a) { for (const n of ["web-1", "web-2"]) a.inst(n).imds.tokens = "optional"; },
      won: (a) => ["web-1", "web-2"].every((n) => a.inst(n).imds.tokens === "required" && a.inst(n).imds.endpoint === "enabled"),
      check: (a) => ({ label: "IMDS on web-1 / web-2", text: ["web-1", "web-2"].map((n) => (a.inst(n).imds.endpoint !== "enabled" ? "off" : a.inst(n).imds.tokens === "required" ? "v2 only" : "v1 open")).join(" / ") }),
      hints: [
        "curl 'http://shop.example.com/preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/web-role'",
        "aws ec2 describe-instances --query 'Reservations[].Instances[].[Tags[?Key==`Name`]|[0].Value,MetadataOptions.HttpTokens]' --output text. optional means IMDSv1 still answers.",
        `aws ec2 modify-instance-metadata-options --instance-id ${II("web-1")} --http-tokens required --http-endpoint enabled, and the same for ${II("web-2")}`
      ],
      lesson: "IMDSv2 needs a token from a PUT request, which a server-side request forgery cannot send. Require it everywhere (and set it as the account default); turning the endpoint off instead breaks the role credentials the app needs. Also fix the preview, which should never fetch internal addresses.",
      tries: ["curl 'http://shop.example.com/preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/web-role'", "aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,MetadataOptions.HttpTokens]' --output text"],
      blanks: { instance: "web-1" }
    },
    {
      id: "rootkeys", title: "Root user access keys", level: "16",
      story: "Your default CLI profile, and the deploy script copied from it, use the root user's access keys. CloudTrail is full of root activity, and the root user has no MFA.",
      goal: "Delete the root user's access keys, and work with the admin profile from now on.",
      done: "The root user has no access keys.",
      setup(a) {
        const k = a.addKey(null, "rootuser", { created: START - 700 * DAY });
        a.profiles.default = { key: k.id, secret: k.secret };
        a.profiles.admin = { sso: true, role: "PlatformAdmin", session: "you" };
        a.iam.rootMfa = false;
        for (const [n, h] of [["DescribeInstances", 2], ["PutObject", 5], ["UpdateFunctionCode", 26]]) a.events.push({ name: n, source: n === "PutObject" ? "s3.amazonaws.com" : n === "UpdateFunctionCode" ? "lambda.amazonaws.com" : "ec2.amazonaws.com", user: "root", key: k.id, at: START - h * HOUR });
      },
      won: (a) => a.iam.rootKeys.length === 0,
      check: (a) => ({ label: "Root access keys", text: a.iam.rootKeys.length ? a.iam.rootKeys.map((id) => a.creds[id].status).join(", ") : "none" }),
      hints: [
        "aws sts get-caller-identity: the Arn ends in :root. aws iam get-account-summary --query 'SummaryMap.[AccountAccessKeysPresent,AccountMFAEnabled]'",
        "Only the root user can manage its own keys, so do it with the default profile before you switch. aws iam list-access-keys (no user name, as root) lists them.",
        "aws iam delete-access-key --access-key-id <root key id>, then use --profile admin (or export AWS_PROFILE=admin)."
      ],
      lesson: "Root can do anything, including closing the account, and IAM policies cannot limit it. Give it a strong password and MFA (set in the console), keep no access keys, and use roles for daily work and automation.",
      tries: ["aws sts get-caller-identity", "aws iam get-account-summary"]
    },
    {
      id: "leakedkey", title: "Access key leaked in Git", level: "16",
      story: "GitHub secret scanning reports an access key pushed to a public repository an hour ago, in app/settings.py. Someone may already be using it.",
      goal: "Make the leaked key useless: deactivate it, then delete it.",
      done: "The leaked key no longer exists.",
      setup(a) {
        a.addUser("report-bot", [awsPolicyArn("AmazonS3ReadOnlyAccess")]);
        const k = a.addKey(a.iam.users["report-bot"], "reportbot");
        a.files["app/settings.py"] = `# Settings for the nightly report\nREPORT_BUCKET = "quest-kitchen-reports"\nAWS_ACCESS_KEY_ID = "${k.id}"\nAWS_SECRET_ACCESS_KEY = "${k.secret}"\n`;
        a.files["app/report.py"] = "import boto3\nfrom settings import REPORT_BUCKET\n";
        a.git = [["9f3c2e1", "Add nightly report settings"], ["4b7a019", "Initial report job"]];
        a.events.push({ name: "ListBuckets", source: "s3.amazonaws.com", user: "report-bot", key: k.id, at: START - 20 * 60e3, ip: "198.51.100.66", agent: "python-requests/2.31" },
          { name: "GetCallerIdentity", source: "sts.amazonaws.com", user: "report-bot", key: k.id, at: START - 22 * 60e3, ip: "198.51.100.66", agent: "python-requests/2.31" });
        a.leaked = k.id;
      },
      won: (a) => !a.creds[a.leaked],
      check: (a) => ({ label: "Leaked key", text: a.creds[a.leaked] ? a.creds[a.leaked].status : "deleted" }),
      hints: [
        "grep -rn AKIA . finds it. aws iam list-access-keys --user-name report-bot",
        "aws cloudtrail lookup-events --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=<key id> shows what it was used for, and from which IP.",
        "aws iam update-access-key --user-name report-bot --access-key-id <key id> --status Inactive, then aws iam delete-access-key --user-name report-bot --access-key-id <key id>"
      ],
      lesson: "A pushed key is compromised even after you remove the commit: bots scrape public repositories within minutes. Disable it, check CloudTrail for what it did, delete it, and move the job to a role so it needs no long-lived key.",
      tries: ["grep -rn AKIA .", "aws iam list-access-keys --user-name report-bot"],
      blanks: { user: "report-bot" }
    },
    {
      id: "sshworld", title: "SSH open to the world", level: "16",
      story: "GuardDuty reports an SSH brute-force attempt against the bastion host. Its security group allows port 22 from anywhere. Engineers can use Session Manager instead.",
      goal: "Close SSH to the internet, and check you still get a shell on the bastion with Session Manager.",
      done: "SSH is closed to the world and Session Manager works.",
      setup(a) {
        a.addSg("bastion-sg", "Bastion", [{ proto: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0" }]);
        const b = a.addInstance({ name: "bastion", type: "t3.micro", subnet: "public-a", sgs: ["bastion-sg"], ip: "10.0.1.40", app: "bastion", publicIp: PUBLIC_IP(20), role: "web-role" });
        a.findings.push({ id: hexOf("finding", 32), type: "UnauthorizedAccess:EC2/SSHBruteForce", severity: 2, title: `198.51.100.200 is performing SSH brute force attacks against ${b.id}.`,
          desc: `198.51.100.200 is performing SSH brute force attacks against ${b.id}. Brute force attacks are used to gain unauthorized access to your instance by guessing the SSH password.`,
          resource: { ResourceType: "Instance", InstanceDetails: { InstanceId: b.id, InstanceType: "t3.micro" } }, count: 1840, at: START - 5 * HOUR });
      },
      won: (a) => !worldOpen(a, "bastion-sg") && ssmOnline(a, a.inst("bastion")) && a.history.some((h) => /aws ssm start-session/.test(h)),
      check: (a) => ({ label: "bastion SSH from anywhere / Session Manager", text: `${worldOpen(a, "bastion-sg") ? "open" : "closed"} / ${ssmOnline(a, a.inst("bastion")) ? "online" : "offline"}` }),
      hints: [
        "aws guardduty list-detectors, then aws guardduty list-findings --detector-id <id> and get-findings for the details.",
        "aws ec2 describe-security-groups --group-names bastion-sg. Session Manager needs no inbound port at all.",
        `aws ec2 revoke-security-group-ingress --group-id ${SGI("bastion-sg")} --protocol tcp --port 22 --cidr 0.0.0.0/0, then aws ssm start-session --target ${II("bastion")}`
      ],
      lesson: "Port 22 open to the internet is scanned within minutes. Session Manager gives a shell with IAM, logging and no open port; moving SSH to another port only slows the scanners down.",
      tries: ["aws ec2 describe-security-groups --group-names bastion-sg", "aws guardduty list-detectors"],
      blanks: { instance: "bastion", sg: "bastion-sg" }
    },
    {
      id: "kmsdecrypt", title: "KMS key policy blocks decrypt", level: "15",
      story: "The payments job, running as the payments-app role, cannot read settlement files from quest-kitchen-payments. Its IAM policy allows both s3:GetObject and kms:Decrypt.",
      goal: "Let payments-app decrypt with the payments key, and nobody else.",
      done: "payments-app can decrypt, and the key is not open to others.",
      setup(a) {
        const kp = doc({ Sid: "KeyAdministrators", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/PlatformAdmin` }, Action: "kms:*", Resource: "*" });
        const k = a.addKmsKey("payments", kp);
        a.addBucket("quest-kitchen-payments", { kms: k.arn, objects: { "settlements/2026-10-29.csv": { size: 7100, body: "date,amount\n2026-10-29,18220.40\n" } } });
        a.addRole("payments-app", trustService("ec2.amazonaws.com"), [], { "payments": doc({ Effect: "Allow", Action: ["s3:GetObject", "s3:ListBucket"], Resource: ["arn:aws:s3:::quest-kitchen-payments", "arn:aws:s3:::quest-kitchen-payments/*"] }, { Effect: "Allow", Action: "kms:Decrypt", Resource: k.arn }) });
        a.profiles.payments = { sso: true, role: "payments-app", session: "you" };
        a.files["key-policy.json"] = pretty(kp);
      },
      won(a) {
        const k = a.kmsKeys[0];
        const can = (who) => evaluate(a, who, "kms:Decrypt", k.arn, { resPolicy: k.policy, kms: true }).allowed;
        return can(a.role("payments-app")) && !can(a.outsider()) && !can(a.role("web-role")) && evaluate(a, a.role("PlatformAdmin", "you"), "kms:PutKeyPolicy", k.arn, { resPolicy: k.policy, kms: true }).allowed;
      },
      check: (a) => ({ label: "payments-app: kms:Decrypt", text: evaluate(a, a.role("payments-app"), "kms:Decrypt", a.kmsKeys[0].arn, { resPolicy: a.kmsKeys[0].policy, kms: true }).allowed ? "allowed" : "denied by the key policy" }),
      hints: [
        "aws s3 cp s3://quest-kitchen-payments/settlements/2026-10-29.csv . --profile payments",
        "aws kms get-key-policy --key-id alias/payments --query Policy --output text. With KMS the key policy must allow access, to the role or to the account; IAM alone is never enough.",
        `Add to key-policy.json: {"Sid": "PaymentsAppDecrypt", "Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::${ACCOUNT}:role/payments-app"}, "Action": "kms:Decrypt", "Resource": "*"}, then aws kms put-key-policy --key-id alias/payments --policy-name default --policy file://key-policy.json`
      ],
      lesson: "Every KMS key has a key policy and nothing works without it, AdministratorAccess included. KMS also refuses a new policy that would lock you out, which is why the administrators' statement must stay.",
      tries: ["aws s3 cp s3://quest-kitchen-payments/settlements/2026-10-29.csv . --profile payments", "aws kms get-key-policy --key-id alias/payments --query Policy --output text"],
      edit: ["key-policy.json"], blanks: { bucket: "quest-kitchen-payments", role: "payments-app", profile: "payments" }
    },

    // Coverage round: CDN, peering, containers, data services, CORS, limits.
    {
      id: "cfcert", title: "CloudFront: certificate in the wrong Region", level: "21",
      story: "The new marketing site at https://www.example.com fails with a certificate error. A certificate for www.example.com was issued in eu-west-1, where the rest of the app lives, but CloudFront will not take it. Someone also requested one in us-east-1 yesterday; it is still pending.",
      goal: "Serve https://www.example.com from CloudFront with a valid certificate.",
      done: "CloudFront serves www.example.com with a valid us-east-1 certificate.",
      setup(a) {
        a.addBucket("quest-kitchen-web", { objects: { "index.html": { body: "<!doctype html><title>Quest Kitchen</title><h1>Dinner, delivered</h1>" } } });
        const d = a.addDist("www.example.com", "quest-kitchen-web");
        d.aliases = [];
        a.addCert("www.example.com", "eu-west-1", "ISSUED");
        a.addCert("www.example.com", "us-east-1", "PENDING_VALIDATION");
        const cfg = distConfig(a, d);
        cfg.Aliases = { Quantity: 1, Items: ["www.example.com"] };
        a.files["dist-config.json"] = pretty(cfg);
      },
      won: (a) => { const d = a.dists[0]; const c = a.certs.find((x) => x.arn === d.cert); return Boolean(c && c.region === "us-east-1" && c.status === "ISSUED" && d.status === "Deployed") && fromLaptopHttps(a, "www.example.com") === 200; },
      check: (a) => ({ label: "curl https://www.example.com", text: String(fromLaptopHttps(a, "www.example.com")) }),
      hints: [
        "curl https://www.example.com, then aws acm list-certificates --region eu-west-1 and aws acm list-certificates --region us-east-1. CloudFront only uses certificates from us-east-1.",
        "The us-east-1 certificate is PENDING_VALIDATION: aws acm describe-certificate --region us-east-1 --certificate-arn <arn> --query 'Certificate.DomainValidationOptions[0].ResourceRecord'. Create that CNAME in Route 53 (an UPSERT in a change batch file), and ACM issues it.",
        "Then put its ARN in dist-config.json (ViewerCertificate: ACMCertificateArn, SSLSupportMethod sni-only, MinimumProtocolVersion TLSv1.2_2021, no CloudFrontDefaultCertificate) and: aws cloudfront update-distribution --id <id> --if-match <ETag from get-distribution-config> --distribution-config file://dist-config.json"
      ],
      lesson: "CloudFront is global and takes certificates only from ACM in us-east-1, whatever Region the rest of your app uses. DNS validation needs its CNAME record to stay in place; ACM uses it again for automatic renewal.",
      tries: ["curl -I https://www.example.com", "aws acm list-certificates --region us-east-1"],
      edit: ["dist-config.json"]
    },
    {
      id: "cfcache", title: "CloudFront serves the old version", level: "21",
      story: "Release 1.9 of the website was uploaded to S3 an hour ago, yet customers still see version 1.8. The S3 object is new; CloudFront keeps serving the copy it cached yesterday.",
      goal: "Make CloudFront serve the new index.html.",
      done: "CloudFront serves version 1.9.",
      setup(a) {
        const b = a.addBucket("quest-kitchen-web", { versioning: "Enabled" });
        b.objects["index.html"] = [{ v: hexOf("web19", 32), size: 72, modified: START - HOUR, owner: ACCOUNT, body: "<!doctype html><title>Quest Kitchen 1.9</title>" },
          { v: hexOf("web18", 32), size: 72, modified: START - 3 * DAY, owner: ACCOUNT, body: "<!doctype html><title>Quest Kitchen 1.8</title>" }];
        const d = a.addDist("www.example.com", "quest-kitchen-web");
        d.cert = a.addCert("www.example.com", "us-east-1", "ISSUED").arn;
        d.cache["/index.html"] = { body: "<!doctype html><title>Quest Kitchen 1.8</title>", at: START - 11 * HOUR };
      },
      won: (a) => !a.dists[0].cache["/index.html"] || a.dists[0].cache["/index.html"].body.includes("1.9"),
      check: (a) => ({ label: "www.example.com serves", text: (a.dists[0].cache["/index.html"] || { body: "1.9" }).body.includes("1.9") ? "version 1.9" : "version 1.8 (cached)" }),
      hints: [
        "curl -i https://www.example.com: look at X-Cache and Age. Then aws s3 cp s3://quest-kitchen-web/index.html - shows what the bucket holds.",
        "The cache keeps the old copy until its TTL runs out. Uploading again changes nothing at the edge. Ask CloudFront to drop it: an invalidation.",
        "aws cloudfront create-invalidation --distribution-id <id> --paths /index.html (or \"/*\"), then curl again once it completes."
      ],
      lesson: "CloudFront serves from cache until the TTL expires or you invalidate. For releases, give assets versioned file names (app.4f2a.js) with long TTLs, keep index.html short-lived, and invalidate only the entry points.",
      tries: ["curl -i https://www.example.com", "aws cloudfront list-distributions --query 'DistributionList.Items[].[Id,DomainName]' --output text"]
    },
    {
      id: "peering", title: "VPC peering: no route back", level: "04",
      story: "The analytics team peered their VPC (10.20.0.0/16) with ours so the web servers can read from analytics-db. The peering is active and our route table points at it, but connections from web-1 time out.",
      goal: "Let web-1 reach analytics-db on port 5432 over the peering, without opening the database to the internet.",
      done: "web-1 reaches analytics-db over the peering.",
      setup(a) {
        const vpc = rid("vpc", "analytics");
        a.vpcs.push({ id: vpc, name: "analytics", cidr: "10.20.0.0/16" });
        a.subnets.push({ id: SUB("analytics-a"), name: "analytics-a", cidr: "10.20.1.0/24", az: "us-east-1a", vpc, mapPublic: false });
        const pcx = { id: rid("pcx", "kitchen-analytics"), name: "kitchen-analytics", a: a.vpcs[0].id, b: vpc, status: "active" };
        a.peerings.push(pcx);
        a.rts.push({ id: rid("rtb", "analytics"), name: "analytics-rt", vpc, subnets: [SUB("analytics-a")], routes: [{ dest: "10.20.0.0/16", target: "local" }] });
        a.rt("private-rt").routes.push({ dest: "10.20.0.0/16", target: pcx.id });
        const g = a.addSg("analytics-db-sg", "Analytics database", [{ proto: "tcp", from: 5432, to: 5432, cidr: "10.0.0.0/16", desc: "kitchen VPC" }]);
        g.vpc = vpc;
        a.addInstance({ name: "analytics-db", type: "t3.medium", subnet: "analytics-a", sgs: ["analytics-db-sg"], ip: "10.20.1.15", app: "pgsql" });
      },
      won: (a) => a.connect(a.inst("web-1"), a.inst("analytics-db"), 5432) === "ok" && !worldOpen(a, "analytics-db-sg"),
      check: (a) => ({ label: "web-1 → analytics-db:5432", text: a.connect(a.inst("web-1"), a.inst("analytics-db"), 5432) === "ok" ? "connects" : "times out" }),
      hints: [
        `aws ssm start-session --target ${II("web-1")}, then nc -vz 10.20.1.15 5432, then exit. aws ec2 describe-vpc-peering-connections shows the peering is active.`,
        "Routing must work in both directions. Our private-rt sends 10.20.0.0/16 to the peering; does analytics-rt send 10.0.0.0/16 back? aws ec2 describe-route-tables --filters Name=tag:Name,Values=analytics-rt",
        `aws ec2 create-route --route-table-id ${rid("rtb", "analytics")} --destination-cidr-block 10.0.0.0/16 --vpc-peering-connection-id ${rid("pcx", "kitchen-analytics")}`
      ],
      lesson: "A peering connection carries nothing until both sides route the other's CIDR to it, and the security groups allow it. Peering needs non-overlapping CIDRs and is not transitive; for many VPCs, use a Transit Gateway.",
      tries: ["aws ec2 describe-vpc-peering-connections", "aws ec2 describe-route-tables --query 'RouteTables[].[Tags[0].Value,Routes[].DestinationCidrBlock]' --output text"],
      blanks: { instance: "web-1", rtb: "analytics-rt", sg: "analytics-db-sg" }
    },
    {
      id: "ecsnetwork", title: "ECS task cannot reach ECR", level: "19",
      story: "The new orders-worker service on Fargate never starts: every task stops after a minute with ResourceInitializationError. The tasks run in the private subnets, which have no NAT gateway; security wants AWS traffic to stay private.",
      goal: "Get orders-worker running in the private subnets, without a NAT gateway or public IPs.",
      done: "orders-worker runs, pulling its image through VPC endpoints.",
      setup(a) {
        a.nats = [];
        a.eips = [];
        a.rt("private-rt").routes = a.rt("private-rt").routes.filter((r) => r.target === "local");
        a.addSg("worker-sg", "orders-worker tasks", []);
        a.addRole("ecsTaskExecutionRole", trustService("ecs-tasks.amazonaws.com"), [awsPolicyArn("service-role/AmazonECSTaskExecutionRolePolicy")]);
        a.addRole("orders-worker-task", trustService("ecs-tasks.amazonaws.com"), []);
        a.ecs.taskDefs["orders-worker:7"] = { family: "orders-worker", revision: 7, executionRole: iamArn("role", "ecsTaskExecutionRole"), taskRole: iamArn("role", "orders-worker-task"), image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/orders-worker:1.4.2` };
        a.ecs.services.push({ name: "orders-worker", cluster: "kitchen", taskDef: "orders-worker:7", desired: 2, subnets: ["private-a", "private-b"], sgs: ["worker-sg"], publicIp: false });
      },
      won: (a) => a.ecsRunning(a.ecs.services[0]) === 2 && !a.nats.some((n) => n.state === "available" || n.state === "pending") && !a.ecs.services[0].publicIp,
      check: (a) => ({ label: "orders-worker running / desired", text: `${a.ecsRunning(a.ecs.services[0])} / ${a.ecs.services[0].desired}` }),
      hints: [
        "aws ecs list-tasks --cluster kitchen --desired-status STOPPED, then aws ecs describe-tasks --cluster kitchen --tasks <task ARN> --query 'tasks[].stoppedReason'",
        "dial tcp ...:443: i/o timeout to api.ecr means the task has no path to ECR. Without NAT, private subnets reach ECR through interface endpoints for ecr.api and ecr.dkr, and the image layers through a gateway endpoint for S3.",
        `aws ec2 create-vpc-endpoint --vpc-id ${rid("vpc", "kitchen")} --vpc-endpoint-type Interface --service-name com.amazonaws.us-east-1.ecr.api (the same for ecr.dkr), then aws ec2 create-vpc-endpoint --vpc-id ${rid("vpc", "kitchen")} --service-name com.amazonaws.us-east-1.s3 --route-table-ids ${rid("rtb", "private")}, then aws ecs update-service --cluster kitchen --service orders-worker --force-new-deployment`
      ],
      lesson: "Fargate pulls images through the task's own network interface. In a private subnet it needs a NAT gateway or VPC endpoints: ecr.api and ecr.dkr for the registry and S3 for the layers (plus logs for CloudWatch Logs). A public IP helps only in a subnet routed to an internet gateway.",
      tries: ["aws ecs describe-services --cluster kitchen --services orders-worker --query 'services[].[desiredCount,runningCount,events[0].message]'", "aws ecs list-tasks --cluster kitchen --desired-status STOPPED"]
    },
    {
      id: "ecsrole", title: "ECS task: execution role cannot pull", level: "19",
      story: "After a cleanup of IAM policies, the orders-worker tasks stop at start-up. The developer already gave the task's role ECR read access, and nothing changed.",
      goal: "Get orders-worker running, with ECR access on the role that needs it.",
      done: "orders-worker runs; the execution role can pull images.",
      setup(a) {
        a.addSg("worker-sg", "orders-worker tasks", []);
        a.addRole("ecsTaskExecutionRole", trustService("ecs-tasks.amazonaws.com"), [], { logs: doc({ Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }) });
        a.addRole("orders-worker-task", trustService("ecs-tasks.amazonaws.com"), [awsPolicyArn("AmazonEC2ContainerRegistryReadOnly")]);
        a.ecs.taskDefs["orders-worker:7"] = { family: "orders-worker", revision: 7, executionRole: iamArn("role", "ecsTaskExecutionRole"), taskRole: iamArn("role", "orders-worker-task"), image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/orders-worker:1.4.2` };
        a.ecs.services.push({ name: "orders-worker", cluster: "kitchen", taskDef: "orders-worker:7", desired: 2, subnets: ["private-a", "private-b"], sgs: ["worker-sg"], publicIp: false });
      },
      won: (a) => a.ecsRunning(a.ecs.services[0]) === 2 && !a.can(a.role("orders-worker-task"), "iam:PassRole", "*") && !a.iam.roles["ecsTaskExecutionRole"].attached.includes(awsPolicyArn("AdministratorAccess")),
      check: (a) => ({ label: "orders-worker running / desired", text: `${a.ecsRunning(a.ecs.services[0])} / ${a.ecs.services[0].desired}` }),
      hints: [
        "aws ecs list-tasks --cluster kitchen --desired-status STOPPED, then describe-tasks for the stoppedReason. Whose role is named in the AccessDeniedException?",
        "Two roles: the task execution role is what ECS (the agent) uses to pull the image and write logs; the task role is what your code uses. aws ecs describe-task-definition --task-definition orders-worker:7 --query 'taskDefinition.[executionRoleArn,taskRoleArn]'",
        "aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy, then aws ecs update-service --cluster kitchen --service orders-worker --force-new-deployment"
      ],
      lesson: "ECS pulls images and fetches secrets with the task execution role, before your container starts; the task role is only for your application's own AWS calls. Permissions on the wrong one never help.",
      tries: ["aws ecs list-tasks --cluster kitchen --desired-status STOPPED", "aws ecs describe-task-definition --task-definition orders-worker:7 --query 'taskDefinition.[executionRoleArn,taskRoleArn]'"],
      blanks: { role: "ecsTaskExecutionRole" }
    },
    {
      id: "eksauth", title: "kubectl: You must be logged in (Unauthorized)", level: "19",
      story: "The on-call engineers cannot use kubectl on kitchen-eks: every command says Unauthorized. The cluster was created by a CI role that has since been deleted, so nobody has access.",
      goal: "Give the OnCall role read-only access to the cluster with an EKS access entry.",
      done: "OnCall can read the cluster, and only read it.",
      setup(a) {
        a.addRole("OnCall", { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: `arn:aws:iam::${ACCOUNT}:saml-provider/QuestKitchenSSO` }, Action: "sts:AssumeRoleWithSAML" }] }, [awsPolicyArn("ReadOnlyAccess")],
          { eks: doc({ Effect: "Allow", Action: ["eks:DescribeCluster", "eks:ListClusters"], Resource: "*" }) });
        a.profiles.oncall = { sso: true, role: "OnCall", session: "you" };
        a.eks = { name: "kitchen-eks", authMode: "API_AND_CONFIG_MAP", entries: [{ principal: iamArn("role", "ci-cluster-bootstrap"), policies: [{ arn: eksPolicyArn("AmazonEKSClusterAdminPolicy"), scope: "cluster", namespaces: [] }], at: START - 200 * DAY }] };
      },
      won(a) {
        const p = iamArn("role", "OnCall");
        return a.kubeCan(p, "list", "default") === "yes" && a.kubeCan(p, "delete", "default") !== "yes" && a.kubeCan(p, "list", "kube-system") === "yes";
      },
      check: (a) => ({ label: "OnCall: kubectl get pods -A", text: { yes: "allowed", forbidden: "Forbidden", unauthorized: "Unauthorized" }[a.kubeCan(iamArn("role", "OnCall"), "list", null)] }),
      hints: [
        "aws eks update-kubeconfig --name kitchen-eks --profile oncall, then kubectl get pods. Then aws eks describe-cluster --name kitchen-eks --query cluster.accessConfig",
        "IAM permissions let you call the EKS API; inside the cluster, Kubernetes asks the access entries. aws eks list-access-entries --cluster-name kitchen-eks: only the deleted CI role is there.",
        `aws eks create-access-entry --cluster-name kitchen-eks --principal-arn arn:aws:iam::${ACCOUNT}:role/OnCall, then aws eks associate-access-policy --cluster-name kitchen-eks --principal-arn arn:aws:iam::${ACCOUNT}:role/OnCall --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster`
      ],
      lesson: "Unauthorized means Kubernetes did not recognise the identity; Forbidden means it did, but RBAC said no. With EKS access entries, an administrator grants cluster access through the EKS API, so losing the cluster creator no longer locks everyone out.",
      tries: ["aws eks update-kubeconfig --name kitchen-eks --profile oncall", "kubectl get pods"]
    },
    {
      id: "secretrotation", title: "Secret rotation broke the app", level: "20",
      story: "Rotation was switched on for the orders database secret last night. This morning orders-api fails with: password authentication failed for user \"orders_app\". Its configuration has the password pasted in an environment variable.",
      goal: "Make orders-api read the password from Secrets Manager at run time, with access to that one secret only.",
      done: "orders-api reads the current password from Secrets Manager.",
      setup(a) {
        const s = { name: "prod/orders/db", arn: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:prod/orders/db-${blob("sfx", 6)}`, version: 1, rotation: true, rotated: START - 9 * HOUR };
        a.secrets.push(s);
        a.addSg("lambda-sg", "orders-api function", []);
        a.sg("db-sg").in.push({ proto: "tcp", from: 5432, to: 5432, sg: SGI("lambda-sg"), desc: "from orders-api" });
        a.addRole("orders-api-role", trustService("lambda.amazonaws.com"), [awsPolicyArn("AWSLambdaVPCAccessExecutionRole")]);
        const old = JSON.parse(a.secretValue({ ...s, version: 0 })).password;
        a.addLambda({ name: "orders-api", role: "orders-api-role", timeout: 10, memory: 256, env: { DB_HOST: a.dbHost(a.db("orders-db")), DB_USER: "orders_app", DB_PASSWORD: old },
          vpc: { subnets: ["private-a", "private-b"], sgs: ["lambda-sg"], ip: "10.0.12.77" }, needs: { db: "orders-db", secret: "prod/orders/db" } });
        invoke(a, a.fn("orders-api"));
      },
      won(a) {
        const f = a.fn("orders-api"), s = a.secrets[0];
        const can = (arn) => evaluate(a, a.role("orders-api-role", "orders-api"), "secretsmanager:GetSecretValue", arn).allowed;
        return f.env.DB_PASSWORD === undefined && [s.name, s.arn].includes(f.env.SECRET_ID) && can(s.arn) && !can(`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:prod/payments/api-AbCdEf`);
      },
      check: (a) => ({ label: "orders-api database login", text: a.fn("orders-api").env.DB_PASSWORD !== undefined ? "password pasted in configuration" : a.fn("orders-api").env.SECRET_ID ? "reads Secrets Manager" : "no credentials" }),
      hints: [
        "aws lambda invoke --function-name orders-api out.json; cat out.json. Then aws secretsmanager describe-secret --secret-id prod/orders/db: when did it last rotate?",
        "A pasted password is a copy that rotation cannot update. The app's code reads the secret named in SECRET_ID if DB_PASSWORD is absent; its role also needs secretsmanager:GetSecretValue on that secret.",
        "aws iam put-role-policy --role-name orders-api-role --policy-name read-db-secret --policy-document '{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"<secret ARN>\"}]}', then aws lambda update-function-configuration --function-name orders-api --environment 'Variables={DB_HOST=<host>,DB_USER=orders_app,SECRET_ID=prod/orders/db}'"
      ],
      lesson: "Rotation changes the password in the database and in the secret, nowhere else. Applications must read the secret at run time (and cache it briefly), never hold a copy in configuration; pasting the new password back in only lasts until the next rotation.",
      tries: ["aws lambda invoke --function-name orders-api out.json", "aws secretsmanager describe-secret --secret-id prod/orders/db"]
    },
    {
      id: "dynamothrottle", title: "DynamoDB ProvisionedThroughputExceeded", level: "20",
      story: "Lunchtime orders fail to save. The orders-ingest function logs ProvisionedThroughputExceededException. The orders table was created with 5 write capacity units two years ago; lunch now brings about 40 writes a second.",
      goal: "Let the orders table take lunchtime writes.",
      done: "The orders table keeps up with the writes.",
      setup(a) {
        a.tables.push({ name: "orders", mode: "PROVISIONED", rcu: 5, wcu: 5, writes: 40, status: "ACTIVE" });
        a.metrics["AWS/DynamoDB:WriteThrottleEvents"] = (x) => (x.throttled(x.tables[0]) ? 1840 : 0);
        a.metrics["AWS/DynamoDB:ConsumedWriteCapacityUnits"] = (x) => Math.min(x.tables[0].mode === "PROVISIONED" ? x.tables[0].wcu : 40, 40) * 60;
        a.addRole("ingest-role", trustService("lambda.amazonaws.com"), [], { "write-orders": doc({ Effect: "Allow", Action: ["dynamodb:PutItem"], Resource: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/orders` }) });
        a.addLambda({ name: "orders-ingest", role: "ingest-role", timeout: 10, memory: 256, needs: { table: "orders" } });
        invoke(a, a.fn("orders-ingest"));
      },
      won: (a) => !a.throttled(a.tables[0]) && a.tables[0].status !== "DELETED",
      check: (a) => ({ label: "orders table writes", text: a.tables[0].mode === "PAY_PER_REQUEST" ? "on-demand, not throttled" : `${a.tables[0].wcu} WCU for 40 writes/s${a.throttled(a.tables[0]) ? ": throttled" : ""}` }),
      hints: [
        "aws lambda invoke --function-name orders-ingest out.json; cat out.json. Then aws dynamodb describe-table --table-name orders --query 'Table.[BillingModeSummary,ProvisionedThroughput]'",
        "One write capacity unit is one write per second (up to 1 KB). Five cannot take forty. Read capacity is a different budget.",
        "aws dynamodb update-table --table-name orders --billing-mode PAY_PER_REQUEST (or raise WriteCapacityUnits to at least 40 with --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=50)"
      ],
      lesson: "Provisioned tables throttle once writes pass their WCU (burst capacity hides it for a while). Use on-demand for spiky or unknown traffic, or provisioned capacity with auto scaling for steady load; the SDK's retries only delay the error.",
      tries: ["aws lambda invoke --function-name orders-ingest out.json", "aws dynamodb describe-table --table-name orders --query 'Table.[BillingModeSummary,ProvisionedThroughput]'"]
    },
    {
      id: "sqsdupes", title: "SQS: every email sent twice", level: "20",
      story: "Customers get two or three confirmation emails per order. The email worker takes about 90 seconds per message (it renders a PDF), and its log shows the same orders processed more than once.",
      goal: "Stop the duplicates, without losing messages.",
      done: "Messages stay hidden long enough to be processed once.",
      setup(a) {
        a.queues.push({ name: "order-emails", url: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/order-emails`, visibility: 30, retention: 345600, depth: 214, inflight: 37, modified: START - 90 * DAY, dlq: "order-emails-dlq" });
        a.queues.push({ name: "order-emails-dlq", url: `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/order-emails-dlq`, visibility: 30, retention: 1209600, depth: 0, inflight: 0, modified: START - 90 * DAY });
        const g = a.addLogGroup("/app/email-worker", { gb: 3, ingestGb: 1, retention: 30 });
        for (const [s, n] of [[0, 1], [31, 2], [62, 3]]) g.lines.push([START - 10 * 60e3 + s * 1000, `order 1042: rendering confirmation (receive count ${n})`]);
        g.lines.push([START - 10 * 60e3 + 90e3, "order 1042: email sent"], [START - 10 * 60e3 + 121e3, "order 1042: email sent"], [START - 10 * 60e3 + 152e3, "order 1042: email sent"]);
      },
      won: (a) => a.queues[0].visibility > 90 && !a.queues[0].purged,
      check: (a) => ({ label: "Visibility timeout / processing time", text: `${a.queues[0].visibility} s / 90 s` }),
      hints: [
        "aws logs tail /app/email-worker: the same order is received again every 30 seconds. aws sqs get-queue-url --queue-name order-emails",
        "aws sqs get-queue-attributes --queue-url <url> --attribute-names VisibilityTimeout. A received message reappears when its visibility timeout ends before the worker deletes it.",
        "aws sqs set-queue-attributes --queue-url <url> --attributes VisibilityTimeout=180"
      ],
      lesson: "SQS hides a received message for the visibility timeout; if processing takes longer, another consumer gets it too. Set the timeout well above the slowest processing time (six times a Lambda consumer's timeout), and make consumers idempotent, because standard queues deliver at least once.",
      tries: ["aws logs tail /app/email-worker", "aws sqs get-queue-url --queue-name order-emails"]
    },
    {
      id: "s3cors", title: "S3 CORS error in the browser", level: "09",
      story: "The new menu page at https://shop.example.com fetches menu.json from S3 with a presigned URL. The browser console says: Access to fetch at 'https://quest-kitchen-media.s3.us-east-1.amazonaws.com/menu.json' from origin 'https://shop.example.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
      goal: "Allow https://shop.example.com, and only it, to read from quest-kitchen-media in the browser.",
      done: "The browser may read the bucket from https://shop.example.com.",
      setup(a) {
        a.addBucket("quest-kitchen-media", { objects: { "menu.json": { body: "{\"dishes\":[\"ramen\",\"bibimbap\"]}" } } });
        a.files["cors.json"] = pretty({ CORSRules: [{ AllowedOrigins: ["https://example.com"], AllowedMethods: ["GET"], AllowedHeaders: ["*"], MaxAgeSeconds: 3000 }] });
      },
      won(a) {
        const rules = a.buckets["quest-kitchen-media"].cors || [];
        const allows = (origin) => rules.some((r) => asList(r.AllowedOrigins).some((x) => glob(x, origin)) && asList(r.AllowedMethods).includes("GET"));
        return allows("https://shop.example.com") && !allows("https://evil.example.net") && !a.isPublic(a.buckets["quest-kitchen-media"]);
      },
      check: (a) => ({ label: "Fetch from https://shop.example.com", text: (a.buckets["quest-kitchen-media"].cors || []).some((r) => asList(r.AllowedOrigins).some((x) => glob(x, "https://shop.example.com")) && asList(r.AllowedMethods).includes("GET")) ? "allowed by CORS" : "blocked by CORS" }),
      hints: [
        "aws s3 presign s3://quest-kitchen-media/menu.json, then curl -i -H 'Origin: https://shop.example.com' '<the URL>'. The object comes back, but without Access-Control-Allow-Origin.",
        "aws s3api get-bucket-cors --bucket quest-kitchen-media. CORS is not about permission to the object (the presigned URL has that); it tells the browser which other sites may read the response. cors.json has the wrong origin.",
        "Set AllowedOrigins to [\"https://shop.example.com\"] in cors.json, then aws s3api put-bucket-cors --bucket quest-kitchen-media --cors-configuration file://cors.json"
      ],
      lesson: "A CORS error is the browser protecting users, not S3 refusing access: the request often succeeds and the browser throws the answer away. Allow exactly the origins and methods your site uses; \"*\" lets any site read the response in its visitors' browsers.",
      tries: ["aws s3api get-bucket-cors --bucket quest-kitchen-media", "aws s3 presign s3://quest-kitchen-media/menu.json"],
      edit: ["cors.json"], blanks: { bucket: "quest-kitchen-media" }
    },
    {
      id: "rdsrefused", title: "RDS connection refused", level: "11",
      story: "orders-api was moved to PostgreSQL from the MySQL template in AWS/RDS. It now fails at once with connect ECONNREFUSED. The database is available and its security group allows the function.",
      goal: "Make orders-api connect to orders-db.",
      done: "orders-api connects on the database's port.",
      setup(a) {
        a.addSg("lambda-sg", "orders-api function", []);
        a.sg("db-sg").in.push({ proto: "tcp", from: 3306, to: 3306, sg: SGI("lambda-sg"), desc: "from orders-api (MySQL)" }, { proto: "tcp", from: 5432, to: 5432, sg: SGI("lambda-sg"), desc: "from orders-api" });
        a.addRole("orders-api-role", trustService("lambda.amazonaws.com"), [awsPolicyArn("AWSLambdaVPCAccessExecutionRole")]);
        a.addLambda({ name: "orders-api", role: "orders-api-role", timeout: 10, memory: 256, env: { DB_HOST: a.dbHost(a.db("orders-db")), DB_PORT: "3306" },
          vpc: { subnets: ["private-a", "private-b"], sgs: ["lambda-sg"], ip: "10.0.12.77" }, needs: { db: "orders-db" } });
        invoke(a, a.fn("orders-api"));
      },
      won: (a) => a.connect(a.lambdaEp(a.fn("orders-api")), a.dbEp(a.db("orders-db")), Number(a.fn("orders-api").env.DB_PORT || 5432)) === "ok" && !broadCidr(a, "db-sg"),
      check: (a) => ({ label: "orders-api → orders-db", text: `port ${a.fn("orders-api").env.DB_PORT || 5432}: ${a.connect(a.lambdaEp(a.fn("orders-api")), a.dbEp(a.db("orders-db")), Number(a.fn("orders-api").env.DB_PORT || 5432))}` }),
      hints: [
        "aws lambda invoke --function-name orders-api out.json; cat out.json. ECONNREFUSED means the packets arrived and nothing listened: not a security group.",
        "aws rds describe-db-instances --query 'DBInstances[].[Engine,Endpoint.Port,DBInstanceStatus]' and aws lambda get-function-configuration --function-name orders-api --query Environment",
        "aws lambda update-function-configuration --function-name orders-api --environment 'Variables={DB_HOST=<host>,DB_PORT=5432}' (and revoke the leftover 3306 rule from db-sg)"
      ],
      lesson: "Refused is an answer from the host: the path is open and the port is wrong or the database is restarting. Read the port from the endpoint (5432 for PostgreSQL, 3306 for MySQL) rather than from a template.",
      tries: ["aws lambda invoke --function-name orders-api out.json", "aws rds describe-db-instances --query 'DBInstances[].[Engine,Endpoint.Port,DBInstanceStatus]'"]
    },
    {
      id: "throttling", title: "API throttling: RequestLimitExceeded", level: "14",
      story: "The nightly inventory script calls DescribeInstances across 84 account and Region pairs with 32 parallel jobs. Most nights it now dies with RequestLimitExceeded.",
      goal: "Make the inventory finish reliably.",
      done: "The inventory finishes, with retries that back off.",
      setup(a) {
        a.files["inventory.sh"] = "#!/usr/bin/env bash\n# Writes every instance in every account and Region to inventory.csv\nsource inventory.conf\nparallel -j \"$PARALLEL\" aws ec2 describe-instances --profile {1} --region {2} ::: $ACCOUNTS ::: $REGIONS\n";
        a.files["inventory.conf"] = "PARALLEL=32\nACCOUNTS=\"prod staging dev ... (14 profiles)\"\nREGIONS=\"us-east-1 us-west-2 eu-west-1 eu-central-1 ap-south-1 ap-southeast-2\"\n";
      },
      won: (a) => { inventory(a); return a.inventoryOk; },
      check: (a) => { const p = a.profiles.default || {}; return { label: "retry mode / attempts", text: `${a.env.AWS_RETRY_MODE || p.retry_mode || "legacy"} / ${a.env.AWS_MAX_ATTEMPTS || p.max_attempts || "default"}` }; },
      hints: [
        "./inventory.sh, then read the error: (reached max retries: 4): Request limit exceeded. EC2 throttles per account and Region.",
        "Retrying the same way at the same speed fails the same way. The CLI and SDKs can back off: the adaptive retry mode slows down when it sees throttling. aws configure list shows nothing about retries yet.",
        "export AWS_RETRY_MODE=adaptive AWS_MAX_ATTEMPTS=10 (or aws configure set retry_mode adaptive and aws configure set max_attempts 10), then ./inventory.sh. Lowering PARALLEL in inventory.conf also helps."
      ],
      lesson: "Throttling (ThrottlingException, RequestLimitExceeded, Rate exceeded) means slow down. Use the standard or adaptive retry modes with enough attempts, cap parallelism, and prefer events and caches to polling.",
      tries: ["./inventory.sh", "cat inventory.conf"],
      edit: ["inventory.conf"]
    }
  ];

  // Easiest first within each group.
  const GROUPS = [
    ["IAM and access", ["expired", "s3list", "trust", "passrole", "explicitdeny", "scp", "oidc"]],
    ["Networking", ["sgweb", "nopublicip", "routeigw", "nacl", "nat", "peering"]],
    ["Compute", ["stopped", "statuscheck", "capacity", "vcpu", "asgmax", "lambdatimeout", "throttled"]],
    ["Storage", ["bucketexists", "undelete", "nosuchbucket", "publicbucket", "ownership", "s3cors"]],
    ["Containers", ["ecsrole", "ecsnetwork", "eksauth"]],
    ["Databases and messaging", ["rdsbackup", "rdsstorage", "rdsrefused", "lambdards", "rdspublic", "rdsupgrade", "dynamothrottle", "sqsdupes"]],
    ["Load balancing, CDN and DNS", ["alb503", "alb502", "alb504", "healthpath", "r53record", "r53ns", "cfcache", "cfcert"]],
    ["Observability and limits", ["cloudtrail", "alarmnoaction", "asgalarm", "throttling"]],
    ["Cost", ["eipidle", "ebsforgotten", "logretention", "natcost", "s3versions"]],
    ["Security", ["sshworld", "imdsv1", "leakedkey", "rootkeys", "kmsdecrypt", "secretrotation"]]
  ];
  const ORDER = GROUPS.flatMap(([, ids]) => ids);
  SCENARIOS.sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id));
  for (const [group, ids] of GROUPS) for (const id of ids) SCENARIOS.find((x) => x.id === id).group = group;

  // Web identity: the OIDC provider is trusted only through the role's trust policy and its conditions.
  function webIdentityOk(a, role, claims) {
    const r = a.iam.roles[role];
    if (!r) return false;
    const keys = { "token.actions.githubusercontent.com:sub": claims.sub, "token.actions.githubusercontent.com:aud": claims.aud };
    const who = { federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com` };
    const s = scan([parseDoc(r.trust)], { action: "sts:AssumeRoleWithWebIdentity", keys, who }, true);
    return Boolean(s.allow) && !s.deny;
  }

  root.AQSim = { SCENARIOS, GROUPS, Account, shell, aws, lex, query, textOut, evaluate, fillBlanks, fromLaptop, PRICES, ACCOUNT, START };

  // --- UI ------------------------------------------------------------------------

  if (typeof document === "undefined") return;
  const term = document.getElementById("pg-term");
  if (!term) return;

  const out = document.getElementById("pg-out");
  const form = document.getElementById("pg-form");
  const input = document.getElementById("pg-input");
  const prompt = document.getElementById("pg-prompt");
  const map = document.getElementById("pg-map");
  const goal = document.getElementById("pg-goal");
  const picker = document.getElementById("pg-scenarios");
  const tries = document.getElementById("pg-try");
  const editor = document.getElementById("pg-editor");
  const link = document.getElementById("pg-link");

  const saved = {
    get() { try { return JSON.parse(localStorage.getItem("dq-aws:pg-solved")) || []; } catch { return []; } },
    add(id) { try { localStorage.setItem("dq-aws:pg-solved", JSON.stringify([...new Set([...saved.get(), id])])); } catch { /* private mode */ } }
  };

  let scenario = SCENARIOS[0];
  let acct;
  let solved;
  let hintLevel;
  let editing = null;
  let lastCost = 0;
  const history = [];
  let historyPos = 0;

  function el(tag, cls, text) {
    const x = document.createElement(tag);
    if (cls) x.className = cls;
    if (text != null) x.textContent = text;
    return x;
  }
  function print(text, cls) {
    out.append(el("div", "pg-line" + (cls ? " " + cls : ""), text));
    out.scrollTop = out.scrollHeight;
  }

  function renderPicker() {
    const done = new Set(saved.get());
    picker.replaceChildren(...GROUPS.map(([group, ids]) => {
      const row = el("div", "pg-group");
      const items = el("div", "pg-group-items");
      for (const s of ids.map((id) => SCENARIOS.find((x) => x.id === id))) {
        const b = el("button", "pg-scn");
        b.type = "button";
        b.setAttribute("aria-pressed", String(s === scenario));
        if (done.has(s.id)) b.append(el("span", "pg-scn-done", "✓"));
        b.append(document.createTextNode(s.title));
        b.title = done.has(s.id) ? `${s.title} (solved)` : s.title;
        b.addEventListener("click", () => { load(s.id); setHash(s.id); });
        items.append(b);
      }
      const n = ids.filter((id) => done.has(id)).length;
      const name = el("span", "pg-group-name", group);
      name.append(el("span", "pg-group-count" + (n === ids.length ? " done" : ""), `${n}/${ids.length}`));
      row.append(name, items);
      return row;
    }));
  }
  const setHash = (id) => { try { window.history.replaceState(null, "", "#play/" + id); } catch { /* file:// */ } };

  // Instance states at the last render, so one that comes up flashes once.
  let seen = new Map();
  function chip(label, state, title, use, key) {
    const was = seen.get(key);
    const b = el("button", `pg-res ${state}${was === undefined ? "" : was !== "ok" && state === "ok" ? " is-healed" : ""}`);
    b.type = "button";
    b.title = title;
    const dot = el("span", "pg-dot", state === "ok" ? "✓" : state === "wait" ? "…" : state === "off" ? "–" : "!");
    dot.setAttribute("aria-hidden", "true");
    b.append(dot, el("span", null, label));
    b.addEventListener("click", () => {
      const v = input.value;
      input.value = (v && !v.endsWith(" ") ? v + " " : v) + use;
      input.focus();
    });
    return b;
  }

  // The signature view: the VPC with its subnets, what runs in them, and what it costs.
  function renderMap() {
    const a = acct;
    const vpc = el("div", "pg-vpc");
    const head = el("div", "pg-panel-name", `VPC ${a.vpcs[0].name} ${a.vpcs[0].cidr}`);
    head.append(el("span", "pg-net-kind", a.igws.some((g) => g.vpc) ? "internet gateway attached" : "no internet gateway"));
    vpc.append(head);
    const grid = el("div", "pg-subnets");
    const next = new Map();
    for (const s of a.subnets) {
      const box = el("div", "pg-subnet");
      const route = a.routeFor(s.id, "8.8.8.8");
      const kind = route && route.target.startsWith("igw-") ? "→ internet gateway" : route && route.target.startsWith("nat-") ? "→ NAT" : "no route out";
      box.append(el("div", "pg-subnet-name", `${s.name} · ${kind}`));
      for (const n of a.nats.filter((x) => x.subnet === s.id && x.state !== "deleted")) box.append(chip("NAT", n.state === "available" ? "cost" : "wait", `${n.id}: ${n.state}`, n.id, n.id));
      if (a.albs.some((x) => x.subnets[0] === s.id)) box.append(chip("load balancer", "ok", a.albs[0].dns, a.albs[0].name, "alb"));
      for (const i of a.instances.filter((x) => x.subnet === s.id && x.state !== "terminated")) {
        const st = i.state === "running" ? (i.system === "ok" ? "ok" : "bad") : i.state === "stopped" ? "off" : "wait";
        next.set(i.id, st);
        box.append(chip(i.name, st, `${i.name} (${i.type}): ${i.state}${a.publicIpOf(i) ? ", " + a.publicIpOf(i) : ""}. Click to use its ID.`, i.id, i.id));
      }
      for (const d of a.dbs.filter((x) => x.subnet === s.id)) box.append(chip(d.id, d.status === "available" ? "ok" : /modifying|rebooting/.test(d.status) ? "wait" : "bad", `${d.id}: ${d.status}`, d.id, d.id));
      for (const f of a.lambdas.filter((x) => x.vpc && x.vpc.subnets[0] === s.id)) box.append(chip(f.name, "ok", `Lambda ${f.name}`, f.name, f.name));
      grid.append(box);
    }
    vpc.append(grid);
    seen = next;
    const cost = acct.monthly();
    const meter = el("div", "pg-meter");
    const total = el("b", cost > lastCost + 0.5 && lastCost ? "up" : cost < lastCost - 0.5 ? "down" : null, `≈ ${money(cost)} / month`);
    meter.append(el("span", "muted", "What it costs"), total);
    const items = acct.costItems().sort((x, y) => y.usd - x.usd).slice(0, 4);
    const list = el("div", "pg-cost-items");
    for (const x of items) {
      const row = el("div", "pg-cost-row");
      row.append(el("span", null, x.label), el("span", "pg-size", money(x.usd)));
      list.append(row);
    }
    const costBox = el("div", "pg-panel");
    costBox.append(meter, list, el("p", "note", `Illustrative us-east-1 list prices as of ${PRICES.asOf}.`));
    lastCost = cost;
    const r = scenario.check(acct);
    const box = el("div", "pg-check " + (scenario.won(acct) ? "ok" : "bad"));
    box.append(el("span", "pg-check-name", r.label), el("span", "pg-check-val", r.text));
    map.replaceChildren(box, vpc, costBox);
  }

  function renderEditor() {
    editor.hidden = !scenario.edit;
    if (!scenario.edit) return;
    if (!editing || !scenario.edit.includes(editing)) editing = scenario.edit[0];
    const area = el("textarea", "pg-edit");
    area.spellcheck = false;
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", `Edit ${editing}`);
    area.rows = 10;
    area.value = acct.files[editing] || "";
    area.addEventListener("input", () => { acct.files[editing] = area.value; });
    editor.replaceChildren(el("div", "pg-panel-name", `Editor · ${editing}`), area, el("p", "note", `Saved as you type. Use it in a command as file://${editing}.`));
  }

  function renderTries() {
    tries.replaceChildren(el("span", "muted small", "Try"), ...[...scenario.tries, "hint", "reset"].map((cmd) => {
      const b = el("button", "chip", cmd);
      b.type = "button";
      b.title = cmd;
      b.addEventListener("click", () => { run(cmd); input.focus(); });
      return b;
    }));
  }
  function renderPrompt() { prompt.textContent = acct.session ? "sh-5.2$" : "$"; }

  function load(id) {
    scenario = SCENARIOS.find((s) => s.id === id) || SCENARIOS[0];
    acct = new Account(scenario);
    seen = new Map();
    lastCost = 0;
    solved = false;
    hintLevel = 0;
    editing = null;
    out.replaceChildren();
    print(`On call at Quest Kitchen (account ${ACCOUNT}, a simulation). ${scenario.story}`, "dim");
    print("Find out why with the aws CLI, then fix it. Type 'help' for commands, 'hint' if stuck.", "dim");
    print("");
    goal.textContent = "Goal: " + scenario.goal;
    goal.className = "pg-goal";
    renderPicker();
    renderTries();
    renderEditor();
    renderMap();
    renderPrompt();
    const current = picker.querySelector('[aria-pressed="true"]');
    if (current && picker.scrollWidth > picker.clientWidth) picker.scrollLeft = current.offsetLeft - picker.querySelector(".pg-group-name").offsetLeft - 48;
  }

  function check() {
    if (solved || !scenario.won(acct)) return;
    solved = true;
    saved.add(scenario.id);
    renderPicker();
    const b = picker.querySelector('.pg-scn[aria-pressed="true"]');
    if (b) {
      b.classList.add("just-solved");
      b.closest(".pg-group").querySelector(".pg-group-count").classList.add("bump");
    }
    goal.textContent = "Fixed. " + scenario.done;
    goal.className = "pg-goal done";
    print("");
    print("✓ Fixed. " + scenario.lesson, "ok");
    const lv = window.QUEST && window.QUEST.levels.find((l) => l.id === scenario.level);
    if (lv) print(`  Learn more in Level ${lv.id} · ${lv.title}.`, "dim");
    const next = SCENARIOS.find((s) => !saved.get().includes(s.id));
    print(next ? `  Next scenario: ${next.title}. Pick it above, or type 'next'.` : "  You solved every scenario.", "dim");
  }

  function run(raw) {
    const line = raw.trim();
    print(`${acct.session ? "sh-5.2$" : "$"} ${line}`, "cmd");
    if (!line) return;
    if (line === "help") return HELP.forEach((x) => print(x, "dim"));
    if (line === "clear") return out.replaceChildren();
    if (line === "reset") return load(scenario.id);
    if (line === "next") {
      const next = SCENARIOS.find((s) => !saved.get().includes(s.id) && s !== scenario) || SCENARIOS[(SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length];
      setHash(next.id);
      return load(next.id);
    }
    if (line === "hint") return print(scenario.hints[Math.min(hintLevel++, scenario.hints.length - 1)], "dim");
    let result;
    try { result = shell(acct, line); } catch {
      result = [["(the playground could not run that command; check its quoting, or type 'help')", "warn"]];
    }
    for (const [text, cls] of result) print(text, cls);
    renderMap();
    renderPrompt();
    if (scenario.edit && document.activeElement && !document.activeElement.classList.contains("pg-edit")) renderEditor();
    check();
  }

  function complete() {
    const v = input.value;
    const start = v.lastIndexOf(" ") + 1;
    const stem = v.slice(start);
    const before = words(v.slice(0, start));
    const svc = before[0] === "aws" ? before.find((w, n) => n > 0 && !w.startsWith("-")) : null;
    const names = before.length === 1 && before[0] === "aws" ? Object.keys(SERVICES)
      : svc && before.filter((w) => !w.startsWith("-")).length === 2 && SERVICES[svc] ? Object.keys(SERVICES[svc])
        : [...acct.instances.map((i) => i.id), ...acct.sgs.map((g) => g.id), ...Object.keys(acct.buckets).map((b) => "s3://" + b), ...Object.keys(acct.files), ...Object.keys(acct.files).map((f) => "file://" + f),
          ...acct.subnets.map((s) => s.id), ...acct.rts.map((r) => r.id), ...acct.tgs.map((t) => t.arn), "aws", "--profile", "--query", "--output", "--region", "--instance-ids", "--group-id", "--bucket"];
    const hits = [...new Set(names)].filter((n) => n.startsWith(stem) && n !== stem);
    if (hits.length === 1) input.value = v.slice(0, start) + hits[0] + " ";
    else if (hits.length > 1) {
      let common = hits[0];
      for (const x of hits) while (!x.startsWith(common)) common = common.slice(0, -1);
      if (common.length > stem.length) input.value = v.slice(0, start) + common;
      else print(hits.slice(0, 40).join("   "), "dim");
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const value = input.value;
    if (value.trim()) { history.push(value); historyPos = history.length; }
    input.value = "";
    run(value);
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" && historyPos > 0) { historyPos--; input.value = history[historyPos]; ev.preventDefault(); }
    if (ev.key === "ArrowDown") { historyPos = Math.min(history.length, historyPos + 1); input.value = history[historyPos] || ""; ev.preventDefault(); }
    if (ev.key === "Tab" && input.value.trim()) { ev.preventDefault(); complete(); }
  });
  out.addEventListener("click", () => { if (!window.getSelection().toString()) input.focus(); });
  link.addEventListener("click", async () => {
    const url = `${location.href.split("#")[0]}#play/${scenario.id}`;
    try { await navigator.clipboard.writeText(url); link.textContent = "Link copied"; } catch { link.textContent = "Copy failed"; }
    setTimeout(() => { link.textContent = "Copy link"; }, 1400);
  });

  const reveal = () => { term.scrollIntoView({ block: "center" }); input.focus({ preventScroll: true }); };
  window.AQPlayground = {
    scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, group: s.group, story: s.story })),
    load: (id, quiet) => { load(id); setHash(id); if (!quiet) reveal(); },
    // From the cheat sheet: open the scenario a command needs, fill its blanks and run it.
    prefill: (cmd, where) => {
      if (where && where !== "any" && where !== scenario.id) load(where);
      reveal();
      const full = fillBlanks(acct, cmd);
      if (/<[a-z-]+>/.test(full)) input.value = full;
      else run(full);
    }
  };
  load(SCENARIOS[0].id);
})(typeof window !== "undefined" ? window : globalThis);
