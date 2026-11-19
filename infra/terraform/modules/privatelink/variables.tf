variable "prefix" { type = string }
variable "env" { type = string }
variable "vpc_id" { type = string }

variable "subnet_ids" {
  description = "Private subnet IDs in the restricted VPC for the NLB."
  type        = list(string)
}

variable "core_account_id" {
  description = "AWS account ID of the core (non-restricted) account that is allowed to connect."
  type        = string
}

variable "core_account_vpc_cidrs" {
  description = "CIDR blocks of the core account's VPC, used to restrict NLB ingress."
  type        = list(string)
}

variable "tags" {
  type    = map(string)
  default = {}
}
