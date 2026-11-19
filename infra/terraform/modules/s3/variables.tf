variable "prefix" { type = string }
variable "env" { type = string }

variable "media_kms_key_arn" {
  description = "KMS key ARN for media and assets bucket encryption."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "KMS key ARN for logs and erasure ledger bucket encryption."
  type        = string
}

variable "disclosure_service_role_arns" {
  description = "IAM role ARNs of the disclosure-service. Granted PUT access to the erasure ledger bucket."
  type        = list(string)
  default     = []
}

variable "cloudfront_key_group_ids" {
  description = "CloudFront key group IDs for signed URL verification on the media distribution."
  type        = list(string)
  default     = []
}

variable "media_acm_cert_arn" {
  description = "ACM certificate ARN (us-east-1) for the media CloudFront distribution custom domain. Leave empty to use the default CloudFront certificate."
  type        = string
  default     = ""
}

variable "assets_domain_aliases" {
  description = "Custom domain aliases for the assets CloudFront distribution (e.g. ['app.chronosplace.com'])."
  type        = list(string)
  default     = []
}

variable "assets_acm_cert_arn" {
  description = "ACM certificate ARN (us-east-1) for the assets CloudFront distribution. Required when assets_domain_aliases is set."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
