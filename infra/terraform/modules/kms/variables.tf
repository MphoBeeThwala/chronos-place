variable "prefix" {
  description = "Short prefix for resource names."
  type        = string
}

variable "env" {
  description = "Environment name (dev | staging | prod)."
  type        = string
}

variable "key_admin_arns" {
  description = "IAM principal ARNs allowed to administer the keys (key rotation, deletion, etc.)."
  type        = list(string)
}

variable "disclosure_service_role_arns" {
  description = "IAM role ARNs for the disclosure-service. Granted GenerateDataKey/Decrypt on vault_data with encryption context check."
  type        = list(string)
  default     = []
}

variable "vault_key_store_id" {
  description = "ID of a CloudHSM custom key store to back the vault_data CMK. Leave empty to use the default KMS key store (dev/staging only)."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
