################################################################################
# Module: kms
#
# Creates one KMS Customer Managed Key per data domain:
#   - core_db      : Aurora PostgreSQL (core)
#   - elasticache  : Redis at-rest encryption
#   - msk          : MSK broker disk encryption
#   - s3_media     : S3 media bucket
#   - s3_logs      : S3 log archive (Object Lock, erasure ledger)
#   - secrets      : Secrets Manager
#   - logs         : CloudWatch Logs (flow logs, EKS control plane logs)
#   - ecr          : ECR image encryption
#   - vault_db     : Aurora PostgreSQL (Health Vault) – restricted account
#   - vault_data   : AES DEK wrapping key (the CMK the disclosure-service uses
#                    for envelope encryption via GenerateDataKey / Decrypt)
#
# vault_data is the highest-sensitivity key. In prod it should be backed by a
# CloudHSM custom key store; that is wired by setting var.vault_key_store_id.
# In dev/staging it uses the default KMS key store.
#
# All keys: automatic annual rotation, deletion window 30 days.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  common_tags = merge(var.tags, {
    "chronos:module" = "kms"
    "chronos:env"    = var.env
  })

  # Base key policy: allows the account root full control so the key is never
  # orphaned, and the requesting principal can administer it. Services are
  # granted usage rights separately via IAM policies on their roles.
  base_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowAccountRoot"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${local.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "AllowKeyAdmins"
        Effect = "Allow"
        Principal = {
          AWS = var.key_admin_arns
        }
        Action = [
          "kms:Create*", "kms:Describe*", "kms:Enable*",
          "kms:List*", "kms:Put*", "kms:Update*",
          "kms:Revoke*", "kms:Disable*", "kms:Get*",
          "kms:Delete*", "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion", "kms:RotateKeyOnDemand",
        ]
        Resource = "*"
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Helper: local for each domain key definition
# ---------------------------------------------------------------------------
locals {
  # Keys created in this account (the core account or the restricted account
  # depending on how the module is called).
  key_definitions = {
    core_db = {
      description     = "Chronos ${var.env}: Aurora core DB encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    elasticache = {
      description     = "Chronos ${var.env}: ElastiCache Redis encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    msk = {
      description     = "Chronos ${var.env}: MSK broker disk encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    s3_media = {
      description     = "Chronos ${var.env}: S3 media bucket encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    s3_logs = {
      description     = "Chronos ${var.env}: S3 log archive / erasure ledger encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    secrets = {
      description     = "Chronos ${var.env}: Secrets Manager encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    logs = {
      description     = "Chronos ${var.env}: CloudWatch Logs encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    ecr = {
      description     = "Chronos ${var.env}: ECR image encryption"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    vault_db = {
      description     = "Chronos ${var.env}: Health Vault Aurora DB encryption (RESTRICTED)"
      rotation        = true
      key_store_id    = null
      usage_principal = []
    }
    vault_data = {
      description     = "Chronos ${var.env}: Health Vault DEK wrapping CMK (RESTRICTED – highest sensitivity)"
      rotation        = true
      key_store_id    = var.vault_key_store_id == "" ? null : var.vault_key_store_id
      usage_principal = var.disclosure_service_role_arns
    }
  }
}

# ---------------------------------------------------------------------------
# KMS Keys
# ---------------------------------------------------------------------------
resource "aws_kms_key" "keys" {
  for_each = local.key_definitions

  description              = each.value.description
  deletion_window_in_days  = 30
  enable_key_rotation      = each.value.rotation
  multi_region             = false
  custom_key_store_id      = each.value.key_store_id
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = each.value.key_store_id != null ? "SYMMETRIC_DEFAULT" : "SYMMETRIC_DEFAULT"

  policy = length(each.value.usage_principal) == 0 ? local.base_policy : jsonencode({
    Version = "2012-10-17"
    Statement = [
      jsondecode(local.base_policy).Statement[0],
      jsondecode(local.base_policy).Statement[1],
      {
        Sid    = "AllowDisclosureServiceUsage"
        Effect = "Allow"
        Principal = {
          AWS = each.value.usage_principal
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "kms:EncryptionContext:purpose" = "vault"
          }
        }
      }
    ]
  })

  tags = merge(local.common_tags, {
    Name              = "${var.prefix}-${var.env}-${each.key}"
    "chronos:key-domain" = each.key
  })
}

# ---------------------------------------------------------------------------
# Aliases
# ---------------------------------------------------------------------------
resource "aws_kms_alias" "keys" {
  for_each      = local.key_definitions
  name          = "alias/${var.prefix}-${var.env}-${each.key}"
  target_key_id = aws_kms_key.keys[each.key].key_id
}
