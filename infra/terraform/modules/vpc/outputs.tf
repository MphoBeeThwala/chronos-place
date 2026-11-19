output "vpc_id" {
  description = "The VPC ID."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "The VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  description = "IDs of the three private subnets (one per AZ)."
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "IDs of the three public subnets (one per AZ)."
  value       = aws_subnet.public[*].id
}

output "nat_gateway_ids" {
  description = "IDs of the NAT gateway(s)."
  value       = aws_nat_gateway.this[*].id
}

output "private_route_table_ids" {
  description = "IDs of the private route tables."
  value       = aws_route_table.private[*].id
}
