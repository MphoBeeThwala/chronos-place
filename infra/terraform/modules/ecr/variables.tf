variable "prefix" { type = string }
variable "env" { type = string }

variable "ecr_kms_key_arn" {
  description = "KMS key ARN for ECR image encryption."
  type        = string
}

variable "ci_role_arns" {
  description = "IAM role ARNs for CI runners (GitHub Actions OIDC roles) that push images."
  type        = list(string)
}

variable "eks_node_role_arns" {
  description = "IAM role ARNs for EKS node groups that pull images."
  type        = list(string)
}

variable "service_names" {
  description = "Core service names (non-restricted)."
  type        = list(string)
  default = [
    "gateway",
    "identity",
    "profile",
    "discovery",
    "matching",
    "messaging",
    "moderation",
    "notifications",
    "payments",
  ]
}

variable "restricted_service_names" {
  description = "Restricted service names (disclosure-service, vault migrations)."
  type        = list(string)
  default     = ["disclosure-service"]
}

variable "tags" {
  type    = map(string)
  default = {}
}
