################################################################################
# Module: privatelink
#
# VPC Endpoint Service exposing the disclosure-service (gRPC, port 50051) from
# the restricted account to the core account.
#
# Architecture:
#   restricted-account VPC → NLB → disclosure-service pods
#                                     ↑
#   core-account VPC endpoint ────────┘  (PrivateLink, mTLS on top)
#
# The endpoint service only accepts connections from the core account's VPC.
# mTLS (Istio workload identities) provides a second authentication layer on
# top of the PrivateLink network boundary (ADR-0004).
#
# This module is instantiated in the RESTRICTED ACCOUNT.
# The corresponding `aws_vpc_endpoint` is created in the core account env.
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

locals {
  common_tags = merge(var.tags, {
    "chronos:module" = "privatelink"
    "chronos:env"    = var.env
  })
}

# ---------------------------------------------------------------------------
# Network Load Balancer fronting the disclosure-service
# ---------------------------------------------------------------------------
resource "aws_lb" "disclosure" {
  name               = "${var.prefix}-${var.env}-disclosure-nlb"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.subnet_ids

  enable_deletion_protection       = var.env != "dev"
  enable_cross_zone_load_balancing = true

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-disclosure-nlb" })
}

resource "aws_lb_target_group" "disclosure_grpc" {
  name        = "${var.prefix}-${var.env}-disclosure-grpc"
  port        = 50051
  protocol    = "TCP"
  vpc_id      = var.vpc_id
  target_type = "ip" # EKS pod IPs

  health_check {
    enabled             = true
    protocol            = "TCP"
    port                = "50051"
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 30
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "disclosure_grpc" {
  load_balancer_arn = aws_lb.disclosure.arn
  port              = 50051
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.disclosure_grpc.arn
  }

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# VPC Endpoint Service
# ---------------------------------------------------------------------------
resource "aws_vpc_endpoint_service" "disclosure" {
  acceptance_required        = true # connections must be accepted explicitly
  network_load_balancer_arns = [aws_lb.disclosure.arn]

  allowed_principals = [
    "arn:aws:iam::${var.core_account_id}:root"
  ]

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-disclosure-endpoint-svc" })
}

# ---------------------------------------------------------------------------
# Security group for the NLB (only core account CIDR via PrivateLink)
# ---------------------------------------------------------------------------
resource "aws_security_group" "disclosure_nlb" {
  name        = "${var.prefix}-${var.env}-disclosure-nlb-sg"
  description = "Allow gRPC from PrivateLink ENIs in the core account"
  vpc_id      = var.vpc_id

  ingress {
    description = "gRPC from core account via PrivateLink"
    from_port   = 50051
    to_port     = 50051
    protocol    = "tcp"
    cidr_blocks = var.core_account_vpc_cidrs
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-disclosure-nlb-sg" })
}
