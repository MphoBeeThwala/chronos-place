output "endpoint_service_name" {
  description = "VPC Endpoint Service name (used by the core account to create the VPC endpoint)."
  value       = aws_vpc_endpoint_service.disclosure.service_name
}

output "endpoint_service_id" {
  description = "VPC Endpoint Service ID."
  value       = aws_vpc_endpoint_service.disclosure.id
}

output "nlb_arn" {
  description = "NLB ARN fronting the disclosure-service."
  value       = aws_lb.disclosure.arn
}

output "nlb_dns_name" {
  description = "NLB DNS name."
  value       = aws_lb.disclosure.dns_name
}

output "target_group_arn" {
  description = "Target group ARN. EKS pods register themselves here."
  value       = aws_lb_target_group.disclosure_grpc.arn
}
