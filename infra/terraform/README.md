# Chronos Place — Terraform Infrastructure (M0.11)

Terraform ≥ 1.9. AWS provider ~> 5.0. Region: **af-south-1** (Cape Town).

## Repository layout

```
infra/terraform/
  bootstrap/          One-time S3 state bucket + DynamoDB lock table setup
  modules/
    org/              AWS Organizations SCPs (data residency, audit controls, root access)
    vpc/              VPC, 3 AZs, public/private subnets, NAT gateways, Flow Logs
    eks/              EKS cluster, managed node groups, Karpenter, OIDC, add-ons
    aurora/           Aurora PostgreSQL Serverless v2 (core + vault tiers)
    elasticache/      ElastiCache Serverless for Redis
    msk/              Amazon MSK Serverless (Kafka)
    s3/               Media + assets + logs buckets, erasure ledger (Object Lock), CloudFront
    kms/              Per-domain CMKs (core_db, vault_db, vault_data, elasticache, etc.)
    secrets/          Secrets Manager IAM + External Secrets Operator IRSA role
    privatelink/      NLB + VPC Endpoint Service exposing disclosure-service from restricted→core
    ecr/              ECR repositories per service
  envs/
    dev/              Dev environment wiring all modules together
```

## First-time setup (once per AWS organisation)

1. Authenticate to the **shared-services** account.
2. Bootstrap Terraform state storage:
   ```sh
   cd infra/terraform/bootstrap
   terraform init
   terraform apply
   ```
3. Note the `state_bucket_name` and `state_kms_key_arn` outputs.

## Dev environment apply

```sh
cd infra/terraform/envs/dev

# 1. Copy and fill in the example files
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl
# Edit both files with real values

# 2. Initialise with the remote backend
terraform init -backend-config=backend.hcl

# 3. Plan (requires AWS credentials for the dev account)
terraform plan

# 4. Apply (needs approval)
terraform apply
```

> **Prod deployments need approval from a security owner** (spec §10.4). Never run `apply` on staging/prod without review.

## Module reference

### `kms`

Creates one CMK per data domain. The `vault_data` key is the highest-sensitivity
key — it wraps every member's health DEK. In production, set `vault_key_store_id`
to a CloudHSM custom key store ARN (spec §4.4).

### `aurora`

Used twice per environment with `tier = "core"` (PostGIS) and `tier = "vault"`
(restricted account). Backup retention is capped at 30 days (POPIA/spec §4.4).

### `s3`

The `erasure_ledger` bucket uses S3 Object Lock in COMPLIANCE mode (ADR-0014).
Objects written there cannot be deleted during the retention period — not even
by account root. Only the disclosure-service role may PUT to it.

### `privatelink`

Creates an NLB + VPC Endpoint Service in the restricted account. The core account
creates a corresponding `aws_vpc_endpoint` pointing at it. mTLS (via Istio, ADR-0004)
runs on top of the PrivateLink network boundary.

### `eks`

Post-apply Helm/Argo CD installs (not managed by Terraform, lives in `infra/k8s/`):

- Istio ambient mesh (ADR-0004)
- External Secrets Operator (syncs from Secrets Manager)
- AWS Load Balancer Controller
- Karpenter NodePool CRDs

## Security controls

| Control                                   | Where                                   |
| ----------------------------------------- | --------------------------------------- |
| Data residency SCP (af-south-1 only)      | `modules/org`                           |
| CloudTrail / GuardDuty cannot be disabled | `modules/org`                           |
| All storage encrypted at rest (KMS)       | All modules                             |
| IMDSv2 required on EC2 nodes              | `modules/eks` launch template           |
| No public DB endpoints                    | `modules/aurora`, `modules/elasticache` |
| Object Lock COMPLIANCE on erasure ledger  | `modules/s3`                            |
| VPC Flow Logs                             | `modules/vpc`                           |
| Aurora SSL enforced (`rds.force_ssl=1`)   | `modules/aurora` parameter group        |
| ECR image scanning on push                | `modules/ecr`                           |
| Checkov IaC scan gates CI                 | `.github/workflows/ci.yml`              |

## Adding a new environment (staging / prod)

1. `cp -r infra/terraform/envs/dev infra/terraform/envs/staging`
2. Update `envs/staging/main.tf`:
   - `env = "staging"`
   - `single_nat_gateway = false`
   - `public_api_access = false`
   - `node_instance_types = ["m6i.large"]`
   - Set `vault_key_store_id` to your CloudHSM custom key store ID
   - Increase ACU limits, enable reader instances on Aurora
3. Create `terraform.tfvars` and `backend.hcl` for the staging backend key.
