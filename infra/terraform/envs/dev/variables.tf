variable "key_admin_arns" {
  description = "IAM principal ARNs that can administer KMS keys (e.g., platform team role ARNs)."
  type        = list(string)
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach the EKS public API endpoint. Restrict to your team's IPs."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "disclosure_service_role_arns" {
  description = "IAM role ARNs for the disclosure-service pod (IRSA). Needed for vault KMS and erasure ledger S3 access."
  type        = list(string)
  default     = []
}

variable "ci_role_arns" {
  description = "IAM role ARNs for GitHub Actions OIDC CI runners that push images to ECR."
  type        = list(string)
}

variable "core_account_id" {
  description = "AWS account ID of the core account. In dev this is typically the same account."
  type        = string
}
