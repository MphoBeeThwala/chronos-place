output "cluster_id" {
  description = "Aurora cluster identifier."
  value       = aws_rds_cluster.this.id
}

output "cluster_endpoint" {
  description = "Writer endpoint for the Aurora cluster."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint for the Aurora cluster."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "cluster_arn" {
  description = "ARN of the Aurora cluster."
  value       = aws_rds_cluster.this.arn
}

output "security_group_id" {
  description = "Security group ID of the Aurora cluster."
  value       = aws_security_group.aurora.id
}

output "master_credentials_secret_arn" {
  description = "Secrets Manager secret ARN for the master credentials."
  value       = aws_secretsmanager_secret.master_credentials.arn
}

output "database_name" {
  description = "Name of the initial database."
  value       = aws_rds_cluster.this.database_name
}
