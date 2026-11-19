################################################################################
# Module: elasticache
#
# ElastiCache Serverless for Redis 7.
# Used for: session cache, rate-limit counters, feed cache, ranking features.
# Health data is NEVER stored in Redis (CLAUDE.md rule 3).
#
# Features:
#   - Serverless (scales automatically; no manual cluster sizing)
#   - Encryption in transit (TLS) and at rest (KMS)
#   - No auth-token plaintext: Secrets Manager holds the token
#   - Private subnets only
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  common_tags = merge(var.tags, {
    "chronos:module" = "elasticache"
    "chronos:env"    = var.env
  })

  cache_name = "${var.prefix}-${var.env}-redis"
}

# ---------------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "redis" {
  name        = "${local.cache_name}-sg"
  description = "Allow Redis access from EKS application pods"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Redis TLS from application pods"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  tags = merge(local.common_tags, { Name = "${local.cache_name}-sg" })
}

# ---------------------------------------------------------------------------
# Subnet group
# ---------------------------------------------------------------------------
resource "aws_elasticache_subnet_group" "this" {
  name        = "${local.cache_name}-subnet-group"
  subnet_ids  = var.subnet_ids
  description = "Subnet group for ${local.cache_name}"

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Auth token (stored in Secrets Manager)
# ---------------------------------------------------------------------------
resource "random_password" "auth_token" {
  length  = 64
  special = false # ElastiCache auth token: alphanumeric only
}

resource "aws_secretsmanager_secret" "auth_token" {
  name                    = "${local.cache_name}/auth-token"
  description             = "ElastiCache Redis auth token for ${local.cache_name}"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 7

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id     = aws_secretsmanager_secret.auth_token.id
  secret_string = jsonencode({ auth_token = random_password.auth_token.result })
}

# ---------------------------------------------------------------------------
# ElastiCache Serverless Cache
# ---------------------------------------------------------------------------
resource "aws_elasticache_serverless_cache" "this" {
  engine = "redis"
  name   = local.cache_name

  cache_usage_limits {
    data_storage {
      maximum = var.max_data_storage_gb
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = var.max_ecpu_per_second
    }
  }

  daily_snapshot_time      = "03:00"
  description              = "Chronos ${var.env} Redis cache"
  kms_key_id               = var.kms_key_arn
  major_engine_version     = "7"
  snapshot_retention_limit = var.env == "dev" ? 1 : 7

  security_group_ids = [aws_security_group.redis.id]
  subnet_ids         = var.subnet_ids

  user_group_id = aws_elasticache_user_group.this.id

  tags = merge(local.common_tags, { Name = local.cache_name })
}

# ---------------------------------------------------------------------------
# User group (AUTH token approach via user with password)
# ---------------------------------------------------------------------------
resource "aws_elasticache_user" "default" {
  user_id       = "${var.prefix}-${var.env}-redis-default"
  user_name     = "default"
  access_string = "off ~* &* -@all"
  engine        = "REDIS"
  passwords     = []
}

resource "aws_elasticache_user" "app" {
  user_id       = "${var.prefix}-${var.env}-redis-app"
  user_name     = "chronos-app"
  access_string = "on ~* &* +@all -@dangerous"
  engine        = "REDIS"
  passwords     = [random_password.auth_token.result]
}

resource "aws_elasticache_user_group" "this" {
  engine        = "REDIS"
  user_group_id = "${var.prefix}-${var.env}-redis-ug"
  user_ids      = [aws_elasticache_user.default.user_id, aws_elasticache_user.app.user_id]

  tags = local.common_tags

  lifecycle {
    ignore_changes = [user_ids]
  }
}
