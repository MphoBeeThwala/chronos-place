variable "prefix" { type = string }
variable "env" { type = string }
variable "vpc_id" { type = string }

variable "subnet_ids" {
  description = "Private subnet IDs for MSK brokers (at least 2 AZs)."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  type    = list(string)
  default = []
}

variable "logs_kms_key_arn" {
  description = "KMS key ARN for CloudWatch Logs encryption."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
