variable "prefix" {
  type = string
}

variable "env" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "allowed_security_group_ids" {
  type    = list(string)
  default = []
}

variable "kms_key_arn" {
  description = "KMS key ARN for ElastiCache at-rest encryption."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN for Secrets Manager."
  type        = string
}

variable "max_data_storage_gb" {
  description = "Maximum data storage in GB for serverless cache."
  type        = number
  default     = 5
}

variable "max_ecpu_per_second" {
  description = "Maximum ECPUs per second for serverless cache."
  type        = number
  default     = 5000
}

variable "tags" {
  type    = map(string)
  default = {}
}
