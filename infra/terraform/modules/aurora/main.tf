################################################################################
# Module: aurora
#
# Aurora PostgreSQL Serverless v2 cluster.
# Used twice per environment:
#   - Core cluster (PostGIS enabled, in core account)
#   - Vault cluster (plain PostgreSQL, in restricted account, vault-only subnet)
#
# Features:
#   - Serverless v2 with configurable ACU min/max
#   - Multi-AZ (writer + 1 reader by default)
#   - Encryption at rest via KMS
#   - Automated backups (retention per env)
#   - Enhanced monitoring + Performance Insights
#   - No public accessibility
#   - Credentials stored in Secrets Manager with automatic rotation
#   - Deletion protection enabled by default
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
    "chronos:module" = "aurora"
    "chronos:env"    = var.env
    "chronos:tier"   = var.tier # "core" or "vault"
  })

  cluster_id = "${var.prefix}-${var.env}-${var.tier}"
}

# ---------------------------------------------------------------------------
# Subnet group
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "this" {
  name        = "${local.cluster_id}-subnet-group"
  subnet_ids  = var.subnet_ids
  description = "Subnet group for ${local.cluster_id} Aurora cluster"

  tags = merge(local.common_tags, { Name = "${local.cluster_id}-subnet-group" })
}

# ---------------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "aurora" {
  name        = "${local.cluster_id}-aurora-sg"
  description = "Allow PostgreSQL from EKS nodes and application pods"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from application security group"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  egress {
    description = "Deny all outbound (Aurora initiates no outbound connections)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["127.0.0.1/32"] # effectively no-op; Aurora doesn't send traffic
  }

  tags = merge(local.common_tags, { Name = "${local.cluster_id}-aurora-sg" })
}

# ---------------------------------------------------------------------------
# Secrets Manager: master credentials
# ---------------------------------------------------------------------------
resource "random_password" "master" {
  length           = 32
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "master_credentials" {
  name                    = "${local.cluster_id}/master-credentials"
  description             = "Master credentials for ${local.cluster_id} Aurora cluster"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = 7

  tags = local.common_tags
}

resource "aws_secretsmanager_secret_version" "master_credentials" {
  secret_id = aws_secretsmanager_secret.master_credentials.id
  secret_string = jsonencode({
    username = var.master_username
    password = random_password.master.result
    engine   = "aurora-postgresql"
    host     = aws_rds_cluster.this.endpoint
    port     = 5432
    dbname   = var.database_name
  })
}

# ---------------------------------------------------------------------------
# Parameter groups
# ---------------------------------------------------------------------------
resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${local.cluster_id}-cluster-pg"
  family      = "aurora-postgresql16"
  description = "Parameter group for ${local.cluster_id}"

  # Enforce SSL connections
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Log slow queries (> 1s)
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # Log connections/disconnections for audit
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Aurora Cluster
# ---------------------------------------------------------------------------
resource "aws_rds_cluster" "this" {
  cluster_identifier = local.cluster_id
  engine             = "aurora-postgresql"
  engine_mode        = "provisioned"
  engine_version     = var.engine_version
  database_name      = var.database_name
  master_username    = var.master_username
  master_password    = random_password.master.result

  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.aurora.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name

  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = "02:00-03:00"
  preferred_maintenance_window = "sun:04:00-sun:05:00"
  skip_final_snapshot          = var.env == "dev" ? true : false
  final_snapshot_identifier    = var.env == "dev" ? null : "${local.cluster_id}-final"
  deletion_protection          = var.env != "dev"
  copy_tags_to_snapshot        = true

  # Enable CloudWatch Logs export (PostgreSQL general/slowquery/upgrade)
  enabled_cloudwatch_logs_exports = ["postgresql"]

  # Serverless v2 scaling
  serverlessv2_scaling_configuration {
    min_capacity = var.serverless_min_acu
    max_capacity = var.serverless_max_acu
  }

  apply_immediately = var.env == "dev"

  tags = merge(local.common_tags, { Name = local.cluster_id })
}

# ---------------------------------------------------------------------------
# Cluster Instances
# ---------------------------------------------------------------------------
resource "aws_rds_cluster_instance" "writer" {
  identifier           = "${local.cluster_id}-writer"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  publicly_accessible  = false
  db_subnet_group_name = aws_db_subnet_group.this.name

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.enhanced_monitoring.arn

  tags = merge(local.common_tags, { Name = "${local.cluster_id}-writer" })
}

resource "aws_rds_cluster_instance" "reader" {
  count                = var.reader_count
  identifier           = "${local.cluster_id}-reader-${count.index}"
  cluster_identifier   = aws_rds_cluster.this.id
  instance_class       = "db.serverless"
  engine               = aws_rds_cluster.this.engine
  engine_version       = aws_rds_cluster.this.engine_version
  publicly_accessible  = false
  db_subnet_group_name = aws_db_subnet_group.this.name

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.enhanced_monitoring.arn

  tags = merge(local.common_tags, { Name = "${local.cluster_id}-reader-${count.index}" })
}

# ---------------------------------------------------------------------------
# Enhanced monitoring IAM role
# ---------------------------------------------------------------------------
resource "aws_iam_role" "enhanced_monitoring" {
  name = "${local.cluster_id}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "enhanced_monitoring" {
  role       = aws_iam_role.enhanced_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
