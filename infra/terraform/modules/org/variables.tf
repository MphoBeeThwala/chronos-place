variable "prefix" {
  description = "Short prefix applied to all resource names (e.g. 'chronos')."
  type        = string
}

variable "target_ou_ids" {
  description = "List of Organizational Unit IDs to attach the data-residency and audit-control SCPs to."
  type        = list(string)
}

variable "restricted_ou_ids" {
  description = "List of Organizational Unit IDs for restricted accounts (disclosure-service / Health Vault). The stricter isolation SCP is attached here only."
  type        = list(string)
  default     = []
}

variable "restricted_vpc_id" {
  description = "VPC ID of the restricted account's VPC. Used in the isolation SCP condition."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources."
  type        = map(string)
  default     = {}
}
