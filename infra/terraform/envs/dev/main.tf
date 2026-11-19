################################################################################
# Environment: dev
#
# Wires all modules together for the development environment.
# Cost-saving choices for dev:
#   - Single NAT gateway
#   - Public EKS API endpoint (no bastion needed)
#   - t3.medium nodes (2–4)
#   - Aurora Serverless v2 min 0.5 ACU
#   - ElastiCache Serverless small limits
#   - No deletion protection on Aurora
#   - Mutable ECR image tags
#   - Skip final DB snapshot
#
# Terraform state: S3 backend in shared-services account (see backend.tf).
################################################################################

terraform {
  required_version = ">= 1.9"

  backend "s3" {
    # Populated via -backend-config flags or backend.hcl (see README).
    # bucket         = "chronos-terraform-state-<shared-services-account-id>"
    # key            = "envs/dev/terraform.tfstate"
    # region         = "af-south-1"
    # dynamodb_table = "chronos-terraform-locks"
    # encrypt        = true
    # kms_key_id     = "<state-kms-key-arn>"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = "af-south-1"

  default_tags {
    tags = local.common_tags
  }
}

# ---------------------------------------------------------------------------
# Locals
# ---------------------------------------------------------------------------
locals {
  prefix = "chronos"
  env    = "dev"

  common_tags = {
    "chronos:project" = "chronos-place"
    "chronos:env"     = local.env
    "chronos:managed" = "terraform"
    "chronos:repo"    = "MphoBeeThwala/chronos-place"
  }
}

# ---------------------------------------------------------------------------
# KMS (must be first; other modules reference key ARNs)
# ---------------------------------------------------------------------------
module "kms" {
  source = "../../modules/kms"

  prefix = local.prefix
  env    = local.env

  key_admin_arns               = var.key_admin_arns
  disclosure_service_role_arns = var.disclosure_service_role_arns
  vault_key_store_id           = "" # dev: standard KMS key store

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------
module "vpc" {
  source = "../../modules/vpc"

  prefix             = local.prefix
  env                = local.env
  vpc_cidr           = "10.0.0.0/20"
  single_nat_gateway = true # cost-saving for dev
  flow_log_kms_key_arn = module.kms.logs_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# EKS
# ---------------------------------------------------------------------------
module "eks" {
  source = "../../modules/eks"

  prefix             = local.prefix
  env                = local.env
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids
  kms_key_arn        = module.kms.logs_key_arn # EKS secrets + EBS
  public_api_access  = true
  public_access_cidrs = var.allowed_cidr_blocks

  node_instance_types = ["t3.medium"]
  node_desired        = 2
  node_min            = 1
  node_max            = 4

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Aurora – core (PostGIS)
# ---------------------------------------------------------------------------
module "aurora_core" {
  source = "../../modules/aurora"

  prefix    = local.prefix
  env       = local.env
  tier      = "core"
  vpc_id    = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  kms_key_arn                = module.kms.core_db_key_arn
  secrets_kms_key_arn        = module.kms.key_arns["secrets"]
  backup_retention_days      = 7
  serverless_min_acu         = 0.5
  serverless_max_acu         = 4
  reader_count               = 0 # dev: writer-only

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Aurora – vault (restricted; plain PostgreSQL, no PostGIS)
# ---------------------------------------------------------------------------
module "aurora_vault" {
  source = "../../modules/aurora"

  prefix     = local.prefix
  env        = local.env
  tier       = "vault"
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  # In a real restricted account this would be the disclosure-service pod SG.
  # In dev they share the same cluster, so we reuse the EKS cluster SG.
  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  kms_key_arn                = module.kms.key_arns["vault_db"]
  secrets_kms_key_arn        = module.kms.key_arns["secrets"]
  backup_retention_days      = 7
  serverless_min_acu         = 0.5
  serverless_max_acu         = 2
  reader_count               = 0

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ElastiCache (Redis)
# ---------------------------------------------------------------------------
module "elasticache" {
  source = "../../modules/elasticache"

  prefix     = local.prefix
  env        = local.env
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  kms_key_arn                = module.kms.key_arns["elasticache"]
  secrets_kms_key_arn        = module.kms.key_arns["secrets"]
  max_data_storage_gb        = 5
  max_ecpu_per_second        = 5000

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# MSK (Kafka)
# ---------------------------------------------------------------------------
module "msk" {
  source = "../../modules/msk"

  prefix     = local.prefix
  env        = local.env
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  allowed_security_group_ids = [module.eks.cluster_security_group_id]
  logs_kms_key_arn           = module.kms.logs_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# S3 + CloudFront
# ---------------------------------------------------------------------------
module "s3" {
  source = "../../modules/s3"

  prefix = local.prefix
  env    = local.env

  media_kms_key_arn            = module.kms.key_arns["s3_media"]
  logs_kms_key_arn             = module.kms.key_arns["s3_logs"]
  disclosure_service_role_arns = var.disclosure_service_role_arns

  # Dev: no custom domains; use default CloudFront certs
  assets_domain_aliases = []
  media_acm_cert_arn    = ""
  assets_acm_cert_arn   = ""

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Secrets Manager + ESO IAM
# ---------------------------------------------------------------------------
module "secrets" {
  source = "../../modules/secrets"

  prefix              = local.prefix
  env                 = local.env
  eks_oidc_provider_arn = module.eks.oidc_provider_arn
  eks_oidc_issuer     = module.eks.oidc_provider_url
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECR
# ---------------------------------------------------------------------------
module "ecr" {
  source = "../../modules/ecr"

  prefix    = local.prefix
  env       = local.env
  ecr_kms_key_arn   = module.kms.key_arns["ecr"]
  ci_role_arns      = var.ci_role_arns
  eks_node_role_arns = [module.eks.node_role_arn]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# PrivateLink (disclosure-service endpoint)
# Note: in dev both core and vault run in the same account/VPC.
# The endpoint service is still created so the pattern is exercised.
# ---------------------------------------------------------------------------
module "privatelink" {
  source = "../../modules/privatelink"

  prefix     = local.prefix
  env        = local.env
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnet_ids

  core_account_id        = var.core_account_id
  core_account_vpc_cidrs = [module.vpc.vpc_cidr]

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# VPC endpoint (core side) pointing to the disclosure endpoint service
# ---------------------------------------------------------------------------
resource "aws_vpc_endpoint" "disclosure" {
  vpc_id              = module.vpc.vpc_id
  service_name        = module.privatelink.endpoint_service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnet_ids
  security_group_ids  = [aws_security_group.disclosure_endpoint.id]
  private_dns_enabled = false

  tags = merge(local.common_tags, { Name = "chronos-dev-disclosure-endpoint" })
}

resource "aws_security_group" "disclosure_endpoint" {
  name        = "chronos-dev-disclosure-endpoint-sg"
  description = "Allow gRPC from EKS pods to the disclosure PrivateLink endpoint"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "gRPC from EKS pods"
    from_port       = 50051
    to_port         = 50051
    protocol        = "tcp"
    security_groups = [module.eks.cluster_security_group_id]
  }

  tags = merge(local.common_tags, { Name = "chronos-dev-disclosure-endpoint-sg" })
}
