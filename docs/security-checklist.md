# AWS Security Checklist

Before deploying an AWS workload, review:

- [ ] IAM follows least privilege.
- [ ] Root account has MFA enabled and is not used for routine work.
- [ ] No long-lived access keys are committed to source control.
- [ ] Security groups expose only required ports and sources.
- [ ] Databases are private unless public access is explicitly required.
- [ ] Data is encrypted at rest and in transit where appropriate.
- [ ] Secrets use Secrets Manager or Parameter Store rather than source files.
- [ ] CloudTrail is enabled for required audit coverage.
- [ ] CloudWatch monitoring and alarms cover critical resources.
- [ ] Backups are configured and tested.
- [ ] Resource tags identify environment, owner and cost center.
- [ ] Infrastructure templates do not contain environment-specific IDs unnecessarily.
- [ ] Cost controls and budgets are configured.
