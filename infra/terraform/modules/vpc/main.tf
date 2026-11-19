################################################################################
# Module: vpc
#
# VPC across 3 availability zones in af-south-1.
# Layout:
#   - 3 × private subnets  (workloads: EKS nodes, RDS, Redis, MSK)
#   - 3 × public subnets   (NAT gateway EIPs, ALB if needed)
#   - 1 × NAT gateway per AZ (high-availability; can collapse to 1 for dev)
#   - No public endpoints for databases
#   - VPC Flow Logs to CloudWatch Logs (encrypted with KMS)
#
# Tags on private subnets and public subnets follow the EKS convention so
# the Kubernetes cloud-provider and AWS Load Balancer Controller can discover them.
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 3)

  private_subnet_cidrs = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnet_cidrs  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 3)]
  # Spare subnet space (indices 6–15) reserved for future intra/database tiers.

  common_tags = merge(var.tags, {
    "chronos:module" = "vpc"
    "chronos:env"    = var.env
  })
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------
resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-vpc" })
}

# ---------------------------------------------------------------------------
# Internet Gateway
# ---------------------------------------------------------------------------
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-igw" })
}

# ---------------------------------------------------------------------------
# Public subnets
# ---------------------------------------------------------------------------
resource "aws_subnet" "public" {
  count                   = 3
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnet_cidrs[count.index]
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false # EIPs assigned explicitly to NAT GWs

  tags = merge(local.common_tags, {
    Name                     = "${var.prefix}-${var.env}-public-${local.azs[count.index]}"
    "kubernetes.io/role/elb" = "1" # ALB controller discovery
  })
}

# ---------------------------------------------------------------------------
# Private subnets
# ---------------------------------------------------------------------------
resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = local.azs[count.index]

  tags = merge(local.common_tags, {
    Name                              = "${var.prefix}-${var.env}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb" = "1" # internal ALB / NLB discovery
    "karpenter.sh/discovery"          = "${var.prefix}-${var.env}" # Karpenter node discovery
  })
}

# ---------------------------------------------------------------------------
# Elastic IPs and NAT Gateways (one per AZ unless single_nat_gateway=true)
# ---------------------------------------------------------------------------
resource "aws_eip" "nat" {
  count  = var.single_nat_gateway ? 1 : 3
  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${var.prefix}-${var.env}-nat-eip-${count.index}"
  })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count         = var.single_nat_gateway ? 1 : 3
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(local.common_tags, {
    Name = "${var.prefix}-${var.env}-nat-${count.index}"
  })

  depends_on = [aws_internet_gateway.this]
}

# ---------------------------------------------------------------------------
# Route tables
# ---------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-rt-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = 3
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = var.single_nat_gateway ? 1 : 3
  vpc_id = aws_vpc.this.id
  tags = merge(local.common_tags, {
    Name = "${var.prefix}-${var.env}-rt-private-${count.index}"
  })
}

resource "aws_route" "private_nat" {
  count                  = var.single_nat_gateway ? 1 : 3
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = 3
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[var.single_nat_gateway ? 0 : count.index].id
}

# ---------------------------------------------------------------------------
# VPC Flow Logs → CloudWatch Logs
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/aws/vpc/${var.prefix}-${var.env}/flow-logs"
  retention_in_days = 90
  kms_key_id        = var.flow_log_kms_key_arn

  tags = local.common_tags
}

resource "aws_iam_role" "flow_logs" {
  name = "${var.prefix}-${var.env}-vpc-flow-logs"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "allow-cloudwatch-put"
  role = aws_iam_role.flow_logs.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.flow_logs.arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  iam_role_arn    = aws_iam_role.flow_logs.arn
  log_destination = aws_cloudwatch_log_group.flow_logs.arn

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-flow-log" })
}

# ---------------------------------------------------------------------------
# Security Groups: baseline deny-all (services add their own rules)
# ---------------------------------------------------------------------------
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.this.id
  # Remove all default rules – nothing should use the default SG.
  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-default-deny" })
}
