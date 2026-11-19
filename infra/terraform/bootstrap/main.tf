################################################################################
# Bootstrap: Terraform state backend
#
# Run this ONCE manually from the shared-services account before any other
# Terraform apply. It creates:
#   - S3 bucket for Terraform state (versioned, encrypted, Object Lock)
#   - DynamoDB table for state locking
#   - KMS key for state encryption
#
# Apply with:
#   cd infra/terraform/bootstrap
#   terraform init
#   terraform apply
#
# Then use the outputs to populate envs/*/backend.hcl.
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

provider "aws" {
  region = "af-south-1"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  tags = {
    "chronos:project" = "chronos-place"
    "chronos:managed" = "terraform"
    "chronos:purpose" = "terraform-state"
  }
}

# ---------------------------------------------------------------------------
# KMS key for state encryption
# ---------------------------------------------------------------------------
resource "aws_kms_key" "state" {
  description             = "Chronos Terraform state encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  tags                    = local.tags
}

resource "aws_kms_alias" "state" {
  name          = "alias/chronos-terraform-state"
  target_key_id = aws_kms_key.state.key_id
}

# ---------------------------------------------------------------------------
# S3 state bucket
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "state" {
  bucket        = "chronos-terraform-state-${local.account_id}"
  force_destroy = false
  object_lock_enabled = true
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 90
    }
  }
}

# ---------------------------------------------------------------------------
# DynamoDB table for state locking
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "state_lock" {
  name         = "chronos-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = local.tags
}

output "state_bucket_name" {
  value = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}

output "lock_table_name" {
  value = aws_dynamodb_table.state_lock.name
}
