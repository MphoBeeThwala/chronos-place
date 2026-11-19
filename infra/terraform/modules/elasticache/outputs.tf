output "endpoint" {
  description = "Redis serverless cache endpoint."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].address
}

output "port" {
  description = "Redis port."
  value       = aws_elasticache_serverless_cache.this.endpoint[0].port
}

output "security_group_id" {
  description = "Security group ID for the Redis cluster."
  value       = aws_security_group.redis.id
}

output "auth_token_secret_arn" {
  description = "Secrets Manager ARN containing the Redis auth token."
  value       = aws_secretsmanager_secret.auth_token.arn
}
