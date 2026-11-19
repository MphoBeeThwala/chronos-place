variable "prefix" { type = string }
variable "env" { type = string }

variable "eks_oidc_provider_arn" {
  description = "ARN of the EKS OIDC provider (for IRSA)."
  type        = string
}

variable "eks_oidc_issuer" {
  description = "OIDC issuer URL (without https://) for the EKS cluster."
  type        = string
}

variable "eso_namespace" {
  description = "Kubernetes namespace where External Secrets Operator runs."
  type        = string
  default     = "external-secrets"
}

variable "eso_service_account" {
  description = "Kubernetes service account name for External Secrets Operator."
  type        = string
  default     = "external-secrets"
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN used to encrypt Secrets Manager secrets."
  type        = string
}

variable "service_names" {
  description = "List of service names to create per-service secrets access policies for."
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
    "disclosure-service",
  ]
}

variable "tags" {
  type    = map(string)
  default = {}
}
