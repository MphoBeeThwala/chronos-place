################################################################################
# Module: org
#
# Manages AWS Organizations Service Control Policies (SCPs) that apply to
# all member accounts. These are attached by the management account.
#
# SCPs enforced:
#   - All data-plane resources must land in af-south-1 (POPIA data residency).
#   - Global services (IAM, Route53, CloudFront, etc.) are exempt.
#   - CloudTrail and GuardDuty may not be disabled or deleted.
#   - Root account access is blocked.
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
  # Services that operate globally and must be reachable from any region.
  global_services = [
    "iam",
    "sts",
    "route53",
    "route53domains",
    "cloudfront",
    "waf",
    "shield",
    "support",
    "trustedadvisor",
    "health",
    "organizations",
    "billingconductor",
    "ce",
    "budgets",
    "account",
  ]
}

# ---------------------------------------------------------------------------
# SCP: enforce af-south-1 data residency
# ---------------------------------------------------------------------------
resource "aws_organizations_policy" "deny_non_af_south_1" {
  name        = "${var.prefix}-deny-non-af-south-1"
  description = "Deny resource creation outside af-south-1 for all non-global services. POPIA data residency."
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonAfSouth1"
        Effect = "Deny"
        NotAction = concat(
          [for s in local.global_services : "${s}:*"],
          [
            # S3 bucket operations that are global by nature
            "s3:GetBucketLocation",
            "s3:ListAllMyBuckets",
            # Support console
            "support:*",
          ]
        )
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "aws:RequestedRegion" = ["af-south-1"]
          }
        }
      }
    ]
  })

  tags = var.tags
}

# ---------------------------------------------------------------------------
# SCP: protect audit controls – deny disabling CloudTrail / GuardDuty
# ---------------------------------------------------------------------------
resource "aws_organizations_policy" "protect_audit_controls" {
  name        = "${var.prefix}-protect-audit-controls"
  description = "Prevent disabling or deleting CloudTrail and GuardDuty."
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyDisableCloudTrail"
        Effect = "Deny"
        Action = [
          "cloudtrail:DeleteTrail",
          "cloudtrail:StopLogging",
          "cloudtrail:UpdateTrail",
          "cloudtrail:DeleteEventDataStore",
          "cloudtrail:StopImport",
        ]
        Resource = "*"
      },
      {
        Sid    = "DenyDisableGuardDuty"
        Effect = "Deny"
        Action = [
          "guardduty:DeleteDetector",
          "guardduty:DisassociateFromMasterAccount",
          "guardduty:DisassociateMembers",
          "guardduty:StopMonitoringMembers",
          "guardduty:UpdateDetector",
        ]
        Resource = "*"
        Condition = {
          BoolIfExists = {
            "guardduty:DisableOrganizationAdminAccount" = "true"
          }
        }
      },
      {
        Sid    = "DenyDisableSecurityHub"
        Effect = "Deny"
        Action = [
          "securityhub:DeleteHub",
          "securityhub:DisableSecurityHub",
        ]
        Resource = "*"
      }
    ]
  })

  tags = var.tags
}

# ---------------------------------------------------------------------------
# SCP: block root account usage
# ---------------------------------------------------------------------------
resource "aws_organizations_policy" "deny_root_access" {
  name        = "${var.prefix}-deny-root-access"
  description = "Prevent use of the root user in all member accounts."
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyRootAccess"
        Effect = "Deny"
        Action = ["*"]
        Resource = "*"
        Condition = {
          StringLike = {
            "aws:PrincipalArn" = ["arn:aws:iam::*:root"]
          }
        }
      }
    ]
  })

  tags = var.tags
}

# ---------------------------------------------------------------------------
# SCP: restricted-zone isolation
# Restricted accounts may only be accessed from the core account PrivateLink.
# ---------------------------------------------------------------------------
resource "aws_organizations_policy" "restricted_zone_isolation" {
  name        = "${var.prefix}-restricted-zone-isolation"
  description = "Restrict direct internet access and enforce VPC-only access in restricted accounts."
  type        = "SERVICE_CONTROL_POLICY"

  content = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyNonVpcAccess"
        Effect = "Deny"
        Action = [
          "rds:*",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:ReEncrypt*",
          "secretsmanager:GetSecretValue",
        ]
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "aws:SourceVpc" = [var.restricted_vpc_id]
          }
        }
      }
    ]
  })

  tags = var.tags
}

# ---------------------------------------------------------------------------
# Attach SCPs to the Organizational Units
# ---------------------------------------------------------------------------
resource "aws_organizations_policy_attachment" "data_residency" {
  for_each  = toset(var.target_ou_ids)
  policy_id = aws_organizations_policy.deny_non_af_south_1.id
  target_id = each.value
}

resource "aws_organizations_policy_attachment" "audit_controls" {
  for_each  = toset(var.target_ou_ids)
  policy_id = aws_organizations_policy.protect_audit_controls.id
  target_id = each.value
}

resource "aws_organizations_policy_attachment" "root_access" {
  for_each  = toset(var.target_ou_ids)
  policy_id = aws_organizations_policy.deny_root_access.id
  target_id = each.value
}

resource "aws_organizations_policy_attachment" "restricted_isolation" {
  for_each  = toset(var.restricted_ou_ids)
  policy_id = aws_organizations_policy.restricted_zone_isolation.id
  target_id = each.value
}
