output "key_arns" {
  description = "Map of domain name → KMS key ARN."
  value       = { for k, v in aws_kms_key.keys : k => v.arn }
}

output "key_ids" {
  description = "Map of domain name → KMS key ID."
  value       = { for k, v in aws_kms_key.keys : k => v.key_id }
}

output "alias_arns" {
  description = "Map of domain name → KMS alias ARN."
  value       = { for k, v in aws_kms_alias.keys : k => v.arn }
}

# Convenience outputs for the most referenced keys
output "vault_data_key_arn" {
  description = "ARN of the vault DEK wrapping CMK (highest sensitivity)."
  value       = aws_kms_key.keys["vault_data"].arn
}

output "vault_data_key_id" {
  description = "Key ID of the vault DEK wrapping CMK."
  value       = aws_kms_key.keys["vault_data"].key_id
}

output "core_db_key_arn" {
  description = "ARN of the core Aurora DB encryption key."
  value       = aws_kms_key.keys["core_db"].arn
}

output "logs_key_arn" {
  description = "ARN of the CloudWatch Logs encryption key."
  value       = aws_kms_key.keys["logs"].arn
}
