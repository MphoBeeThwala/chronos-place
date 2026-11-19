output "cluster_name" {
  description = "EKS cluster name."
  value       = aws_eks_cluster.this.name
}

output "cluster_arn" {
  description = "EKS cluster ARN."
  value       = aws_eks_cluster.this.arn
}

output "cluster_endpoint" {
  description = "EKS API server endpoint."
  value       = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority" {
  description = "Base64-encoded certificate authority data."
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}

output "cluster_security_group_id" {
  description = "Security group ID attached to the cluster control plane."
  value       = aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
}

output "node_role_arn" {
  description = "IAM role ARN for EKS node groups."
  value       = aws_iam_role.node.arn
}

output "oidc_provider_arn" {
  description = "OIDC provider ARN for IRSA."
  value       = aws_iam_openid_connect_provider.cluster.arn
}

output "oidc_provider_url" {
  description = "OIDC provider URL (without https://) for IRSA trust policies."
  value       = replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")
}

output "karpenter_role_arn" {
  description = "IAM role ARN for Karpenter."
  value       = aws_iam_role.karpenter.arn
}

output "karpenter_interruption_queue_arn" {
  description = "SQS queue ARN for Karpenter Spot interruption handling."
  value       = aws_sqs_queue.karpenter_interruption.arn
}
