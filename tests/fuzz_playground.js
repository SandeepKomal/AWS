// Throws thousands of random and malformed command lines at the simulator.
// Any exception fails the run; every result must be printable lines.
// Run with: node tests/fuzz_playground.js [rounds]
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, Account, shell } = globalThis.AQSim;

let seed = 20261030;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = (list) => list[rand(list.length)];

const SERVICES = ["sts", "iam", "ec2", "elbv2", "autoscaling", "s3", "s3api", "s3control", "kms", "cloudwatch", "logs", "sns", "lambda", "rds", "route53", "route53domains",
  "cloudtrail", "guardduty", "service-quotas", "ce", "ssm", "organizations", "configure", "sso", "nope"];
const WORDS = ["get-caller-identity", "assume-role", "describe-instances", "run-instances", "stop-instances", "start-instances", "terminate-instances", "describe-security-groups",
  "authorize-security-group-ingress", "revoke-security-group-ingress", "create-route", "replace-route", "associate-route-table", "create-nat-gateway", "allocate-address",
  "associate-address", "release-address", "describe-network-acls", "create-network-acl-entry", "describe-target-health", "register-targets", "modify-target-group",
  "ls", "cp", "mb", "rb", "rm", "get-bucket-policy", "put-bucket-policy", "put-public-access-block", "list-object-versions", "delete-object", "copy-object",
  "put-bucket-lifecycle-configuration", "put-key-policy", "get-key-policy", "put-metric-alarm", "describe-alarms", "put-retention-policy", "tail", "invoke",
  "update-function-configuration", "modify-db-instance", "change-resource-record-sets", "update-domain-nameservers", "lookup-events", "start-session", "get-cost-and-usage",
  "put-user-policy", "update-assume-role-policy", "delete-access-key", "update-access-key", "list-access-keys", "simulate-principal-policy", "decode-authorization-message",
  "--instance-ids", "--group-id", "--protocol", "tcp", "-1", "--port", "80", "22", "8080", "1024-65535", "--cidr", "0.0.0.0/0", "10.0.0.0/16", "bad/99", "--source-group",
  "--bucket", "quest-kitchen-assets", "--key", "a/b", "--version-id", "null", "--policy", "--policy-document", "file://trust.json", "file://nope", "'{\"Statement\":[]}'", "'{'",
  "--profile", "admin", "dev", "analyst", "--region", "eu-west-1", "--query", "'Reservations[].Instances[].InstanceId'", "'['", "'length(@)'", "--output", "text", "table",
  "--filters", "Name=tag:Name,Values=web-1", "Name=", "--targets", "Id=i-0,Port=80", "--function-name", "orders-api", "out.json", "--timeout", "0", "901", "15",
  "--db-instance-identifier", "orders-db", "--allocated-storage", "x", "--apply-immediately", "--hosted-zone-id", "Z0", "--change-batch", "--nameservers", "Name=ns-1.example",
  "s3://quest-kitchen-assets", "s3://", "s3://x/y", ".", "--recursive", "--force", "--role-arn", "arn:aws:iam::111122223333:role/x", "--role-session-name", "s",
  "--time-period", "Start=2026-09-01,End=2026-10-01", "--granularity", "MONTHLY", "--metrics", "UnblendedCost", "--group-by", "Type=DIMENSION,Key=SERVICE", "--target",
  "--alarm-name", "--cli-input-json", "--engine-version", "16.4", "--allow-major-version-upgrade", "&&", "||", ";", "|", "grep", "head", "jq", ">", "x.txt", "'", "\"", "\\", "$X", "--"];
const OTHER = ["curl", "curl -I", "dig", "dig +short", "nslookup", "nc -vz", "ssh -i k.pem ec2-user@", "psql -h", "ping", "export X=1", "unset AWS_PROFILE", "env", "cat", "ls", "grep -rn",
  "git log", "git grep AKIA", "exit", "sudo", "X=$(echo hi)", "echo $X"];
const HOSTS = ["shop.example.com", "blog.example.com", "203.0.113.10", "203.0.113.50", "169.254.169.254", "http://169.254.169.254/latest/meta-data/", "api.github.com", "10.0.11.25",
  "orders-db.c3kq8vx0zw1m.us-east-1.rds.amazonaws.com", "nowhere.invalid", "https://quest-kitchen-assets.s3.amazonaws.com/x", "5432", "80", ""];

const rounds = Number(process.argv[2]) || 6000;
let n = 0;
for (let i = 0; i < rounds; i++) {
  const s = SCENARIOS[i % SCENARIOS.length];
  const a = new Account(s);
  for (let j = 0; j < 4; j++) {
    let line;
    const r = rand(10);
    if (r === 0) line = String.fromCharCode(...Array.from({ length: rand(50) }, () => 32 + rand(95)));
    else if (r < 3) line = `${pick(OTHER)} ${pick(HOSTS)} ${pick(HOSTS)}`;
    else if (r === 3) line = pick(s.tries) + " " + pick(WORDS);
    else line = `aws ${pick(SERVICES)} ${Array.from({ length: rand(10) }, () => pick(WORDS)).join(" ")}`;
    try {
      const out = shell(a, line);
      assert.ok(Array.isArray(out));
      for (const l of out) assert.ok(Array.isArray(l) && typeof l[0] === "string", "each line is [text, class]");
      s.won(a);
      s.check(a);
      a.costItems();
    } catch (err) {
      console.error(`scenario ${s.id}, command: ${JSON.stringify(line)}`);
      throw err;
    }
    n++;
  }
}
console.log(`fuzz ok: ${n} commands across ${SCENARIOS.length} scenarios, 0 exceptions`);
