// Drives the site's AWS simulator without a browser: every scenario starts
// broken, the tempting wrong moves keep it broken, and the intended fix solves it.
// Run with: node tests/check_playground.js
"use strict";
const path = require("path");
const assert = require("assert");

require(path.resolve(__dirname, "../site/playground.js"));
const { SCENARIOS, GROUPS, Account, shell, lex, query, textOut, ACCOUNT } = globalThis.AQSim;

const fresh = (id) => new Account(SCENARIOS.find((s) => s.id === id));
const run = (a, cmd) => shell(a, cmd).map(([t]) => t).join("\n");
const won = (a) => a.scenario.won(a);
const broken = (a, why) => assert.ok(!won(a), why);
const fixed = (a, why) => assert.ok(won(a), why);
const id = (a, kind, name) => ({ i: a.inst(name) && a.inst(name).id, sg: a.sgId(name), subnet: a.sub(name) && a.sub(name).id, rtb: a.rt(name) && a.rt(name).id, tg: a.tg(name) && a.tg(name).arn }[kind]);
const edit = (a, file, fn) => { a.files[file] = JSON.stringify(fn(JSON.parse(a.files[file])), null, 2); };
const AMI = "ami-0c02fb55b34e7ea4f";

// The command line and --query.
assert.deepStrictEqual(lex(`aws s3 ls "a b" && echo 'x y' | grep x`).map((t) => t.w || t.op), ["aws", "s3", "ls", "a b", "&&", "echo", "x y", "|", "grep", "x"]);
assert.strictEqual(lex(`echo "open`), null);
const data = { Reservations: [{ Instances: [{ InstanceId: "i-1", State: { Name: "running" }, Tags: [{ Key: "Name", Value: "web" }] }] }, { Instances: [{ InstanceId: "i-2", State: { Name: "stopped" }, Tags: [] }] }] };
assert.deepStrictEqual(query("Reservations[].Instances[].InstanceId", data), ["i-1", "i-2"]);
assert.deepStrictEqual(query("Reservations[].Instances[?State.Name=='running'].InstanceId[]", data), ["i-1"]);
assert.deepStrictEqual(query("Reservations[].Instances[].[InstanceId,Tags[?Key==`Name`]|[0].Value]", data), [["i-1", "web"], ["i-2", null]]);
assert.deepStrictEqual(query("Reservations[0].Instances[0].{Id: InstanceId, S: State.Name}", data), { Id: "i-1", S: "running" });
assert.strictEqual(query("length(Reservations)", data), 2);
assert.throws(() => query("Reservations[", data));
assert.deepStrictEqual(textOut({ Account: "1", Arn: "a", UserId: "u" }), ["1\ta\tu"]);
assert.deepStrictEqual(textOut([["i-1", "web"], ["i-2", null]]), ["i-1\tweb", "i-2\tNone"]);

// Every scenario: complete, broken at the start, and its Try commands print something.
const ids = SCENARIOS.map((s) => s.id);
assert.strictEqual(new Set(ids).size, ids.length, "scenario ids are unique");
assert.deepStrictEqual(GROUPS.flatMap(([, g]) => g).sort(), [...ids].sort(), "every scenario is in exactly one group");
assert.ok(SCENARIOS.length >= 30, "at least 30 scenarios");
for (const s of SCENARIOS) {
  const a = new Account(s);
  broken(a, `${s.id}: must start broken`);
  assert.strictEqual(s.hints.length, 3, `${s.id}: three hints`);
  assert.ok(s.story && s.goal && s.done && s.lesson && s.level && s.title && s.group, `${s.id}: story, goal, done, lesson, level`);
  assert.ok(s.check(a).label && s.check(a).text, `${s.id}: live status check`);
  for (const f of s.edit || []) assert.ok(a.files[f], `${s.id}: editor file ${f} exists`);
  for (const cmd of [...s.tries, "aws sts get-caller-identity --profile admin", "aws ec2 describe-instances", "aws s3 ls"]) {
    const out = run(a, cmd);
    assert.ok(out.length > 0, `${s.id}: "${cmd}" prints something`);
    assert.doesNotMatch(out, /Found invalid choice|could not run that command|command not found/, `${s.id}: "${cmd}" is modelled: ${out}`);
  }
}

let a;

// IAM and access
a = fresh("expired");
assert.match(run(a, "aws sts get-caller-identity"), /An error occurred \(ExpiredToken\) when calling the GetCallerIdentity operation: The security token included in the request is expired/);
assert.match(run(a, "aws configure list"), /access_key\s+\*{16}\w{4}\s+env/);
run(a, "aws sso login");
broken(a, "sso login alone: env vars still win");
run(a, "aws configure set aws_access_key_id AKIAEXAMPLE");
broken(a, "configure set: env vars still win");
a = fresh("expired");
assert.match(run(a, "aws sso login --profile default"), /Successfully logged into Start URL/);
run(a, "unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN");
fixed(a, "expired: unset and log in");
assert.match(run(a, "aws sts get-caller-identity"), /"Arn": "arn:aws:sts::111122223333:assumed-role\/PlatformAdmin\/you"/);

a = fresh("s3list");
assert.match(run(a, "aws s3 ls s3://nimbus-kitchen-reports --profile analyst"), /An error occurred \(AccessDenied\) when calling the ListObjectsV2 operation: User: arn:aws:iam::111122223333:user\/analyst is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::nimbus-kitchen-reports" because no identity-based policy allows the s3:ListBucket action/);
assert.match(run(a, "aws s3 cp s3://nimbus-kitchen-reports/monthly/2026-10.csv . --profile analyst"), /download: s3:\/\/nimbus-kitchen-reports\/monthly\/2026-10.csv to .\/2026-10.csv/);
run(a, "aws iam attach-user-policy --user-name analyst --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess");
assert.match(run(a, "aws s3 ls s3://nimbus-kitchen-reports --profile analyst"), /PRE monthly\//);
broken(a, "AmazonS3ReadOnlyAccess also opens payroll");
run(a, "aws iam detach-user-policy --user-name analyst --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess");
assert.match(run(a, "aws iam put-user-policy --user-name analyst --policy-name x --policy-document '{bad'"), /MalformedPolicyDocument\) when calling the PutUserPolicy operation: Syntax errors in policy/);
assert.match(run(a, "aws iam put-user-policy --user-name analyst --policy-name x --policy-document file://nope.json"), /Unable to load paramfile file:\/\/nope.json: \[Errno 2\] No such file or directory: 'nope.json'/);
edit(a, "reports-read.json", (d) => ({ ...d, Statement: [...d.Statement, { Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::nimbus-kitchen-reports" }] }));
assert.strictEqual(run(a, "aws iam put-user-policy --user-name analyst --policy-name reports-read --policy-document file://reports-read.json"), "");
fixed(a, "s3list: ListBucket on the bucket ARN");

a = fresh("explicitdeny");
const devbox = id(a, "i", "dev-box");
const enc = /Encoded authorization failure message: (\S+)/.exec(run(a, `aws ec2 stop-instances --instance-ids ${devbox} --profile oncall`))[1];
assert.match(run(a, `aws sts decode-authorization-message --encoded-message ${enc} --query DecodedMessage --output text`), /"explicitDeny":true.*"action":"ec2:StopInstances"/);
run(a, "aws iam attach-user-policy --user-name oncall --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
broken(a, "admin does not beat an explicit deny");
run(a, "aws iam delete-user-policy --user-name oncall --policy-name protect-prod");
broken(a, "removing the guard rail unprotects production");
a = fresh("explicitdeny");
edit(a, "protect-prod.json", (d) => { d.Statement[0].Condition = { StringEquals: { "aws:ResourceTag/env": "prod" } }; return d; });
run(a, "aws iam put-user-policy --user-name oncall --policy-name protect-prod --policy-document file://protect-prod.json");
fixed(a, "explicitdeny: scoped deny");
assert.match(run(a, `aws ec2 stop-instances --instance-ids ${devbox} --profile oncall`), /"Name": "stopping"/);

a = fresh("trust");
const assume = "aws sts assume-role --role-arn arn:aws:iam::111122223333:role/deploy-role --role-session-name deploy --profile ci";
assert.match(run(a, assume), /AccessDenied\) when calling the AssumeRole operation: User: arn:aws:iam::111122223333:user\/ci-bot is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::111122223333:role\/deploy-role/);
assert.match(run(a, "aws iam get-role --role-name deploy-role"), /"AWS": "AIDA\w+EXAMPLE"/);
run(a, "aws iam attach-user-policy --user-name ci-bot --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
broken(a, "admin on the caller does not satisfy the trust policy");
edit(a, "trust.json", (d) => { d.Statement[0].Principal = { AWS: "*" }; return d; });
run(a, "aws iam update-assume-role-policy --role-name deploy-role --policy-document file://trust.json");
broken(a, "trusting * lets anyone in");
edit(a, "trust.json", (d) => { d.Statement[0].Principal = { AWS: "arn:aws:iam::111122223333:user/ci-runner" }; return d; });
assert.match(run(a, "aws iam update-assume-role-policy --role-name deploy-role --policy-document file://trust.json"), /MalformedPolicyDocument\) when calling the UpdateAssumeRolePolicy operation: Invalid principal in policy: "AWS":"arn:aws:iam::111122223333:user\/ci-runner"/);
a = fresh("trust");
edit(a, "trust.json", (d) => { d.Statement[0].Principal = { AWS: "arn:aws:iam::111122223333:user/ci-bot" }; return d; });
run(a, "aws iam update-assume-role-policy --role-name deploy-role --policy-document file://trust.json");
fixed(a, "trust: names ci-bot");
assert.match(run(a, assume), /"AccessKeyId": "ASIA\w{16}"[\s\S]*"Arn": "arn:aws:sts::111122223333:assumed-role\/deploy-role\/deploy"/);

a = fresh("oidc");
const wi = "aws sts assume-role-with-web-identity --role-arn arn:aws:iam::111122223333:role/gh-deploy --role-session-name gh --web-identity-token file://token-claims.json";
assert.match(run(a, wi), /AccessDenied\) when calling the AssumeRoleWithWebIdentity operation: Not authorized to perform sts:AssumeRoleWithWebIdentity/);
edit(a, "trust.json", (d) => { d.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] = "repo:*"; return d; });
run(a, "aws iam update-assume-role-policy --role-name gh-deploy --policy-document file://trust.json");
broken(a, "repo:* trusts every repository on GitHub");
edit(a, "trust.json", (d) => { d.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] = "repo:SandeepKomal/nimbus-kitchen:*"; return d; });
run(a, "aws iam update-assume-role-policy --role-name gh-deploy --policy-document file://trust.json");
broken(a, "repo:...:* also trusts pull requests");
edit(a, "trust.json", (d) => { d.Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] = "repo:SandeepKomal/nimbus-kitchen:ref:refs/heads/main"; return d; });
run(a, "aws iam update-assume-role-policy --role-name gh-deploy --policy-document file://trust.json");
fixed(a, "oidc: exact repository and branch");
assert.match(run(a, wi), /"SubjectFromWebIdentityToken": "repo:SandeepKomal\/nimbus-kitchen:ref:refs\/heads\/main"/);

a = fresh("passrole");
const launch = `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id ${id(a, "subnet", "private-a")} --iam-instance-profile Name=web-role --profile dev`;
const pr = /Encoded authorization failure message: (\S+)/.exec(run(a, launch))[1];
assert.match(run(a, `aws sts decode-authorization-message --encoded-message ${pr} --profile dev`), /iam:PassRole.*role\/web-role/);
edit(a, "dev-ec2.json", (d) => ({ ...d, Statement: [...d.Statement, { Effect: "Allow", Action: "iam:PassRole", Resource: "*" }] }));
run(a, "aws iam put-user-policy --user-name dev --policy-name dev-ec2 --policy-document file://dev-ec2.json");
assert.match(run(a, launch), /"State": \{\s*"Code": 0,\s*"Name": "pending"/);
broken(a, "PassRole on * lets dev pass break-glass");
a = fresh("passrole");
edit(a, "dev-ec2.json", (d) => ({ ...d, Statement: [...d.Statement, { Effect: "Allow", Action: "iam:PassRole", Resource: "arn:aws:iam::111122223333:role/web-role" }] }));
run(a, "aws iam put-user-policy --user-name dev --policy-name dev-ec2 --policy-document file://dev-ec2.json");
broken(a, "allowed, but not launched yet");
run(a, launch);
fixed(a, "passrole: scoped PassRole and launched");

a = fresh("scp");
assert.match(run(a, "aws s3 mb s3://nimbus-kitchen-archive-eu --region eu-central-1"), /make_bucket failed: s3:\/\/nimbus-kitchen-archive-eu An error occurred \(AccessDenied\) when calling the CreateBucket operation: .* with an explicit deny in a service control policy/);
assert.match(run(a, "aws organizations list-policies --filter SERVICE_CONTROL_POLICY"), /AccessDeniedException\) when calling the ListPolicies operation: You don't have permissions to access this resource/);
run(a, "aws s3 mb s3://nimbus-kitchen-archive-eu --region ap-south-1");
broken(a, "ap-south-1 is denied too");
assert.strictEqual(run(a, "aws s3 mb s3://nimbus-kitchen-archive-eu --region eu-west-1"), "make_bucket: nimbus-kitchen-archive-eu");
fixed(a, "scp: allowed Region");

// Networking
a = fresh("sgweb");
assert.match(run(a, "curl -m 5 http://blog.example.com"), /curl: \(28\) Failed to connect to blog.example.com port 80 after 5000 ms: Couldn't connect to server/);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "blog-sg")} --protocol -1 --cidr 0.0.0.0/0`);
assert.match(run(a, "curl http://blog.example.com"), /Kitchen notes/);
broken(a, "all traffic from 0.0.0.0/0");
assert.match(run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "blog-sg")} --protocol -1 --cidr 0.0.0.0/0`), /InvalidPermission.Duplicate/);
run(a, `aws ec2 revoke-security-group-ingress --group-id ${id(a, "sg", "blog-sg")} --protocol -1 --cidr 0.0.0.0/0`);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "blog-sg")} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
fixed(a, "sgweb: port 80 only");

a = fresh("nopublicip");
assert.match(run(a, "aws ec2 describe-instances --filters Name=tag:Name,Values=blog --query 'Reservations[].Instances[].[PrivateIpAddress,PublicIpAddress]' --output text"), /^10\.0\.1\.30\tNone$/);
run(a, `aws ec2 stop-instances --instance-ids ${id(a, "i", "blog")}`); run(a, "echo"); run(a, `aws ec2 start-instances --instance-ids ${id(a, "i", "blog")}`); run(a, "echo");
broken(a, "stop/start adds no public IP here");
const alloc = JSON.parse(run(a, "aws ec2 allocate-address")).AllocationId;
assert.match(run(a, `aws ec2 associate-address --instance-id ${id(a, "i", "blog")} --allocation-id ${alloc}`), /"AssociationId": "eipassoc-/);
fixed(a, "nopublicip: Elastic IP");

a = fresh("routeigw");
assert.strictEqual(run(a, `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=${id(a, "subnet", "public-c")} --query 'RouteTables[]' --output text`), "");
assert.match(run(a, `aws ec2 create-route --route-table-id ${id(a, "rtb", "private-rt")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${a.igws[0].id}`), /RouteAlreadyExists/);
run(a, `aws ec2 replace-route --route-table-id ${id(a, "rtb", "private-rt")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${a.igws[0].id}`);
broken(a, "changing private-rt does not touch public-c, and exposes the private subnets");
a = fresh("routeigw");
run(a, `aws ec2 associate-route-table --route-table-id ${id(a, "rtb", "public-rt")} --subnet-id ${id(a, "subnet", "public-c")}`);
fixed(a, "routeigw: associated with public-rt");

a = fresh("nacl");
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "blog-sg")} --protocol tcp --port 1024-65535 --cidr 0.0.0.0/0`);
broken(a, "security groups are not the problem");
const acl = a.nacls.find((n) => n.name === "public-nacl").id;
run(a, `aws ec2 create-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 130 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`);
assert.match(run(a, `aws ec2 create-network-acl-entry --network-acl-id ${acl} --rule-number 130 --protocol tcp --port-range From=1,To=2 --cidr-block 0.0.0.0/0 --rule-action allow`), /NetworkAclEntryAlreadyExists/);
broken(a, "inbound ephemeral ports do not carry replies out");
run(a, `aws ec2 delete-network-acl-entry --network-acl-id ${acl} --ingress --rule-number 130`);
run(a, `aws ec2 create-network-acl-entry --network-acl-id ${acl} --egress --rule-number 120 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`);
fixed(a, "nacl: outbound ephemeral ports");

a = fresh("nat");
const worker = id(a, "i", "worker");
assert.match(run(a, `aws ssm start-session --target ${worker}`), /Starting session with SessionId/);
assert.match(run(a, "curl -m 5 https://api.github.com"), /curl: \(28\) Failed to connect to api.github.com port 443/);
assert.match(run(a, "exit"), /Exiting session/);
const eip1 = JSON.parse(run(a, "aws ec2 allocate-address")).AllocationId;
const natBad = JSON.parse(run(a, `aws ec2 create-nat-gateway --subnet-id ${id(a, "subnet", "private-b")} --allocation-id ${eip1}`)).NatGateway.NatGatewayId;
run(a, `aws ec2 create-route --route-table-id ${id(a, "rtb", "private-rt")} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${natBad}`);
broken(a, "a NAT gateway in a private subnet has no way out");
run(a, `aws ec2 replace-route --route-table-id ${id(a, "rtb", "private-rt")} --destination-cidr-block 0.0.0.0/0 --gateway-id ${a.igws[0].id}`);
broken(a, "an internet gateway route needs a public IP, and makes the subnet public");
a = fresh("nat");
const eip2 = JSON.parse(run(a, "aws ec2 allocate-address")).AllocationId;
const nat = JSON.parse(run(a, `aws ec2 create-nat-gateway --subnet-id ${id(a, "subnet", "public-a")} --allocation-id ${eip2}`)).NatGateway.NatGatewayId;
run(a, `aws ec2 create-route --route-table-id ${id(a, "rtb", "private-rt")} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${nat}`);
fixed(a, "nat: NAT in a public subnet");
run(a, `aws ssm start-session --target ${worker}`);
assert.match(run(a, "curl https://api.github.com"), /"status":"ok"/);
assert.match(run(a, "curl -s https://checkip.amazonaws.com"), /^203\.0\.113\.\d+$/);

// Compute
a = fresh("stopped");
assert.match(run(a, `aws ec2 reboot-instances --instance-ids ${id(a, "i", "blog")}`), /IncorrectInstanceState/);
assert.match(run(a, "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopInstances"), /"Username": "contractor-tmp"/);
run(a, `aws ec2 start-instances --instance-ids ${id(a, "i", "blog")}`);
fixed(a, "stopped: started, Elastic IP kept");

a = fresh("statuscheck");
assert.match(run(a, `aws ec2 describe-instance-status --instance-ids ${id(a, "i", "blog")}`), /"SystemStatus": \{[\s\S]*"Status": "impaired"/);
run(a, `aws ec2 reboot-instances --instance-ids ${id(a, "i", "blog")}`);
broken(a, "a reboot stays on the same host");
run(a, `aws ec2 stop-instances --instance-ids ${id(a, "i", "blog")}`);
run(a, `aws ec2 start-instances --instance-ids ${id(a, "i", "blog")}`);
fixed(a, "statuscheck: stop and start");

a = fresh("capacity");
const batch = (sub) => `aws ec2 run-instances --image-id ${AMI} --instance-type c7i.8xlarge --subnet-id ${id(a, "subnet", sub)} --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=batch}]'`;
assert.match(run(a, batch("private-a")), /An error occurred \(InsufficientInstanceCapacity\) when calling the RunInstances operation \(reached max retries: 2\): We currently do not have sufficient c7i.8xlarge capacity in the Availability Zone you requested \(us-east-1a\)/);
run(a, "aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 256");
run(a, batch("private-a"));
broken(a, "retrying and quotas do not create capacity");
run(a, batch("private-b"));
fixed(a, "capacity: another AZ");

a = fresh("vcpu");
const etl = `aws ec2 run-instances --image-id ${AMI} --instance-type m5.2xlarge --subnet-id ${id(a, "subnet", "private-a")} --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=etl}]'`;
assert.match(run(a, etl), /VcpuLimitExceeded\) when calling the RunInstances operation: You have requested more vCPU capacity than your current vCPU limit of 32 allows/);
run(a, `aws ec2 stop-instances --instance-ids ${id(a, "i", "web-1")}`); run(a, "echo");
broken(a, "stopping production is not the fix");
a = fresh("vcpu");
assert.match(run(a, "aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`]|[0].Value]' --output text"), /m5\.2xlarge\tloadtest-1/);
run(a, `aws ec2 terminate-instances --instance-ids ${id(a, "i", "loadtest-1")} ${id(a, "i", "loadtest-2")} ${id(a, "i", "loadtest-3")}`);
run(a, etl);
fixed(a, "vcpu: load test removed");

a = fresh("lambdatimeout");
assert.match(run(a, "aws lambda invoke --function-name orders-report out.json"), /"FunctionError": "Unhandled"/);
assert.match(run(a, "cat out.json"), /Sandbox.Timedout.*Task timed out after 3.00 seconds/);
assert.match(run(a, "aws logs tail /aws/lambda/orders-report"), /Task timed out after 3.00 seconds/);
run(a, "aws lambda update-function-configuration --function-name orders-report --memory-size 1024");
broken(a, "memory does not speed up a slow API");
assert.match(run(a, "aws lambda update-function-configuration --function-name orders-report --timeout 1000"), /Member must have value less than or equal to 900/);
run(a, "aws lambda update-function-configuration --function-name orders-report --timeout 15");
fixed(a, "lambdatimeout: timeout raised");
assert.doesNotMatch(run(a, "aws lambda invoke --function-name orders-report out.json"), /FunctionError/);

a = fresh("throttled");
assert.match(run(a, "aws lambda invoke --function-name orders-api out.json"), /An error occurred \(TooManyRequestsException\) when calling the Invoke operation \(reached max retries: 2\): Rate Exceeded\./);
run(a, "aws lambda update-function-configuration --function-name orders-api --memory-size 1024");
broken(a, "memory is not concurrency");
run(a, "aws lambda put-function-concurrency --function-name orders-api --reserved-concurrent-executions 50");
fixed(a, "throttled: reserved concurrency");

a = fresh("asgmax");
assert.match(run(a, "aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 4"), /ValidationError\) when calling the SetDesiredCapacity operation: New SetDesiredCapacity value 4 is above max value 2 for the AutoScalingGroup\./);
broken(a, "desired above max is refused");
run(a, "aws autoscaling update-auto-scaling-group --auto-scaling-group-name web-asg --max-size 6");
run(a, "aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg");
fixed(a, "asgmax: room to scale");
assert.match(run(a, "aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg"), /monitor alarm cpu-high in state ALARM triggered policy scale-out/);

// Storage
a = fresh("publicbucket");
assert.match(run(a, "curl https://nimbus-kitchen-invoices.s3.amazonaws.com/2026/10/inv-1042.pdf"), /invoice 1042/);
assert.match(run(a, "aws s3api get-bucket-policy-status --bucket nimbus-kitchen-invoices"), /"IsPublic": true/);
assert.match(run(a, "aws s3api put-bucket-acl --bucket nimbus-kitchen-invoices --acl private"), /AccessControlListNotSupported/);
broken(a, "ACLs are not the problem");
assert.match(run(a, "aws s3 rb s3://nimbus-kitchen-invoices"), /BucketNotEmpty/);
run(a, "aws s3api put-public-access-block --bucket nimbus-kitchen-invoices --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true");
assert.match(run(a, "curl https://nimbus-kitchen-invoices.s3.amazonaws.com/2026/10/inv-1042.pdf"), /<Code>AccessDenied<\/Code>/);
fixed(a, "publicbucket: Block Public Access");
a = fresh("publicbucket");
run(a, "aws s3 rb s3://nimbus-kitchen-invoices --force");
broken(a, "deleting the bucket also breaks the app");

a = fresh("ownership");
assert.match(run(a, "aws s3 cp s3://nimbus-kitchen-imports/orders/2026-10-30.csv . --profile import"), /fatal error: An error occurred \(403\) when calling the HeadObject operation: Forbidden/);
const me = run(a, "aws s3api list-buckets --query Owner.ID --output text");
assert.match(run(a, "aws s3api list-object-versions --bucket nimbus-kitchen-imports --prefix orders/ --query 'Versions[].[Key,Owner.ID]' --output text"), /orders\/2026-10-30.csv\t[0-9a-f]{64}/);
assert.doesNotMatch(run(a, "aws s3api list-object-versions --bucket nimbus-kitchen-imports --prefix orders/ --query 'Versions[].Owner.ID' --output text"), new RegExp(me));
run(a, `aws iam put-role-policy --role-name import-job --policy-name all-s3 --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}'`);
broken(a, "IAM cannot grant access to another account's object");
run(a, "aws s3api put-bucket-ownership-controls --bucket nimbus-kitchen-imports --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'");
fixed(a, "ownership: bucket owner enforced");
assert.match(run(a, "aws s3 cp s3://nimbus-kitchen-imports/orders/2026-10-30.csv . --profile import"), /download:/);

a = fresh("undelete");
const versions = JSON.parse(run(a, "aws s3api list-object-versions --bucket nimbus-kitchen-config --prefix prod/app.json"));
const marker = versions.DeleteMarkers[0].VersionId;
assert.ok(versions.DeleteMarkers[0].IsLatest);
run(a, "aws s3api put-bucket-versioning --bucket nimbus-kitchen-config --versioning-configuration Status=Enabled");
broken(a, "versioning was already on");
run(a, `aws s3api copy-object --bucket nimbus-kitchen-config --key prod/app.json --copy-source nimbus-kitchen-config/prod/app.json?versionId=${versions.Versions[1].VersionId}`);
broken(a, "the oldest version is not the latest");
a = fresh("undelete");
assert.match(run(a, "aws s3api get-object --bucket nimbus-kitchen-config --key prod/app.json app.json"), /NoSuchKey/);
run(a, `aws s3api delete-object --bucket nimbus-kitchen-config --key prod/app.json --version-id ${marker}`);
fixed(a, "undelete: marker removed");

a = fresh("nosuchbucket");
run(a, "aws lambda invoke --function-name thumbnailer out.json");
assert.match(run(a, "cat out.json"), /"errorType":"NoSuchBucket"/);
assert.strictEqual(run(a, "aws s3 mb s3://nimbus-kitchen-uplaods"), "make_bucket: nimbus-kitchen-uplaods");
broken(a, "a bucket with the typo hides the bug");
run(a, "aws lambda update-function-configuration --function-name thumbnailer --environment 'Variables={BUCKET=nimbus-kitchen-uploads,SIZE=320}'");
fixed(a, "nosuchbucket: env var fixed");

a = fresh("bucketexists");
assert.match(run(a, "aws s3 mb s3://menu-photos --region eu-west-1"), /BucketAlreadyExists\) when calling the CreateBucket operation: The requested bucket name is not available/);
assert.match(run(a, "aws s3api create-bucket --bucket nimbus-kitchen-menu-photos-111122223333 --region eu-west-1"), /IllegalLocationConstraintException/);
run(a, "aws s3 mb s3://nimbus-kitchen-menu-photos-111122223333");
broken(a, "us-east-1 is the wrong Region");
run(a, "aws s3api create-bucket --bucket nimbus-kitchen-menu-eu-111122223333 --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1");
fixed(a, "bucketexists: unique name in eu-west-1");

// Databases
a = fresh("lambdards");
run(a, "aws lambda invoke --function-name orders-api out.json");
assert.match(run(a, "cat out.json"), /connect ETIMEDOUT 10\.0\.11\.25:5432/);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "db-sg")} --protocol tcp --port 5432 --cidr 0.0.0.0/0`);
broken(a, "0.0.0.0/0 on the database");
run(a, `aws ec2 revoke-security-group-ingress --group-id ${id(a, "sg", "db-sg")} --protocol tcp --port 5432 --cidr 0.0.0.0/0`);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "db-sg")} --protocol tcp --port 5432 --source-group ${id(a, "sg", "lambda-sg")}`);
fixed(a, "lambdards: lambda-sg allowed");

a = fresh("rdspublic");
assert.match(run(a, "nc -vz orders-db.c3kq8vx0zw1m.us-east-1.rds.amazonaws.com 5432"), /succeeded!/);
run(a, `aws ec2 revoke-security-group-ingress --group-id ${id(a, "sg", "db-sg")} --protocol tcp --port 5432 --cidr 0.0.0.0/0`);
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --no-publicly-accessible");
broken(a, "without --apply-immediately the change waits");
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --no-publicly-accessible --apply-immediately");
fixed(a, "rdspublic: private again");

a = fresh("rdsstorage");
run(a, "aws rds reboot-db-instance --db-instance-identifier orders-db"); run(a, "echo");
broken(a, "a reboot frees nothing");
assert.match(run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --allocated-storage 105 --apply-immediately"), /must be increased by at least 10%/);
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --allocated-storage 200 --max-allocated-storage 500 --apply-immediately");
run(a, "echo");
fixed(a, "rdsstorage: grown");

a = fresh("rdsbackup");
run(a, "aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier manual-1");
broken(a, "a manual snapshot is not automated backups");
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --backup-retention-period 7 --apply-immediately");
fixed(a, "rdsbackup: retention 7");

a = fresh("rdsupgrade");
assert.match(run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --engine-version 16.4 --apply-immediately"), /AllowMajorVersionUpgrade flag must be present/);
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --engine-version 16.4 --allow-major-version-upgrade --apply-immediately");
broken(a, "no snapshot taken first");
a = fresh("rdsupgrade");
run(a, "aws rds create-db-snapshot --db-instance-identifier orders-db --db-snapshot-identifier orders-db-before-pg16");
run(a, "aws rds modify-db-instance --db-instance-identifier orders-db --engine-version 16.4 --allow-major-version-upgrade --apply-immediately");
fixed(a, "rdsupgrade: snapshot then upgrade");

// Load balancing and DNS
a = fresh("alb503");
assert.match(run(a, "curl -i http://shop.example.com"), /HTTP\/1.1 503 Service Temporarily Unavailable[\s\S]*Server: awselb\/2.0/);
run(a, `aws elbv2 modify-listener --listener-arn ${a.albs[0].listeners[0].arn} --default-actions Type=forward,TargetGroupArn=${id(a, "tg", "web-tg")}`);
assert.match(run(a, "curl http://shop.example.com"), /Order dinner/);
broken(a, "rolling back the listener is not the release");
a = fresh("alb503");
run(a, `aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name web-asg --target-group-arns ${id(a, "tg", "web-tg-v2")}`);
fixed(a, "alb503: ASG attached to v2");

a = fresh("alb502");
assert.match(run(a, "curl -i http://shop.example.com"), /502 Bad Gateway/);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "web-sg")} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
broken(a, "nothing listens on 80");
a = fresh("alb502");
const tg502 = id(a, "tg", "web-tg");
run(a, `aws elbv2 register-targets --target-group-arn ${tg502} --targets Id=${id(a, "i", "web-1")},Port=8080 Id=${id(a, "i", "web-2")},Port=8080`);
run(a, "echo");
broken(a, "port-80 targets still unhealthy");
run(a, `aws elbv2 deregister-targets --target-group-arn ${tg502} --targets Id=${id(a, "i", "web-1")},Port=80 Id=${id(a, "i", "web-2")},Port=80`);
fixed(a, "alb502: registered on 8080");

a = fresh("healthpath");
assert.match(run(a, `aws elbv2 describe-target-health --target-group-arn ${id(a, "tg", "web-tg")}`), /Health checks failed with these codes: \[404\]/);
assert.match(run(a, "curl http://shop.example.com"), /Order dinner/);
run(a, `aws elbv2 modify-target-group --target-group-arn ${id(a, "tg", "web-tg")} --matcher HttpCode=200-499`);
broken(a, "a matcher that accepts 404 hides failures");
run(a, `aws elbv2 modify-target-group --target-group-arn ${id(a, "tg", "web-tg")} --matcher HttpCode=200 --health-check-path /health`);
fixed(a, "healthpath: real path");

a = fresh("alb504");
assert.match(run(a, "curl -i http://shop.example.com"), /504 Gateway Time-out/);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "web-sg")} --protocol tcp --port 8080 --cidr 0.0.0.0/0`);
broken(a, "web servers opened to the world");
a = fresh("alb504");
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "web-sg")} --protocol tcp --port 8080 --source-group ${id(a, "sg", "alb-sg")}`);
fixed(a, "alb504: ALB security group allowed");

a = fresh("r53record");
assert.strictEqual(run(a, "dig +short shop.example.com"), "203.0.113.77");
const zone = a.zones[0].id;
edit(a, "change.json", (d) => { d.Changes[0].ResourceRecordSet.ResourceRecords = [{ Value: "203.0.113.50" }]; return d; });
run(a, `aws route53 change-resource-record-sets --hosted-zone-id ${zone} --change-batch file://change.json`);
broken(a, "an ALB's IP is not a stable target");
edit(a, "change.json", (d) => { const r = d.Changes[0].ResourceRecordSet; delete r.TTL; delete r.ResourceRecords; r.AliasTarget = { HostedZoneId: "Z35SXDOTRQ7X7K", DNSName: a.albs[0].dns, EvaluateTargetHealth: true }; return d; });
assert.match(run(a, `aws route53 change-resource-record-sets --hosted-zone-id ${zone} --change-batch file://change.json`), /"Status": "PENDING"/);
fixed(a, "r53record: alias to the ALB");

a = fresh("r53ns");
assert.match(run(a, "dig shop.example.com"), /status: SERVFAIL/);
const ns = JSON.parse(run(a, `aws route53 get-hosted-zone --id ${a.zones[0].id} --query DelegationSet.NameServers`));
run(a, `aws route53domains update-domain-nameservers --domain-name example.com --nameservers ${ns.slice(0, 2).map((n) => "Name=" + n).join(" ")}`);
broken(a, "two of four name servers");
run(a, `aws route53domains update-domain-nameservers --domain-name example.com --nameservers ${ns.map((n) => "Name=" + n).join(" ")}`);
fixed(a, "r53ns: delegation fixed");
assert.match(run(a, "dig +short shop.example.com"), /^203\.0\.113\.50\n203\.0\.113\.51$/);

// Observability
a = fresh("asgalarm");
assert.match(run(a, "aws cloudwatch describe-alarms --alarm-names cpu-high --query 'MetricAlarms[].StateValue' --output text"), /INSUFFICIENT_DATA/);
run(a, "aws autoscaling update-auto-scaling-group --auto-scaling-group-name web-asg --desired-capacity 4"); run(a, "echo");
broken(a, "scaling by hand does not fix the alarm");
a = fresh("asgalarm");
run(a, "aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 4"); run(a, "echo");
broken(a, "set-desired-capacity by hand");
a = fresh("asgalarm");
edit(a, "alarm.json", (d) => { d.Dimensions[0].Value = "web-asg"; return d; });
run(a, "aws cloudwatch put-metric-alarm --cli-input-json file://alarm.json");
run(a, "echo");
fixed(a, "asgalarm: right dimension");

a = fresh("alarmnoaction");
run(a, "aws sns list-subscriptions-by-topic --topic-arn arn:aws:sns:us-east-1:111122223333:oncall-pager");
broken(a, "looking is not wiring");
edit(a, "alarm.json", (d) => { d.AlarmActions = ["arn:aws:sns:us-east-1:111122223333:oncall-pager"]; return d; });
run(a, "aws cloudwatch put-metric-alarm --cli-input-json file://alarm.json");
fixed(a, "alarmnoaction: pages on-call");

a = fresh("cloudtrail");
assert.match(run(a, "aws cloudtrail get-trail-status --name main-trail"), /"IsLogging": false/);
assert.match(run(a, "aws cloudtrail start-logging --name other"), /TrailNotFoundException/);
run(a, "aws cloudtrail start-logging --name main-trail");
fixed(a, "cloudtrail: logging");

// Cost
a = fresh("natcost");
assert.match(run(a, "aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=USAGE_TYPE"), /"NatGateway-Bytes"/);
run(a, `aws ec2 delete-nat-gateway --nat-gateway-id ${a.nats[0].id}`);
broken(a, "deleting the NAT breaks internet access");
a = fresh("natcost");
const before = a.monthly();
run(a, `aws ec2 create-vpc-endpoint --vpc-id ${a.vpcs[0].id} --service-name com.amazonaws.us-east-1.s3 --vpc-endpoint-type Interface`);
broken(a, "an interface endpoint costs money and adds no route");
run(a, `aws ec2 create-vpc-endpoint --vpc-id ${a.vpcs[0].id} --service-name com.amazonaws.us-east-1.s3 --route-table-ids ${id(a, "rtb", "private-rt")}`);
fixed(a, "natcost: gateway endpoint");
assert.ok(a.monthly() < before - 150, "the bill drops");

a = fresh("ebsforgotten");
const inUse = a.volumes.find((v) => v.attached).id;
assert.match(run(a, `aws ec2 delete-volume --volume-id ${inUse}`), /VolumeInUse\) when calling the DeleteVolume operation: Volume vol-\w+ is currently attached to i-\w+/);
const amiSnap = a.amis[0].snap;
assert.match(run(a, `aws ec2 delete-snapshot --snapshot-id ${amiSnap}`), /InvalidSnapshot.InUse\) when calling the DeleteSnapshot operation: The snapshot snap-\w+ is currently in use by ami-0f1e2d3c4b5a69788/);
for (const v of a.volumes.filter((x) => !x.attached)) run(a, `aws ec2 delete-volume --volume-id ${v.id}`);
broken(a, "snapshots still there");
for (const s of a.snapshots.filter((x) => x.id !== amiSnap)) run(a, `aws ec2 delete-snapshot --snapshot-id ${s.id}`);
fixed(a, "ebsforgotten: cleaned");

a = fresh("eipidle");
const bastionEip = a.eips.find((e) => e.name === "bastion-eip");
assert.match(run(a, `aws ec2 release-address --allocation-id ${bastionEip.alloc}`), /InvalidIPAddress.InUse\) when calling the ReleaseAddress operation: Address 203.0.113.20 is in use\./);
for (const e of a.eips.filter((x) => !x.assoc)) run(a, `aws ec2 release-address --allocation-id ${e.alloc}`);
broken(a, "staging's address is still held");
const st = a.eips.find((e) => e.name === "staging-eip");
run(a, `aws ec2 disassociate-address --association-id ${st.assocId}`);
run(a, `aws ec2 release-address --allocation-id ${st.alloc}`);
fixed(a, "eipidle: released");

a = fresh("logretention");
assert.match(run(a, "aws logs put-retention-policy --log-group-name /ecs/web --retention-in-days 45"), /InvalidParameterException\) when calling the PutRetentionPolicy operation: 1 validation error detected: Value '45' at 'retentionInDays'/);
run(a, "aws logs delete-log-group --log-group-name /vpc/flow-logs");
run(a, "aws logs put-retention-policy --log-group-name /ecs/web --retention-in-days 30");
run(a, "aws logs put-retention-policy --log-group-name /aws/lambda/orders-api --retention-in-days 30");
broken(a, "flow logs must be kept a year");
a = fresh("logretention");
for (const g of ["/ecs/web", "/aws/lambda/orders-api"]) run(a, `aws logs put-retention-policy --log-group-name ${g} --retention-in-days 30`);
run(a, "aws logs put-retention-policy --log-group-name /vpc/flow-logs --retention-in-days 365");
fixed(a, "logretention: set");

a = fresh("s3versions");
run(a, "aws s3api put-bucket-lifecycle-configuration --bucket nimbus-kitchen-backups --lifecycle-configuration file://lifecycle.json");
broken(a, "Expiration deletes the current backups");
run(a, "aws s3api put-bucket-versioning --bucket nimbus-kitchen-backups --versioning-configuration Status=Suspended");
broken(a, "suspending keeps the old versions");
a.files["lifecycle.json"] = JSON.stringify({ Rules: [{ ID: "expire-old-versions", Status: "Enabled", Filter: {}, NoncurrentVersionExpiration: { NoncurrentDays: 30 } }] });
run(a, "aws s3api put-bucket-lifecycle-configuration --bucket nimbus-kitchen-backups --lifecycle-configuration file://lifecycle.json");
fixed(a, "s3versions: noncurrent expiration");

// Security
a = fresh("imdsv1");
const ssrf = "curl 'http://shop.example.com/preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/web-role'";
assert.match(run(a, ssrf), /"AccessKeyId": "ASIA\w{16}"/);
for (const n of ["web-1", "web-2"]) run(a, `aws ec2 modify-instance-metadata-options --instance-id ${id(a, "i", n)} --http-endpoint disabled`);
broken(a, "turning IMDS off breaks the app's credentials");
a = fresh("imdsv1");
for (const n of ["web-1", "web-2"]) run(a, `aws ec2 modify-instance-metadata-options --instance-id ${id(a, "i", n)} --http-tokens required --http-endpoint enabled`);
fixed(a, "imdsv1: tokens required");
assert.match(run(a, ssrf), /401 - Unauthorized/);
run(a, `aws ssm start-session --target ${id(a, "i", "web-1")}`);
run(a, `TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")`);
assert.strictEqual(run(a, `curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id`), id(a, "i", "web-1"));

a = fresh("rootkeys");
assert.match(run(a, "aws sts get-caller-identity"), /"Arn": "arn:aws:iam::111122223333:root"/);
const rootKey = JSON.parse(run(a, "aws iam list-access-keys")).AccessKeyMetadata[0].AccessKeyId;
run(a, `aws iam update-access-key --access-key-id ${rootKey} --status Inactive`);
broken(a, "an inactive key still exists");
assert.match(run(a, "aws sts get-caller-identity"), /InvalidClientTokenId/);
a = fresh("rootkeys");
run(a, `aws iam delete-access-key --access-key-id ${rootKey}`);
fixed(a, "rootkeys: deleted");
assert.match(run(a, "aws sts get-caller-identity --profile admin"), /PlatformAdmin/);

a = fresh("leakedkey");
const leaked = /AKIA\w{16}/.exec(run(a, "grep -rn AKIA ."))[0];
assert.match(run(a, `aws cloudtrail lookup-events --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=${leaked}`), /198\.51\.100\.66/);
run(a, "aws iam create-access-key --user-name report-bot");
broken(a, "a new key does not disable the old one");
run(a, `aws iam update-access-key --user-name report-bot --access-key-id ${leaked} --status Inactive`);
broken(a, "inactive is the first step, not the last");
run(a, `aws iam delete-access-key --user-name report-bot --access-key-id ${leaked}`);
fixed(a, "leakedkey: deleted");

a = fresh("sshworld");
const bsg = id(a, "sg", "bastion-sg");
run(a, `aws ec2 revoke-security-group-ingress --group-id ${bsg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
run(a, `aws ec2 authorize-security-group-ingress --group-id ${bsg} --protocol tcp --port 2222 --cidr 0.0.0.0/0`);
run(a, `aws ssm start-session --target ${id(a, "i", "bastion")}`);
broken(a, "another port open to the world");
a = fresh("sshworld");
assert.match(run(a, "aws guardduty get-findings --detector-id x --finding-ids " + a.findings[0].id), /UnauthorizedAccess:EC2\/SSHBruteForce/);
run(a, `aws ec2 revoke-security-group-ingress --group-id ${bsg} --protocol tcp --port 22 --cidr 0.0.0.0/0`);
assert.match(run(a, `ssh -i key.pem ec2-user@${a.publicIpOf(a.inst("bastion"))}`), /Operation timed out/);
run(a, `aws ssm start-session --target ${id(a, "i", "bastion")}`);
fixed(a, "sshworld: closed, Session Manager works");

a = fresh("kmsdecrypt");
const cp = "aws s3 cp s3://nimbus-kitchen-payments/settlements/2026-10-29.csv . --profile payments";
assert.match(run(a, cp), /download failed: s3:\/\/nimbus-kitchen-payments\/settlements\/2026-10-29.csv to .\/2026-10-29.csv An error occurred \(AccessDenied\) when calling the GetObject operation: User: arn:aws:sts::111122223333:assumed-role\/payments-app\/you is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:us-east-1:111122223333:key\/[0-9a-f-]+ because no resource-based policy allows the kms:Decrypt action/);
run(a, "aws iam attach-role-policy --role-name payments-app --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
broken(a, "AdministratorAccess does not get past a key policy");
edit(a, "key-policy.json", () => ({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:role/payments-app" }, Action: "kms:*", Resource: "*" }] }));
assert.match(run(a, "aws kms put-key-policy --key-id alias/payments --policy-name default --policy file://key-policy.json"), /MalformedPolicyDocumentException\) when calling the PutKeyPolicy operation: The new key policy will not allow you to update the key policy in the future\./);
edit(a, "key-policy.json", (d) => { d.Statement.unshift({ Sid: "KeyAdministrators", Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:role/PlatformAdmin" }, Action: "kms:*", Resource: "*" }); d.Statement[1] = { Effect: "Allow", Principal: "*", Action: "kms:Decrypt", Resource: "*" }; return d; });
run(a, "aws kms put-key-policy --key-id alias/payments --policy-name default --policy file://key-policy.json");
broken(a, "Principal * opens the key to everyone");
a = fresh("kmsdecrypt");
edit(a, "key-policy.json", (d) => { d.Statement.push({ Sid: "PaymentsAppDecrypt", Effect: "Allow", Principal: { AWS: "arn:aws:iam::111122223333:role/payments-app" }, Action: "kms:Decrypt", Resource: "*" }); return d; });
run(a, "aws kms put-key-policy --key-id alias/payments --policy-name default --policy file://key-policy.json");
fixed(a, "kmsdecrypt: key policy names the role");
assert.match(run(a, cp), /download:/);

// Coverage round: CDN, peering, containers, data services, CORS, limits.
a = fresh("cfcert");
assert.match(run(a, "curl -I https://www.example.com"), /curl: \(60\) SSL: no alternative certificate subject name matches target host name 'www.example.com'/);
const euCert = JSON.parse(run(a, "aws acm list-certificates --region eu-west-1")).CertificateSummaryList[0].CertificateArn;
const usCert = JSON.parse(run(a, "aws acm list-certificates --region us-east-1")).CertificateSummaryList[0].CertificateArn;
assert.match(run(a, `aws acm describe-certificate --certificate-arn ${usCert}`), /ResourceNotFoundException|"Status": "PENDING_VALIDATION"/);
const distId = a.dists[0].id;
const etag = () => JSON.parse(run(a, `aws cloudfront get-distribution-config --id ${distId}`)).ETag;
edit(a, "dist-config.json", (d) => { d.ViewerCertificate = { ACMCertificateArn: euCert, SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" }; return d; });
assert.match(run(a, `aws cloudfront update-distribution --id ${distId} --if-match ${etag()} --distribution-config file://dist-config.json`), /InvalidViewerCertificate\) when calling the UpdateDistribution operation: The specified SSL certificate doesn't exist, isn't in us-east-1 region/);
assert.match(run(a, `aws cloudfront update-distribution --id ${distId} --distribution-config file://dist-config.json`), /InvalidIfMatchVersion/);
edit(a, "dist-config.json", (d) => { d.ViewerCertificate.ACMCertificateArn = usCert; return d; });
assert.match(run(a, `aws cloudfront update-distribution --id ${distId} --if-match ${etag()} --distribution-config file://dist-config.json`), /InvalidViewerCertificate/);
broken(a, "a pending certificate cannot be attached");
const rr = JSON.parse(run(a, `aws acm describe-certificate --region us-east-1 --certificate-arn ${usCert} --query 'Certificate.DomainValidationOptions[0].ResourceRecord'`));
a.files["validate.json"] = JSON.stringify({ Changes: [{ Action: "UPSERT", ResourceRecordSet: { Name: rr.Name, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: rr.Value }] } }] });
run(a, `aws route53 change-resource-record-sets --hosted-zone-id ${a.zones[0].id} --change-batch file://validate.json`);
assert.match(run(a, `aws acm describe-certificate --region us-east-1 --certificate-arn ${usCert} --query Certificate.Status --output text`), /ISSUED/);
run(a, `aws cloudfront update-distribution --id ${distId} --if-match ${etag()} --distribution-config file://dist-config.json`);
run(a, "echo");
fixed(a, "cfcert: validated us-east-1 certificate attached");
assert.match(run(a, "curl -i https://www.example.com"), /HTTP\/1.1 200 OK[\s\S]*X-Cache: (Miss|Hit) from cloudfront/);

a = fresh("cfcache");
assert.match(run(a, "curl -i https://www.example.com"), /X-Cache: Hit from cloudfront[\s\S]*Nimbus Kitchen 1.8/);
run(a, "aws s3 cp s3://nimbus-kitchen-web/index.html index.html && aws s3 cp index.html s3://nimbus-kitchen-web/index.html");
broken(a, "uploading again does not touch the edge cache");
assert.match(run(a, `aws cloudfront create-invalidation --distribution-id ${a.dists[0].id} --paths /index.html`), /"Status": "InProgress"/);
run(a, "echo");
fixed(a, "cfcache: invalidated");
assert.match(run(a, "curl https://www.example.com"), /Nimbus Kitchen 1.9/);

a = fresh("peering");
run(a, `aws ssm start-session --target ${id(a, "i", "web-1")}`);
assert.match(run(a, "nc -vz 10.20.1.15 5432"), /Ncat: TIMEOUT/);
run(a, "exit");
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "analytics-db-sg")} --protocol tcp --port 5432 --cidr 0.0.0.0/0`);
broken(a, "a security group cannot fix a missing return route");
a = fresh("peering");
assert.match(run(a, `aws ec2 create-route --route-table-id ${id(a, "rtb", "analytics-rt")} --destination-cidr-block 10.0.0.0/16 --vpc-peering-connection-id pcx-0123456789abcdef0`), /InvalidVpcPeeringConnectionID.NotFound/);
run(a, `aws ec2 create-route --route-table-id ${id(a, "rtb", "analytics-rt")} --destination-cidr-block 10.0.0.0/16 --vpc-peering-connection-id ${a.peerings[0].id}`);
fixed(a, "peering: return route");
assert.match(run(a, "aws ec2 describe-route-tables --filters Name=tag:Name,Values=analytics-rt"), /"VpcPeeringConnectionId": "pcx-/);

a = fresh("ecsnetwork");
const stopped = JSON.parse(run(a, "aws ecs list-tasks --cluster kitchen --desired-status STOPPED")).taskArns[0];
assert.match(run(a, `aws ecs describe-tasks --cluster kitchen --tasks ${stopped} --query 'tasks[].stoppedReason' --output text`), /ResourceInitializationError: unable to pull secrets or registry auth: .* dial tcp [\d.]+:443: i\/o timeout\. Please check your task network configuration\./);
run(a, `aws ecs update-service --cluster kitchen --service orders-worker --network-configuration 'awsvpcConfiguration={subnets=[${id(a, "subnet", "private-a")}],securityGroups=[${id(a, "sg", "worker-sg")}],assignPublicIp=ENABLED}' --force-new-deployment`);
broken(a, "a public IP in a private subnet goes nowhere");
a = fresh("ecsnetwork");
for (const svc of ["ecr.api", "ecr.dkr"]) run(a, `aws ec2 create-vpc-endpoint --vpc-id ${a.vpcs[0].id} --vpc-endpoint-type Interface --service-name com.amazonaws.us-east-1.${svc}`);
assert.match(run(a, `aws ecs describe-tasks --cluster kitchen --tasks ${stopped} --query 'tasks[].stoppedReason' --output text`), /CannotPullContainerError: ref pull has been retried 5 time\(s\)/);
broken(a, "layers come from S3");
run(a, `aws ec2 create-vpc-endpoint --vpc-id ${a.vpcs[0].id} --service-name com.amazonaws.us-east-1.s3 --route-table-ids ${id(a, "rtb", "private-rt")}`);
fixed(a, "ecsnetwork: endpoints");
assert.match(run(a, "aws ecs describe-services --cluster kitchen --services orders-worker --query 'services[].runningCount' --output text"), /^2$/);

a = fresh("ecsrole");
const st2 = JSON.parse(run(a, "aws ecs list-tasks --cluster kitchen --desired-status STOPPED")).taskArns[0];
assert.match(run(a, `aws ecs describe-tasks --cluster kitchen --tasks ${st2} --query 'tasks[].stoppedReason' --output text`), /assumed-role\/ecsTaskExecutionRole\/\w+ is not authorized to perform: ecr:GetAuthorizationToken/);
run(a, "aws iam attach-role-policy --role-name orders-worker-task --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
broken(a, "the task role is not the one that pulls images");
a = fresh("ecsrole");
run(a, "aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy");
fixed(a, "ecsrole: execution role");

a = fresh("eksauth");
assert.match(run(a, "kubectl get pods"), /The connection to the server localhost:8080 was refused/);
assert.match(run(a, "aws eks update-kubeconfig --name kitchen-eks --profile oncall"), /Added new context arn:aws:eks:us-east-1:111122223333:cluster\/kitchen-eks/);
assert.match(run(a, "kubectl get pods"), /^error: You must be logged in to the server \(Unauthorized\)$/);
run(a, "aws iam attach-role-policy --role-name OnCall --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
assert.match(run(a, "kubectl get pods"), /Unauthorized/);
run(a, "aws iam detach-role-policy --role-name OnCall --policy-arn arn:aws:iam::aws:policy/AdministratorAccess");
run(a, "aws eks create-access-entry --cluster-name kitchen-eks --principal-arn arn:aws:iam::111122223333:role/OnCall");
assert.match(run(a, "kubectl get pods -A"), /Error from server \(Forbidden\): pods is forbidden: User "arn:aws:sts::111122223333:assumed-role\/OnCall\/you" cannot list resource "pods" in API group "" at the cluster scope/);
run(a, "aws eks associate-access-policy --cluster-name kitchen-eks --principal-arn arn:aws:iam::111122223333:role/OnCall --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy --access-scope type=cluster");
broken(a, "cluster admin is more than read-only");
a = fresh("eksauth");
run(a, "aws eks update-kubeconfig --name kitchen-eks --profile oncall");
run(a, "aws eks create-access-entry --cluster-name kitchen-eks --principal-arn arn:aws:iam::111122223333:role/OnCall");
run(a, "aws eks associate-access-policy --cluster-name kitchen-eks --principal-arn arn:aws:iam::111122223333:role/OnCall --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=namespace,namespaces=default");
broken(a, "one namespace is not the whole cluster");
run(a, "aws eks associate-access-policy --cluster-name kitchen-eks --principal-arn arn:aws:iam::111122223333:role/OnCall --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=cluster");
fixed(a, "eksauth: view access entry");
assert.match(run(a, "kubectl get pods -A"), /kube-system\s+coredns/);
assert.strictEqual(run(a, "kubectl auth can-i delete pods"), "no");

a = fresh("secretrotation");
run(a, "aws lambda invoke --function-name orders-api out.json");
assert.match(run(a, "cat out.json"), /password authentication failed for user \\"orders_app\\"/);
const pw = JSON.parse(JSON.parse(run(a, "aws secretsmanager get-secret-value --secret-id prod/orders/db")).SecretString).password;
run(a, `aws lambda update-function-configuration --function-name orders-api --environment 'Variables={DB_USER=orders_app,DB_PASSWORD=${pw}}'`);
assert.doesNotMatch(run(a, "aws lambda invoke --function-name orders-api out.json"), /FunctionError/);
broken(a, "pasting the new password lasts until the next rotation");
a = fresh("secretrotation");
run(a, "aws lambda update-function-configuration --function-name orders-api --environment 'Variables={DB_USER=orders_app,SECRET_ID=prod/orders/db}'");
run(a, "aws lambda invoke --function-name orders-api out.json");
assert.match(run(a, "cat out.json"), /AccessDeniedException.*secretsmanager:GetSecretValue on resource: prod\/orders\/db because no identity-based policy allows/);
run(a, `aws iam put-role-policy --role-name orders-api-role --policy-name all-secrets --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"*"}]}'`);
broken(a, "every secret in the account is too much");
run(a, "aws iam delete-role-policy --role-name orders-api-role --policy-name all-secrets");
run(a, `aws iam put-role-policy --role-name orders-api-role --policy-name read-db-secret --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":"${a.secrets[0].arn}"}]}'`);
fixed(a, "secretrotation: reads the secret");
run(a, "aws secretsmanager rotate-secret --secret-id prod/orders/db");
assert.doesNotMatch(run(a, "aws lambda invoke --function-name orders-api out.json"), /FunctionError/, "survives the next rotation");

a = fresh("dynamothrottle");
run(a, "aws lambda invoke --function-name orders-ingest out.json");
assert.match(run(a, "cat out.json"), /ProvisionedThroughputExceededException.*Consider increasing your provisioning level with the UpdateTable API/);
run(a, "aws dynamodb update-table --table-name orders --provisioned-throughput ReadCapacityUnits=50,WriteCapacityUnits=5");
broken(a, "read capacity does not take writes");
assert.match(run(a, "aws dynamodb update-table --table-name orders --billing-mode PAY_PER_REQUEST --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=50"), /ValidationException/);
run(a, "aws dynamodb update-table --table-name orders --billing-mode PAY_PER_REQUEST");
fixed(a, "dynamothrottle: on-demand");

a = fresh("sqsdupes");
const qurl = JSON.parse(run(a, "aws sqs get-queue-url --queue-name order-emails")).QueueUrl;
assert.match(run(a, `aws sqs get-queue-attributes --queue-url ${qurl} --attribute-names VisibilityTimeout`), /"VisibilityTimeout": "30"/);
run(a, `aws sqs set-queue-attributes --queue-url ${qurl} --attributes MessageRetentionPeriod=1209600`);
broken(a, "retention is not visibility");
run(a, `aws sqs purge-queue --queue-url ${qurl}`);
run(a, `aws sqs set-queue-attributes --queue-url ${qurl} --attributes VisibilityTimeout=180`);
broken(a, "purging lost the waiting messages");
a = fresh("sqsdupes");
assert.match(run(a, `aws sqs set-queue-attributes --queue-url ${qurl} --attributes VisibilityTimeout=50000`), /InvalidAttributeValue/);
run(a, `aws sqs set-queue-attributes --queue-url ${qurl} --attributes VisibilityTimeout=180`);
fixed(a, "sqsdupes: visibility above processing time");

a = fresh("s3cors");
const url = run(a, "aws s3 presign s3://nimbus-kitchen-media/menu.json --expires-in 300");
assert.match(url, /^https:\/\/nimbus-kitchen-media\.s3\.us-east-1\.amazonaws\.com\/menu\.json\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.*X-Amz-Signature=[0-9a-f]{64}$/);
assert.doesNotMatch(run(a, `curl -i -H 'Origin: https://shop.example.com' '${url}'`), /Access-Control-Allow-Origin/);
assert.match(run(a, "aws s3api get-bucket-cors --bucket nimbus-kitchen-media"), /NoSuchCORSConfiguration\) when calling the GetBucketCors operation: The CORS configuration does not exist/);
run(a, "aws s3api put-bucket-cors --bucket nimbus-kitchen-media --cors-configuration file://cors.json");
broken(a, "the wrong origin");
assert.match(run(a, `curl -i -X OPTIONS -H 'Origin: https://shop.example.com' -H 'Access-Control-Request-Method: GET' '${url}'`), /CORSResponse: This CORS request is not allowed/);
edit(a, "cors.json", (d) => { d.CORSRules[0].AllowedOrigins = ["*"]; return d; });
run(a, "aws s3api put-bucket-cors --bucket nimbus-kitchen-media --cors-configuration file://cors.json");
broken(a, "any origin is too broad");
edit(a, "cors.json", (d) => { d.CORSRules[0].AllowedOrigins = ["https://shop.example.com"]; return d; });
run(a, "aws s3api put-bucket-cors --bucket nimbus-kitchen-media --cors-configuration file://cors.json");
fixed(a, "s3cors: exact origin");
assert.match(run(a, `curl -i -H 'Origin: https://shop.example.com' '${url}'`), /Access-Control-Allow-Origin: https:\/\/shop.example.com/);

a = fresh("rdsrefused");
run(a, "aws lambda invoke --function-name orders-api out.json");
assert.match(run(a, "cat out.json"), /connect ECONNREFUSED 10\.0\.11\.25:3306/);
run(a, "aws rds reboot-db-instance --db-instance-identifier orders-db"); run(a, "echo");
broken(a, "a reboot does not change the port");
run(a, `aws ec2 authorize-security-group-ingress --group-id ${id(a, "sg", "db-sg")} --protocol tcp --port 3306 --cidr 0.0.0.0/0`);
broken(a, "nothing listens on 3306, and now the world can try");
a = fresh("rdsrefused");
run(a, `aws lambda update-function-configuration --function-name orders-api --environment 'Variables={DB_HOST=${a.dbHost(a.db("orders-db"))},DB_PORT=5432}'`);
fixed(a, "rdsrefused: right port");
assert.doesNotMatch(run(a, "aws lambda invoke --function-name orders-api out.json"), /FunctionError/);

a = fresh("throttling");
assert.match(run(a, "./inventory.sh"), /An error occurred \(RequestLimitExceeded\) when calling the DescribeInstances operation \(reached max retries: 4\): Request limit exceeded\./);
run(a, "./inventory.sh");
run(a, "export AWS_RETRY_MODE=adaptive");
broken(a, "adaptive with three attempts still gives up");
run(a, "aws configure set max_attempts 10");
fixed(a, "throttling: adaptive retries");
assert.match(run(a, "bash inventory.sh"), /1,208 instances written/);

// Errors the CLI prints for bad input.
a = fresh("sgweb");
assert.match(run(a, "aws ec3 describe-instances"), /aws: \[ERROR\]: argument command: Found invalid choice 'ec3'/);
assert.match(run(a, "aws s3api get-bucket-policy"), /aws: \[ERROR\]: the following arguments are required: --bucket/);
assert.match(run(a, "aws ec2 describe-instances --instance-ids i-nope"), /InvalidInstanceID.Malformed/);
assert.match(run(a, "aws ec2 describe-instances --instance-ids i-0123456789abcdef0"), /InvalidInstanceID.NotFound\) when calling the DescribeInstances operation: The instance ID 'i-0123456789abcdef0' does not exist/);
assert.match(run(a, "aws s3 ls s3://no-such-bucket-here"), /NoSuchBucket\) when calling the ListObjectsV2 operation: The specified bucket does not exist/);
assert.match(run(a, "aws sts get-caller-identity --profile nope"), /The config profile \(nope\) could not be found/);
assert.match(run(a, "aws ec2 describe-instances --query 'Reservations[' "), /Bad value for --query/);
assert.match(run(a, "aws sts get-caller-identity --output text"), /^111122223333\tarn:aws:sts::111122223333:assumed-role\/PlatformAdmin\/you\tAROA\w+:you$/);
assert.match(run(a, "frobnicate"), /zsh: command not found: frobnicate/);
assert.strictEqual(run(a, "aws sts get-caller-identity --query Account --output text"), ACCOUNT);
assert.match(run(a, "aws sts get-caller-identity | jq -r .Arn"), /^arn:aws:sts::/);

console.log(`playground ok: ${SCENARIOS.length} scenarios in ${GROUPS.length} groups, every fix and wrong move checked`);
