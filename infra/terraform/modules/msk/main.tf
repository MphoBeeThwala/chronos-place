################################################################################
# Module: msk
#
# Amazon MSK (Managed Streaming for Apache Kafka) cluster.
# Kafka is the async backbone for domain events (account.*, match.*, etc.).
# Health data is NEVER published to any Kafka topic (CLAUDE.md rule 3).
#
# Configuration:
#   - MSK Serverless (scales automatically; no broker management)
#   - IAM authentication only (no plaintext SASL/SCRAM)
#   - Encryption in transit (TLS) and at rest (KMS)
#   - Broker logs shipped to CloudWatch Logs
#   - Private subnets only; no public access
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

locals {
  common_tags = merge(var.tags, {
    "chronos:module" = "msk"
    "chronos:env"    = var.env
  })

  cluster_name = "${var.prefix}-${var.env}-kafka"
}

# ---------------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "msk" {
  name        = "${local.cluster_name}-sg"
  description = "MSK broker access from EKS pods"
  vpc_id      = var.vpc_id

  ingress {
    description     = "Kafka TLS (IAM auth) from application pods"
    from_port       = 9098
    to_port         = 9098
    protocol        = "tcp"
    security_groups = var.allowed_security_group_ids
  }

  tags = merge(local.common_tags, { Name = "${local.cluster_name}-sg" })
}

# ---------------------------------------------------------------------------
# CloudWatch log group for broker logs
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "broker_logs" {
  name              = "/aws/msk/${local.cluster_name}/broker-logs"
  retention_in_days = 30
  kms_key_id        = var.logs_kms_key_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# MSK Serverless Cluster
# ---------------------------------------------------------------------------
resource "aws_msk_serverless_cluster" "this" {
  cluster_name = local.cluster_name

  vpc_config {
    subnet_ids         = var.subnet_ids
    security_group_ids = [aws_security_group.msk.id]
  }

  client_authentication {
    sasl {
      iam {
        enabled = true
      }
    }
  }

  tags = merge(local.common_tags, { Name = local.cluster_name })
}

# ---------------------------------------------------------------------------
# IAM policy document for producer/consumer access
# Services attach this policy to their task/pod roles.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "kafka_producer" {
  statement {
    sid    = "KafkaProducer"
    effect = "Allow"
    actions = [
      "kafka-cluster:Connect",
      "kafka-cluster:AlterCluster",
      "kafka-cluster:DescribeCluster",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:CreateTopic",
      "kafka-cluster:WriteData",
      "kafka-cluster:WriteDataIdempotently",
    ]
    resources = [
      aws_msk_serverless_cluster.this.arn,
      "${aws_msk_serverless_cluster.this.arn}/*",
    ]
  }
}

data "aws_iam_policy_document" "kafka_consumer" {
  statement {
    sid    = "KafkaConsumer"
    effect = "Allow"
    actions = [
      "kafka-cluster:Connect",
      "kafka-cluster:DescribeCluster",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:DescribeGroup",
      "kafka-cluster:AlterGroup",
      "kafka-cluster:ReadData",
    ]
    resources = [
      aws_msk_serverless_cluster.this.arn,
      "${aws_msk_serverless_cluster.this.arn}/*",
    ]
  }
}

resource "aws_iam_policy" "kafka_producer" {
  name        = "${local.cluster_name}-producer"
  description = "Allow Kafka producer access to ${local.cluster_name}"
  policy      = data.aws_iam_policy_document.kafka_producer.json
  tags        = local.common_tags
}

resource "aws_iam_policy" "kafka_consumer" {
  name        = "${local.cluster_name}-consumer"
  description = "Allow Kafka consumer access to ${local.cluster_name}"
  policy      = data.aws_iam_policy_document.kafka_consumer.json
  tags        = local.common_tags
}
