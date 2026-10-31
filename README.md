# DevOps Nimbus AWS

**AWS, zero to on-call.** Hands-on AWS examples, CloudFormation templates and CLI notes, with a free learning site where you fix 60 incidents in a simulated AWS account and follow a 22-level path, for cloud and DevOps engineers.

[![Learning site](https://img.shields.io/badge/learn-DevOps%20Nimbus-1d1d1f)](https://sandeepkomal.github.io/AWS/)
[![CI](https://github.com/SandeepKomal/AWS/actions/workflows/ci.yml/badge.svg)](https://github.com/SandeepKomal/AWS/actions/workflows/ci.yml)
[![Pages](https://github.com/SandeepKomal/AWS/actions/workflows/pages.yml/badge.svg)](https://github.com/SandeepKomal/AWS/actions/workflows/pages.yml)
[![AWS](https://img.shields.io/badge/AWS-cloud-FF9900)](https://docs.aws.amazon.com/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![No trackers](https://img.shields.io/badge/site-no%20trackers%20%C2%B7%20no%20cookies-2ea44f)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen)](CONTRIBUTING.md)
![Last commit](https://img.shields.io/github/last-commit/SandeepKomal/AWS)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/AWS?style=social)](https://github.com/SandeepKomal/AWS/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/AWS?style=social)](https://github.com/SandeepKomal/AWS/network/members)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/SandeepKomal/AWS)

**[Open the learning site](https://sandeepkomal.github.io/AWS/)** · [Troubleshoot an error](https://sandeepkomal.github.io/AWS/#doctor) · [Every error on one page](https://sandeepkomal.github.io/AWS/problems.html) · [All DevOps Nimbus tracks](https://sandeepkomal.github.io/devops-nimbus/)

## Contents

- [Learn it in your browser](#learn-it-in-your-browser)
- [What's in this repository](#whats-in-this-repository)
- [Quick start](#quick-start)
- [CloudFormation](#cloudformation)
- [Important modernization notes](#important-modernization-notes)
- [Roadmap](#roadmap)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [Privacy and cost](#privacy-and-cost)
- [License and trademarks](#license-and-trademarks)
- [Author and contributors](#author-and-contributors)

## Learn it in your browser

**[sandeepkomal.github.io/AWS](https://sandeepkomal.github.io/AWS/)** is a free site built from this repository:

- **Playground**: a simulated AWS account in your browser with 60 incidents to fix using real `aws` CLI commands and real error messages: AccessDenied, explicit denies, trust policies, NAT, routing and peering, ALB 502/503/504, CloudFront certificates and caching, ECS image pulls, EKS access, secret rotation, DynamoDB and SQS, CORS, public buckets, KMS key policies, IMDSv1, leaked keys, throttling and runaway costs. It never touches a real account.
- **Path**: 22 levels from your first `aws sts get-caller-identity` to CI/CD with GitHub OIDC, each linked to the notes in this repository.
- **Policy X-ray**: paste an IAM, trust, bucket or key policy and read every statement in plain words, with risky patterns flagged.
- **Troubleshoot**: paste an AWS error to find what it means, how to confirm the cause, the fix and how to prevent it. Every entry is also on one plain page, [problems.html](https://sandeepkomal.github.io/AWS/problems.html).
- **Quiz**, **cheat sheet** and an interactive **architecture** page.
- **Scoreboard**: a score with ranks, a skill radar, learning uptime and on-call shifts against the clock, with Download and Load progress to move it between browsers.

The site is static (`site/`), with no dependencies, trackers or cookies. Run the tests with Node:

```bash
node tests/check_site_data.js && node tests/check_playground.js && node tests/fuzz_playground.js && node tests/check_xray.js && node tests/check_problems.js
node tools/build-problems.js   # after changing the troubleshooting entries in site/data.js
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

## What's in this repository

Hands-on **AWS examples, AWS CLI commands, CloudFormation templates, networking labs, IAM guidance, EC2/RDS/EFS/EBS/ALB/ASG/SSM examples, and application deployment notes**.

This repository is built as a practical reference for cloud and DevOps engineers learning or operating AWS environments.

### AWS topics covered

- VPC, public/private subnets, route tables, Internet Gateway and NAT Gateway
- EC2, user data, Elastic IP and AWS CLI
- IAM roles, policies and trust relationships
- Application Load Balancer
- Auto Scaling Groups and Launch Templates
- EBS and EFS
- RDS MySQL
- Route 53
- Systems Manager (SSM)
- CloudFormation
- Java application deployment on EC2
- Docker-based application deployment
- Linux server basics

### Who is this for?

- AWS beginners
- Cloud engineers
- DevOps engineers
- SREs
- System administrators
- Engineers preparing for AWS interviews
- Engineers building AWS infrastructure labs

## Quick start

### 1. Build an AWS network

Begin with the VPC examples:

[ VPC CloudFormation ](./AWS/VPC/vpc-batch12.yaml)

Learn:

- VPC CIDR planning
- Public vs private subnets
- Route tables
- Internet Gateway
- NAT Gateway
- Availability Zones

### 2. Compute

[EC2 CloudFormation](./AWS/EC2/ec2_cft.yaml)

[EC2 AWS CLI examples](./AWS/EC2/aws_cli_ec2.txt)

[User data examples](./AWS/EC2/userdata-1.txt)

### 3. Storage and databases

- [EBS](./AWS/EBS/ebs.yaml)
- [EFS](./AWS/EFS/efs-cft.yaml)
- [RDS MySQL](./AWS/RDS/mysql-rds.yaml)

### 4. Load balancing and scaling

- [Application Load Balancer](./AWS/ALB/alb.yaml)
- [Auto Scaling Group](./AWS/ASG/asg.yaml)

### 5. Identity and access

See [IAM.md](./IAM.md) and the IAM examples under [AWS/IAM](./AWS/IAM).

> Use least-privilege policies for real environments. Several examples in this repository are intentionally simplified for learning.

## CloudFormation

The repository includes CloudFormation examples for core AWS infrastructure.

Before deploying any template:

1. Review hard-coded IDs, regions, security groups and subnet IDs.
2. Replace environment-specific values.
3. Validate the template.
4. Deploy in a non-production account first.

Example validation:

```bash
aws cloudformation validate-template --template-body file://template.yaml
```

## Important modernization notes

Some historical files use older instance types, region-specific AMI/subnet IDs, or simplified configurations. AWS resources are region-specific and can change over time.

Treat these files as **learning templates**, not drop-in production infrastructure.

## Roadmap

Planned additions:

- IAM least-privilege patterns
- AWS Organizations and multi-account structure
- CloudTrail and centralized audit logging
- CloudWatch metrics, logs and alarms
- AWS Config
- Secrets Manager and Parameter Store
- KMS and encryption patterns
- S3 security and lifecycle management
- Lambda
- API Gateway
- ECS and Fargate
- EKS
- EventBridge
- SQS and SNS
- AWS Backup
- Disaster recovery
- Well-Architected operational patterns
- Cost optimization
- Terraform alongside CloudFormation
- CI/CD with GitHub Actions and AWS

## Repository layout

```text
AWS/
├── ALB/
├── ASG/
├── EBS/
├── EC2/
├── EFS/
├── IAM/
├── RDS/
├── Route 53/
├── SSM/
└── VPC/

Deployments/
├── Deploy Java App on EC2/
├── Deploy Java App using Docker/
├── Frontend deployment/
└── Roles & Responsibilities

IAM.md
Linux/
site/        DevOps Nimbus AWS, the learning site (GitHub Pages)
tests/       Node checks for the site: data, simulator, fuzzer, X-ray, problems page
tools/       build-problems.js: generates site/problems.html and site/sitemap.xml
```

## Troubleshooting

- Paste an AWS error into [Troubleshoot](https://sandeepkomal.github.io/AWS/#doctor) on the learning site for what it means, how to confirm the cause and the fix.
- Every error is also on one plain page: [problems.html](https://sandeepkomal.github.io/AWS/problems.html).

### Practical AWS troubleshooting flow

```text
AWS Console / CLI
       |
       v
Identity / IAM
       |
       v
VPC / subnet / route
       |
       v
Security group / NACL
       |
       v
Load balancer / target health
       |
       v
EC2 / application logs
       |
       v
RDS / EFS / EBS dependencies
```

## Contributing

Corrections, safer examples, new AWS services, updated CloudFormation templates, troubleshooting guides and practical labs are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

CI runs the site tests shown in [Learn it in your browser](#learn-it-in-your-browser); run them before opening a pull request.

### Support the project

If this repository helps you learn AWS or solve an infrastructure problem, consider giving it a star. It helps other cloud and DevOps engineers discover the material.

## Security

Please report a suspected vulnerability privately, as described in [SECURITY.md](SECURITY.md), rather than in a public issue. See also the [security checklist](docs/security-checklist.md). CI runs the site tests; no security scanner runs in CI yet.

### Security notes

Do not commit:

- AWS access keys
- secret access keys
- session credentials
- private keys
- passwords
- production account IDs when your organization's policy requires them to remain private

Also review the existing templates before production use. Some historical examples contain permissive rules such as `0.0.0.0/0` ingress and public database access because they were created as learning exercises.

## Privacy and cost

The learning site runs in your browser: no accounts, cookies, trackers or database, and the playground never touches a real AWS account. Your progress stays in your browser unless you download it as a file. The site is free and hosted on GitHub Pages.

Deploying the templates and examples in this repository creates real AWS resources, which can incur charges; delete them when you are finished. See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## License and trademarks

Released under the [MIT License](LICENSE).

Amazon Web Services, AWS and related marks are trademarks of Amazon.com, Inc. or its affiliates. This project is independent and not affiliated with or endorsed by Amazon Web Services.

## Author and contributors

**Sandeep Komal** · [github.com/SandeepKomal](https://github.com/SandeepKomal)

Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation and DevSecOps.

Built and maintained with [DevopsNimbus](https://github.com/DevopsNimbus). See everyone who has contributed in the [contributors graph](https://github.com/SandeepKomal/AWS/graphs/contributors).

If this helped you, a ⭐ on the repository helps others find it.
