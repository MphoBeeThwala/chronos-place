output "eso_role_arn" {
  description = "IAM role ARN for External Secrets Operator."
  value       = aws_iam_role.eso.arn
}

output "service_secrets_policy_arns" {
  description = "Map of service name → IAM policy ARN for secrets access."
  value       = { for k, v in aws_iam_policy.service_secrets : k => v.arn }
}
