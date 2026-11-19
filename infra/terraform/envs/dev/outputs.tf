output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "eks_oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "aurora_core_endpoint" {
  value = module.aurora_core.cluster_endpoint
}

output "aurora_core_credentials_secret_arn" {
  value = module.aurora_core.master_credentials_secret_arn
}

output "aurora_vault_endpoint" {
  value     = module.aurora_vault.cluster_endpoint
  sensitive = true # vault endpoint is restricted
}

output "aurora_vault_credentials_secret_arn" {
  value     = module.aurora_vault.master_credentials_secret_arn
  sensitive = true
}

output "redis_endpoint" {
  value = module.elasticache.endpoint
}

output "kafka_bootstrap_brokers" {
  value = module.msk.bootstrap_brokers_iam
}

output "media_cdn_domain" {
  value = module.s3.media_cloudfront_domain
}

output "assets_cdn_domain" {
  value = module.s3.assets_cloudfront_domain
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "kms_key_arns" {
  value     = module.kms.key_arns
  sensitive = true
}

output "disclosure_endpoint_service_name" {
  value = module.privatelink.endpoint_service_name
}

output "eso_role_arn" {
  value = module.secrets.eso_role_arn
}
