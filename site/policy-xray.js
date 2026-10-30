// Policy X-ray: explains an IAM policy, trust policy, S3 bucket policy or KMS
// key policy statement by statement, in plain words, and flags risky patterns.
// No DOM access, so tests/check_xray.js can run it under Node.
"use strict";

(function (root) {
  const SERVICES = { s3: "S3", ec2: "EC2", iam: "IAM", sts: "STS", kms: "KMS", lambda: "Lambda", dynamodb: "DynamoDB", rds: "RDS", logs: "CloudWatch Logs", cloudwatch: "CloudWatch",
    sqs: "SQS", sns: "SNS", ssm: "Systems Manager", secretsmanager: "Secrets Manager", elasticloadbalancing: "Elastic Load Balancing", autoscaling: "Auto Scaling",
    cloudtrail: "CloudTrail", organizations: "Organizations", route53: "Route 53", ecr: "ECR", ecs: "ECS", eks: "EKS", cloudformation: "CloudFormation", account: "Account" };
  const KNOWN = {
    "s3:GetObject": "download objects", "s3:PutObject": "upload or overwrite objects", "s3:DeleteObject": "delete objects", "s3:ListBucket": "list the objects in a bucket",
    "s3:ListAllMyBuckets": "list every bucket in the account", "s3:GetObjectVersion": "download older versions", "s3:DeleteObjectVersion": "permanently delete object versions",
    "s3:PutBucketPolicy": "replace the bucket policy", "s3:PutBucketPublicAccessBlock": "change Block Public Access", "sts:AssumeRole": "assume this role",
    "sts:AssumeRoleWithWebIdentity": "assume this role with an OIDC token (for example GitHub Actions)", "sts:AssumeRoleWithSAML": "assume this role through SAML single sign-on",
    "iam:PassRole": "give a role to a service such as EC2 or Lambda", "iam:CreateAccessKey": "create access keys", "iam:AttachUserPolicy": "attach policies to users",
    "iam:PutRolePolicy": "write inline policies on roles", "iam:CreatePolicyVersion": "rewrite a managed policy", "kms:Decrypt": "decrypt data with the key",
    "kms:Encrypt": "encrypt data with the key", "kms:GenerateDataKey": "create data keys for encryption", "kms:PutKeyPolicy": "replace the key policy", "kms:CreateGrant": "delegate use of the key",
    "ec2:RunInstances": "launch instances", "ec2:TerminateInstances": "terminate instances", "ec2:StopInstances": "stop instances", "ec2:StartInstances": "start instances",
    "ec2:AuthorizeSecurityGroupIngress": "open inbound security group rules", "lambda:InvokeFunction": "invoke functions", "lambda:UpdateFunctionCode": "replace a function's code",
    "logs:CreateLogStream": "create log streams", "logs:PutLogEvents": "write log events", "secretsmanager:GetSecretValue": "read secret values", "ssm:GetParameter": "read parameters",
    "cloudtrail:StopLogging": "turn audit logging off", "cloudtrail:DeleteTrail": "delete an audit trail"
  };
  const ESCALATE = /^iam:(\*|Create(AccessKey|LoginProfile|PolicyVersion|Role|User)|Attach\w+Policy|Put\w+Policy|Update(AssumeRolePolicy|LoginProfile)|PassRole|AddUserToGroup|SetDefaultPolicyVersion)$/i;
  const RESTRICTING = /aws:(SourceIp|SourceVpce?|PrincipalOrgID|PrincipalAccount|PrincipalArn|SourceArn|SourceAccount)|sts:ExternalId|token\.actions\.githubusercontent\.com:sub|kms:ViaService|kms:CallerAccount/i;
  const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const words = (camel) => camel.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

  function explainAction(a) {
    const s = String(a);
    if (s === "*") return "every action in every AWS service";
    const [svc, name = ""] = s.split(":");
    const service = SERVICES[svc.toLowerCase()] || svc;
    if (name === "*") return `every ${service} action`;
    if (KNOWN[s]) return `${service}: ${KNOWN[s]}`;
    if (name.includes("*")) return `${service}: every action matching ${name}`;
    return `${service}: ${words(name)}`;
  }
  function explainPrincipal(p) {
    if (p === "*") return "anyone, including anonymous users on the internet";
    const out = [];
    for (const a of list(p.AWS)) {
      if (a === "*") out.push("any AWS principal in any account");
      else if (/^\d{12}$/.test(a) || /:root$/.test(a)) out.push(`account ${String(a).replace(/\D+/g, "").slice(0, 12)} (whoever that account's IAM policies allow)`);
      else if (/^A(IDA|ROA)/.test(a)) out.push(`${a}, a unique ID: the user or role it named has been deleted`);
      else out.push(String(a).replace(/^arn:aws:iam::\d+:/, ""));
    }
    for (const s of list(p.Service)) out.push(`the ${s.replace(".amazonaws.com", "")} service`);
    for (const f of list(p.Federated)) out.push(/token\.actions\.githubusercontent\.com/.test(f) ? "GitHub Actions through OIDC" : /saml-provider/.test(f) ? "a SAML identity provider" : f);
    return out.join(", ") || "nobody (empty principal)";
  }
  function explainCondition(op, key, val) {
    const v = list(val).join(", ");
    const neg = /Not/.test(op);
    if (/SecureTransport/i.test(key)) return `only when the request ${v === "false" ? "does not use" : "uses"} HTTPS`;
    if (/SourceIp/i.test(key)) return `only from IP addresses ${neg ? "outside" : "in"} ${v}`;
    if (/MultiFactorAuthPresent/i.test(key)) return `only when the caller ${v === "true" ? "signed in with" : "did not use"} MFA`;
    if (/RequestedRegion/i.test(key)) return `only when the Region is ${neg ? "not " : ""}${v}`;
    if (/PassedToService/i.test(key)) return `only when the role is given to ${v}`;
    if (/ResourceTag\/(.+)/i.test(key)) return `only for resources whose tag ${key.split("/")[1]} is ${neg ? "not " : ""}${v}`;
    if (/PrincipalOrgID/i.test(key)) return `only for principals in organization ${v}`;
    if (/ExternalId/i.test(key)) return `only when the caller passes external ID ${v}`;
    if (/githubusercontent\.com:sub/i.test(key)) return `only for GitHub workflows whose subject matches ${v}`;
    if (/githubusercontent\.com:aud/i.test(key)) return `only for tokens issued for audience ${v}`;
    if (/ViaService/i.test(key)) return `only when the request comes through ${v}`;
    return `only when ${key} ${op.replace(/IfExists$/, " (if present)").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} ${v}`;
  }

  // Risks in one statement, as [line key, message] pairs.
  function risks(st, kind) {
    const out = [];
    if (st.Effect !== "Allow") return out;
    const actions = list(st.Action).map(String);
    const res = list(st.Resource).map(String);
    const cond = JSON.stringify(st.Condition || {});
    const restricted = RESTRICTING.test(cond);
    const allRes = res.includes("*") || st.NotResource !== undefined;
    if (actions.includes("*") && allRes) out.push(["Action", "Allows every action on every resource: this is administrator access. Grant the actions the job needs instead."]);
    else if (actions.includes("*")) out.push(["Action", "\"*\" allows every action in every service on these resources."]);
    if (st.NotAction !== undefined) out.push(["NotAction", "Allow with NotAction grants everything except the listed actions, including services AWS adds later. List what you allow instead."]);
    if (st.NotResource !== undefined) out.push(["NotResource", "Allow with NotResource applies to every resource except those listed, including ones created later."]);
    for (const a of actions) {
      if (/^[a-z0-9-]+:\*$/i.test(a) && a !== "*") out.push(["Action", `${a} allows every ${SERVICES[a.split(":")[0]] || a.split(":")[0]} action, including deletes and permission changes.`]);
      if (ESCALATE.test(a) && a !== "iam:PassRole" && allRes) out.push(["Action", `${a} on all resources lets the holder grant themselves more permissions (privilege escalation).`]);
    }
    if (actions.some((a) => /^(iam:PassRole|iam:\*|\*)$/i.test(a)) && allRes) out.push(["Resource", "iam:PassRole on \"*\" lets the holder hand any role, an admin role included, to EC2, Lambda or ECS. Name the roles, and add iam:PassedToService."]);
    else if (actions.some((a) => /^iam:PassRole$/i.test(a)) && !/PassedToService/.test(cond)) out.push(["Action", "iam:PassRole without an iam:PassedToService condition lets the role be given to any service."]);
    if (actions.some((a) => /^s3:\*$/i.test(a)) && res.some((r) => r === "*" || r === "arn:aws:s3:::*" || r === "arn:aws:s3:::*/*")) out.push(["Resource", "s3:* on all buckets: read, write, delete and change policies on every bucket in the account."]);
    if (kind === "identity" && actions.some((a) => /^kms:(\*|Decrypt|ReEncrypt\*|GenerateDataKey\*?)$/i.test(a)) && res.includes("*")) out.push(["Resource", "KMS on \"*\" covers every key whose key policy delegates to IAM. Name the key ARNs."]);
    if (kind === "identity" && allRes && !actions.includes("*") && actions.some((a) => /:(Delete|Put|Create|Update|Terminate|Attach|Modify)/.test(a)) && !st.Condition) out.push(["Resource", "Write actions on \"*\" apply to every resource of that type in the account. Scope the Resource or add a condition."]);
    const P = st.Principal;
    const publicP = P === "*" || list((P || {}).AWS).includes("*");
    if (publicP && !restricted) out.push(["Principal", kind === "trust" ? "Principal \"*\" lets anyone in any AWS account assume this role." : "Principal \"*\" with no restricting condition makes this public: anyone on the internet."]);
    if (kind === "trust") {
      for (const f of list((P || {}).Federated)) if (/githubusercontent/.test(f)) {
        const sub = ((st.Condition || {}).StringLike || {})["token.actions.githubusercontent.com:sub"] || ((st.Condition || {}).StringEquals || {})["token.actions.githubusercontent.com:sub"];
        if (!sub) out.push(["Condition", "A GitHub OIDC trust with no sub condition lets any repository on GitHub assume this role."]);
        else if (list(sub).some((x) => /^(\*|repo:\*|repo:[^/]+\/\*)/.test(x))) out.push(["Condition", `sub ${list(sub).join(", ")} matches repositories you do not control or every repository of an owner. Name the repository and branch.`]);
      }
      for (const a of list((P || {}).AWS)) {
        const acct = (/^(\d{12})$/.exec(a) || /^arn:aws:iam::(\d{12}):root$/.exec(a) || [])[1];
        if (acct && !/ExternalId/.test(cond)) out.push(["Principal", `Trusts all of account ${acct}. For a third party, require sts:ExternalId; for your own accounts, name the role.`]);
      }
    }
    if (kind === "key" && actions.some((a) => /^kms:\*$/.test(a)) && list((P || {}).AWS).some((a) => /:root$/.test(a))) out.push(["Action", "kms:* for the account root delegates the key to IAM: any principal whose IAM policy allows KMS can use it. That is the default key policy; check your IAM policies are scoped."]);
    return out;
  }

  // Plain words for one whole statement.
  function summary(st, kind) {
    const verb = st.Effect === "Deny" ? "Denies" : "Allows";
    const acts = st.NotAction !== undefined ? `everything except ${list(st.NotAction).join(", ")}` : list(st.Action).map(explainAction).join("; ");
    const who = st.Principal !== undefined ? ` for ${explainPrincipal(st.Principal)}` : kind === "identity" ? " for whoever has this policy" : "";
    const res = st.NotResource !== undefined ? `every resource except ${list(st.NotResource).join(", ")}` : list(st.Resource).includes("*") ? "all resources" : list(st.Resource).join(", ");
    const cond = Object.entries(st.Condition || {}).flatMap(([op, blk]) => Object.entries(blk || {}).map(([k, v]) => explainCondition(op, k, v)));
    return `${verb} ${acts}${who}${st.Resource !== undefined || st.NotResource !== undefined ? ` on ${res}` : ""}${cond.length ? `, ${cond.join(" and ")}` : ""}.`;
  }

  function kindOf(d) {
    const sts = list(d.Statement);
    if (sts.some((s) => s && list(s.Action).concat(list(s.NotAction)).some((a) => /^sts:AssumeRole/.test(a))) && sts.every((s) => s && s.Principal && s.Resource === undefined)) return "trust";
    if (sts.some((s) => s && s.Principal !== undefined)) {
      if (sts.some((s) => list(s.Resource).some((r) => /^arn:aws:s3:::/.test(r)))) return "bucket";
      if (sts.some((s) => list(s.Action).some((a) => /^kms:/.test(a)))) return "key";
      return "resource";
    }
    return "identity";
  }
  const KIND_NAMES = { trust: "Role trust policy", bucket: "S3 bucket policy", key: "KMS key policy", resource: "Resource-based policy", identity: "Identity-based policy" };

  function explain(text) {
    let d;
    try { d = JSON.parse(String(text)); } catch (e) { return { error: `This is not valid JSON: ${e.message}. Policies are JSON documents that start with {.` }; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return { error: "A policy is a JSON object with a Statement, like {\"Version\": \"2012-10-17\", \"Statement\": [...]}." };
    if (d.Statement === undefined) return { error: "No Statement found. Paste the policy document itself, not the CLI output around it (for get-role, use --query Role.AssumeRolePolicyDocument)." };
    const kind = kindOf(d);
    const lines = [];
    const review = [];
    const add = (line, note, warns = []) => lines.push({ line, note, warns, level: note ? "known" : "unknown" });
    const q = (v) => JSON.stringify(v);
    add("{", `${KIND_NAMES[kind]}. Select a line to read what it does.`);
    if (d.Version !== undefined) add(`  "Version": ${q(d.Version)},`, d.Version === "2012-10-17" ? "The current policy language version. Always use it." : "An old policy language version: policy variables such as ${aws:username} are not supported.",
      d.Version === "2012-10-17" ? [] : ["Use \"Version\": \"2012-10-17\"."]);
    else review.push("No Version. Without \"Version\": \"2012-10-17\" the old language applies and policy variables do not work.");
    if (d.Id !== undefined) add(`  "Id": ${q(d.Id)},`, "An optional identifier for the whole policy.");
    const statements = list(d.Statement);
    add(`  "Statement": [`, `${statements.length} statement${statements.length === 1 ? "" : "s"}. Each one is checked on its own; an explicit Deny in any statement wins.`);
    let risky = 0;
    statements.forEach((st, n) => {
      if (!st || typeof st !== "object") { add(`    ${q(st)}${n < statements.length - 1 ? "," : ""}`, null, ["This statement is not an object."]); return; }
      const r = risks(st, kind);
      if (r.length) risky++;
      const atKey = (k) => r.filter(([key]) => key === k).map(([, m]) => m);
      add("    {", `Statement ${n + 1}: ${summary(st, kind)}`);
      const keys = Object.keys(st);
      keys.forEach((k, i) => {
        const comma = i < keys.length - 1 ? "," : "";
        const v = st[k];
        const head = `      "${k}": `;
        if (k === "Sid") return add(head + q(v) + comma, "A label for this statement. It has no effect on access, but makes reviews and errors easier to follow.");
        if (k === "Effect") return add(head + q(v) + comma, v === "Allow" ? "Allow grants access when everything else in the statement matches." : v === "Deny" ? "Deny blocks access and overrides any Allow, anywhere." : "Effect must be Allow or Deny.", v === "Allow" || v === "Deny" ? [] : ["Effect must be \"Allow\" or \"Deny\"."]);
        if (k === "Action" || k === "NotAction" || k === "Resource" || k === "NotResource") {
          const label = { Action: "What it covers", NotAction: "Everything except", Resource: "Which resources", NotResource: "Every resource except" }[k];
          const explainOne = (x) => (k.endsWith("Action") ? explainAction(x) : x === "*" ? "every resource" : String(x).replace(/^arn:aws:s3:::([^/]+)$/, "the bucket $1 itself (bucket-level actions)").replace(/^arn:aws:s3:::([^/]+)\/(.*)$/, "objects in $1 matching $2"));
          if (!Array.isArray(v)) return add(head + q(v) + comma, `${label}: ${explainOne(v)}.`, atKey(k));
          add(head + "[", `${label}: ${v.length} entr${v.length === 1 ? "y" : "ies"}.`, atKey(k));
          v.forEach((x, j) => add(`        ${q(x)}${j < v.length - 1 ? "," : ""}`, `${explainOne(x)}.`));
          return add(`      ]${comma}`, null);
        }
        if (k === "Principal" || k === "NotPrincipal") {
          if (typeof v !== "object" || v === null) return add(head + q(v) + comma, `${k === "Principal" ? "Who" : "Everyone except"}: ${explainPrincipal(v)}.`, atKey("Principal"));
          add(head + "{", `${k === "Principal" ? "Who" : "Everyone except"}: ${explainPrincipal(v)}.`, atKey("Principal"));
          Object.entries(v).forEach(([t, ids], j, all) => add(`        "${t}": ${q(ids)}${j < all.length - 1 ? "," : ""}`, { AWS: "AWS accounts, users or roles.", Service: "AWS services, which act on your behalf.", Federated: "An external identity provider (SAML or OIDC)." }[t] || "A principal type."));
          return add(`      }${comma}`, null);
        }
        if (k === "Condition") {
          add(head + "{", "Conditions: the statement applies only when all of them hold.", atKey("Condition"));
          Object.entries(v || {}).forEach(([op, blk], j, all) => {
            add(`        "${op}": {`, `The ${op} operator.`);
            Object.entries(blk || {}).forEach(([ck, cv], m, cs) => add(`          "${ck}": ${q(cv)}${m < cs.length - 1 ? "," : ""}`, `Applies ${explainCondition(op, ck, cv)}.`));
            add(`        }${j < all.length - 1 ? "," : ""}`, null);
          });
          return add(`      }${comma}`, null);
        }
        return add(head + q(v) + comma, null, [`"${k}" is not a policy element; IAM rejects the policy.`]);
      });
      const placed = new Set(["Action", "NotAction", "Resource", "NotResource", "Principal", "Condition"].filter((k) => keys.includes(k)));
      const orphan = r.filter(([key]) => !placed.has(key)).map(([, m]) => m);
      lines[lines.findIndex((l, i) => l.line === "    {" && lines.slice(0, i).filter((x) => x.line === "    {").length === n)].warns.push(...orphan);
      add(`    }${n < statements.length - 1 ? "," : ""}`, null);
      if (!st.Sid) review.push(`Statement ${n + 1} has no Sid. A short name helps reviews and error messages.`);
      if (kind !== "identity" && kind !== "trust" && st.Principal === undefined && st.NotPrincipal === undefined) review.push(`Statement ${n + 1} has no Principal; a ${KIND_NAMES[kind].toLowerCase()} needs one.`);
      if (kind === "identity" && (st.Principal || st.NotPrincipal)) review.push(`Statement ${n + 1} has a Principal; identity-based policies must not (IAM rejects them).`);
      if (kind !== "trust" && st.Resource === undefined && st.NotResource === undefined) review.push(`Statement ${n + 1} has no Resource; IAM rejects it.`);
    });
    add("  ]", null);
    add("}", null);
    if (kind === "bucket" && !statements.some((s) => s && s.Effect === "Deny" && /SecureTransport/.test(JSON.stringify(s.Condition || {})))) review.push("No statement denies plain HTTP. Many teams add a Deny for \"aws:SecureTransport\": \"false\".");
    if (kind === "key" && !statements.some((s) => s && list(s.Action).some((a) => /^kms:(\*|PutKeyPolicy)$/.test(a)))) review.push("No statement lets anyone manage the key. KMS refuses such a policy, because it would lock everyone out.");
    if (kind === "identity" && statements.every((s) => s && !s.Condition)) review.push("No statement has a Condition. Conditions on tags, Regions or source VPCs are a cheap way to narrow access.");
    for (const l of lines) if (l.warns.length && l.note === null) l.note = "";
    return { kind: KIND_NAMES[kind], lines, review, risky, statements: statements.length };
  }

  root.AQPolicy = { explain, explainAction, explainPrincipal };
})(typeof window !== "undefined" ? window : globalThis);
