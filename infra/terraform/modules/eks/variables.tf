variable "prefix" { type = string }
variable "env" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "public_subnet_ids" { type = list(string) }

variable "kubernetes_version" {
  description = "Kubernetes version for the EKS cluster."
  type        = string
  default     = "1.31"
}

variable "kms_key_arn" {
  description = "KMS key ARN used to encrypt Kubernetes Secrets and EBS volumes."
  type        = string
}

variable "public_api_access" {
  description = "Enable public API server endpoint. True for dev (bastion-less access); false for staging/prod."
  type        = bool
  default     = false
}

variable "public_access_cidrs" {
  description = "CIDR blocks allowed to reach the public API endpoint. Only used when public_api_access = true."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "node_instance_types" {
  description = "EC2 instance types for the baseline managed node group."
  type        = list(string)
  default     = ["t3.medium"]
}

variable "ami_release_version" {
  description = "EKS-optimised AMI release version. Leave empty to use the latest."
  type        = string
  default     = ""
}

variable "node_desired" {
  type    = number
  default = 2
}

variable "node_min" {
  type    = number
  default = 1
}

variable "node_max" {
  type    = number
  default = 6
}

variable "addon_versions" {
  description = "EKS add-on versions. Run `aws eks describe-addon-versions` to find the latest."
  type = object({
    coredns            = string
    kube_proxy         = string
    vpc_cni            = string
    ebs_csi_driver     = string
    pod_identity_agent = string
  })
  default = {
    coredns            = "v1.11.3-eksbuild.1"
    kube_proxy         = "v1.31.3-eksbuild.2"
    vpc_cni            = "v1.19.2-eksbuild.1"
    ebs_csi_driver     = "v1.37.0-eksbuild.1"
    pod_identity_agent = "v1.3.4-eksbuild.1"
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
