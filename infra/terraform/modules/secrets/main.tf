################################################################################
# Module: secrets
#
# Secrets Manager baseline and External Secrets Operator (ESO) IAM.
#
# - Creates an IAM role for ESO running in EKS (IRSA / Pod Identity).
#   ESO syncs secrets from Secrets Manager into Kubernetes Secrets.
# - Creates a resource-based policy that allows the ESO role to read
#   secrets in a given path prefix (e.g. "chronos/dev/").
# - Each service's actual secrets are created by other modules (aurora,
#   elasticache, etc.) – this module only sets up the IAM plumbing.
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
    "chronos:module" = "secrets"
    "chronos:env"    = var.env
  })
}

# ---------------------------------------------------------------------------
# ESO IAM role (IRSA)
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "eso_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.eks_oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.eso_namespace}:${var.eso_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.eks_oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eso" {
  name               = "${var.prefix}-${var.env}-eso"
  assume_role_policy = data.aws_iam_policy_document.eso_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "eso_permissions" {
  statement {
    sid    = "ReadSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
    ]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${var.prefix}/${var.env}/*"
    ]
  }

  statement {
    sid    = "DecryptSecrets"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.secrets_kms_key_arn]
  }

  statement {
    sid    = "ListSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:ListSecrets",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "eso_permissions" {
  name   = "eso-secrets-access"
  role   = aws_iam_role.eso.id
  policy = data.aws_iam_policy_document.eso_permissions.json
}

# ---------------------------------------------------------------------------
# Service-to-service secrets access policies
# Each service gets a policy it can attach to its own IRSA role.
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "service_secrets" {
  for_each = toset(var.service_names)

  statement {
    sid    = "ReadOwnSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:${var.prefix}/${var.env}/${each.key}/*"
    ]
  }

  statement {
    sid    = "DecryptOwnSecrets"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.secrets_kms_key_arn]
  }
}

resource "aws_iam_policy" "service_secrets" {
  for_each    = toset(var.service_names)
  name        = "${var.prefix}-${var.env}-${each.key}-secrets"
  description = "Allow ${each.key} to read its own secrets in ${var.env}"
  policy      = data.aws_iam_policy_document.service_secrets[each.key].json
  tags        = local.common_tags
}
