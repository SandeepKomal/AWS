// Checks the Policy X-ray: every statement gets plain words, the risky
// patterns are flagged, good policies stay quiet, bad input gets a clear
// message, and the examples taken from this repository match their file.
// Run with: node tests/check_xray.js
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
global.window = {};
require(path.join(root, "site/policy-xray.js"));
require(path.join(root, "site/data.js"));
const { explain } = window.AQPolicy;
const Q = window.TRACK;
const run = (d) => explain(JSON.stringify(d));
const warnings = (r) => r.lines.flatMap((l) => l.warns).join("\n");
const doc = (...Statement) => ({ Version: "2012-10-17", Statement });

// Every risky pattern the brief names is flagged.
const flags = [
  [doc({ Effect: "Allow", Action: "*", Resource: "*" }), /administrator access/],
  [doc({ Effect: "Allow", Action: "s3:*", Resource: "*" }), /s3:\* on all buckets/],
  [doc({ Effect: "Allow", Action: "iam:PassRole", Resource: "*" }), /iam:PassRole on "\*"/],
  [doc({ Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::111122223333:role/web" }), /without an iam:PassedToService condition/],
  [doc({ Effect: "Allow", NotAction: "iam:*", Resource: "*" }), /Allow with NotAction/],
  [doc({ Effect: "Allow", Action: "s3:GetObject", NotResource: "arn:aws:s3:::secret/*" }), /Allow with NotResource/],
  [doc({ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/*" }), /public: anyone on the internet/],
  [doc({ Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" }), /anyone in any AWS account assume this role/],
  [doc({ Effect: "Allow", Action: "kms:Decrypt", Resource: "*" }), /KMS on "\*" covers every key/],
  [doc({ Effect: "Allow", Action: "iam:AttachUserPolicy", Resource: "*" }), /privilege escalation/],
  [doc({ Effect: "Allow", Action: "ec2:TerminateInstances", Resource: "*" }), /Write actions on "\*"/],
  [doc({ Effect: "Allow", Principal: { Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" }, Action: "sts:AssumeRoleWithWebIdentity" }), /no sub condition/],
  [doc({ Effect: "Allow", Principal: { Federated: "arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com" }, Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringLike: { "token.actions.githubusercontent.com:sub": "repo:*" } } }), /repositories you do not control/],
  [doc({ Effect: "Allow", Principal: { AWS: "444455556666" }, Action: "sts:AssumeRole" }), /require sts:ExternalId/]
];
for (const [d, re] of flags) assert.match(warnings(run(d)), re, `${JSON.stringify(d)} should warn ${re}`);

// Scoped policies stay quiet, and conditions are read aloud.
const scoped = run(Q.xray.find((x) => x.name === "Scoped deploy policy").text);
assert.strictEqual(warnings(scoped), "", "a scoped policy has no warnings");
assert.match(scoped.lines.map((l) => l.note).join("\n"), /only when the role is given to ec2\.amazonaws\.com/);
const tls = run(doc({ Sid: "DenyHttp", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: ["arn:aws:s3:::b", "arn:aws:s3:::b/*"], Condition: { Bool: { "aws:SecureTransport": "false" } } }));
assert.strictEqual(tls.kind, "S3 bucket policy");
assert.match(tls.lines[2].note + tls.lines.map((l) => l.note).join(" "), /Denies every S3 action for anyone.*only when the request does not use HTTPS/);
assert.strictEqual(warnings(tls), "", "a TLS deny is not risky");

// Kinds, line notes and the review.
assert.strictEqual(run(doc({ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" })).kind, "Role trust policy");
assert.strictEqual(run(doc({ Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:root" }, Action: "kms:*", Resource: "*" })).kind, "KMS key policy");
const old = run({ Version: "2008-10-17", Statement: { Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::b" } });
assert.match(warnings(old), /2012-10-17/);
assert.match(old.lines.map((l) => l.note).join("\n"), /the bucket b itself/);
assert.match(run({ Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] }).review.join(" "), /No Version/);
assert.match(run(doc({ Effect: "Allow", Principal: { AWS: "x" }, Action: "s3:GetObject", Resource: "*" }, { Effect: "Allow", Action: "s3:GetObject", Resource: "*" })).review.join(" "), /no Sid/);
assert.match(run(doc({ Effect: "Allow", Action: "s3:GetObject", Resource: "*", Bogus: 1 })).lines.map((l) => l.warns.join(" ")).join(" "), /"Bogus" is not a policy element/);
assert.match(run(doc({ Effect: "Allow", Principal: { AWS: "AIDAEXAMPLEDELETED1" }, Action: "sts:AssumeRole" })).lines.map((l) => l.note).join(" "), /has been deleted/);
const ex = run(Q.xrayExample);
assert.ok(ex.risky >= 4, "the example has several risky statements");
for (const l of ex.lines) assert.ok(l.note !== undefined && Array.isArray(l.warns), "every line has a note slot and warnings");

// Bad input gets a clear message, never an exception.
assert.match(explain("{oops").error, /not valid JSON/);
assert.match(explain("[1,2]").error, /JSON object/);
assert.match(explain('{"Role": {}}').error, /No Statement found/);
for (const junk of ["", "null", "1", '{"Statement": null}', '{"Statement": [null, 3, "x"]}', '{"Statement": {"Effect": "Allow", "Action": [1, null], "Resource": {}, "Condition": {"X": null}}}', '{"Statement": [{"Principal": {"AWS": [null]}}]}']) {
  const r = explain(junk);
  assert.ok(r.error || Array.isArray(r.lines), `junk ${junk} handled`);
}

// The examples credited to this repository match the template they come from.
const yaml = fs.readFileSync(path.join(root, "AWS/IAM/S3FullAccess"), "utf8");
for (const x of Q.xray.filter((e) => e.path)) {
  assert.ok(fs.existsSync(path.join(root, x.path)), `${x.path} exists`);
  for (const st of x.text.Statement) {
    for (const a of [].concat(st.Action)) assert.ok(yaml.includes(`'${a}'`), `${x.name}: action ${a} is in ${x.path}`);
    for (const svc of [].concat((st.Principal || {}).Service || [])) assert.ok(yaml.includes(svc), `${x.name}: ${svc} is in ${x.path}`);
    if (st.Resource) assert.match(yaml, /Resource: '\*'/);
  }
}
console.log(`x-ray ok: ${flags.length} risky patterns flagged, examples match their files`);
