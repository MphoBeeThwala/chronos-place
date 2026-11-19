output "cluster_arn" {
  description = "MSK Serverless cluster ARN."
  value       = aws_msk_serverless_cluster.this.arn
}

output "bootstrap_brokers_iam" {
  description = "Bootstrap broker string for IAM authentication."
  value       = aws_msk_serverless_cluster.this.bootstrap_brokers_sasl_iam
}

output "security_group_id" {
  description = "Security group ID for the MSK cluster."
  value       = aws_security_group.msk.id
}

output "producer_policy_arn" {
  description = "IAM policy ARN to attach to producer service roles."
  value       = aws_iam_policy.kafka_producer.arn
}

output "consumer_policy_arn" {
  description = "IAM policy ARN to attach to consumer service roles."
  value       = aws_iam_policy.kafka_consumer.arn
}
