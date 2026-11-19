################################################################################
# Module: ecr
#
# ECR repositories for every service image.
# Features:
#   - Encryption with KMS
#   - Image scan on push (Basic scanning; switch to Enhanced/Inspector separately)
#   - Lifecycle policy: keep last 20 tagged images, expire untagged after 1 day
#   - Resource policy: allow pull from EKS node roles and push from CI role
#   - Immutable tags in staging/prod
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
    "chronos:module" = "ecr"
    "chronos:env"    = var.env
  })

  all_repos = concat(var.service_names, var.restricted_service_names)
}

resource "aws_ecr_repository" "repos" {
  for_each = toset(local.all_repos)

  name                 = "${var.prefix}/${each.key}"
  image_tag_mutability = var.env == "dev" ? "MUTABLE" : "IMMUTABLE"
  force_delete         = var.env == "dev"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.ecr_kms_key_arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, {
    Name = "${var.prefix}/${each.key}"
    "chronos:restricted" = contains(var.restricted_service_names, each.key) ? "true" : "false"
  })
}

# ---------------------------------------------------------------------------
# Lifecycle policy
# ---------------------------------------------------------------------------
resource "aws_ecr_lifecycle_policy" "repos" {
  for_each   = aws_ecr_repository.repos
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 20 tagged images"
        selection = {
          tagStatus   = "tagged"
          tagPrefixList = ["v", "sha-"]
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Repository policy: allow CI push + EKS node pull
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ecr_policy" {
  for_each = toset(local.all_repos)

  statement {
    sid    = "AllowCIPush"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = var.ci_role_arns
    }
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
  }

  statement {
    sid    = "AllowEKSNodePull"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = var.eks_node_role_arns
    }
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
  }
}

resource "aws_ecr_repository_policy" "repos" {
  for_each   = toset(local.all_repos)
  repository = aws_ecr_repository.repos[each.key].name
  policy     = data.aws_iam_policy_document.ecr_policy[each.key].json
}
