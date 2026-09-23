# AWS — Practical Cloud, DevOps & Infrastructure Reference

Hands-on **AWS examples, AWS CLI commands, CloudFormation templates, networking labs, IAM guidance, EC2/RDS/EFS/EBS/ALB/ASG/SSM examples, and application deployment notes**.

This repository is built as a practical reference for cloud and DevOps engineers learning or operating AWS environments.

## AWS topics covered

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

## Repository structure

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
```

## Start here

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

## Security notes

Do not commit:

- AWS access keys
- secret access keys
- session credentials
- private keys
- passwords
- production account IDs when your organization's policy requires them to remain private

Also review the existing templates before production use. Some historical examples contain permissive rules such as `0.0.0.0/0` ingress and public database access because they were created as learning exercises.

## Important modernization notes

Some historical files use older instance types, region-specific AMI/subnet IDs, or simplified configurations. AWS resources are region-specific and can change over time.

Treat these files as **learning templates**, not drop-in production infrastructure.

## Practical AWS troubleshooting flow

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

## Who is this for?

- AWS beginners
- Cloud engineers
- DevOps engineers
- SREs
- System administrators
- Engineers preparing for AWS interviews
- Engineers building AWS infrastructure labs

## Contributing

Corrections, safer examples, new AWS services, updated CloudFormation templates, troubleshooting guides and practical labs are welcome.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Support the project

If this repository helps you learn AWS or solve an infrastructure problem, consider giving it a star. It helps other cloud and DevOps engineers discover the material.

## Author

**Sandeep Komal**

Cloud / DevOps Engineer focused on AWS, Kubernetes, Terraform, CI/CD, automation and DevSecOps.
