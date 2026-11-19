variable "prefix" {
  description = "Short prefix for all resource names."
  type        = string
}

variable "env" {
  description = "Environment name (dev | staging | prod)."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/20"
}

variable "single_nat_gateway" {
  description = "Use a single NAT gateway for all private subnets. Set true in dev to cut cost."
  type        = bool
  default     = false
}

variable "flow_log_kms_key_arn" {
  description = "KMS key ARN used to encrypt the VPC Flow Log CloudWatch log group. Leave empty to use the default AWS-managed key."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to all resources."
  type        = map(string)
  default     = {}
}
