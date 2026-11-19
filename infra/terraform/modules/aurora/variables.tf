variable "prefix" {
  description = "Short prefix for resource names."
  type        = string
}

variable "env" {
  description = "Environment name (dev | staging | prod)."
  type        = string
}

variable "tier" {
  description = "Cluster tier identifier: 'core' or 'vault'."
  type        = string
  validation {
    condition     = contains(["core", "vault"], var.tier)
    error_message = "tier must be 'core' or 'vault'."
  }
}

variable "vpc_id" {
  description = "VPC ID where the cluster lives."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the DB subnet group (at least 2 AZs required)."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security group IDs allowed to reach the cluster on port 5432."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key ARN for Aurora storage encryption."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN for encrypting Secrets Manager secrets."
  type        = string
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version."
  type        = string
  default     = "16.4"
}

variable "database_name" {
  description = "Name of the initial database created in the cluster."
  type        = string
  default     = "chronos"
}

variable "master_username" {
  description = "Master DB username."
  type        = string
  default     = "chronos_admin"
}

variable "backup_retention_days" {
  description = "Number of days to retain automated backups. Max 30 (POPIA erasure window, spec 4.4)."
  type        = number
  default     = 7
  validation {
    condition     = var.backup_retention_days <= 30
    error_message = "Backup retention must not exceed 30 days (spec 4.4 / POPIA erasure window)."
  }
}

variable "serverless_min_acu" {
  description = "Minimum Aurora Capacity Units for serverless v2."
  type        = number
  default     = 0.5
}

variable "serverless_max_acu" {
  description = "Maximum Aurora Capacity Units for serverless v2."
  type        = number
  default     = 4
}

variable "reader_count" {
  description = "Number of read replica instances."
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
