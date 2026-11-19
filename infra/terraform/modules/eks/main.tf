################################################################################
# Module: eks
#
# EKS cluster with:
#   - Managed node groups (baseline on-demand)
#   - Karpenter for autoscaling
#   - EKS add-ons: CoreDNS, kube-proxy, VPC CNI, EBS CSI driver, Pod Identity Agent
#   - IRSA / EKS Pod Identity for service accounts
#   - Control plane logging to CloudWatch
#   - Secrets encryption with KMS
#   - Private API endpoint preferred; public optional (for dev bastion access)
#
# After apply, install into the cluster (via Helm/Argo CD):
#   - Istio ambient mesh (ADR-0004) – not managed by Terraform; in k8s/
#   - External Secrets Operator
#   - AWS Load Balancer Controller
#   - Karpenter (NodePool CRDs)
################################################################################

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition

  cluster_name = "${var.prefix}-${var.env}"

  common_tags = merge(var.tags, {
    "chronos:module"              = "eks"
    "chronos:env"                 = var.env
    "kubernetes.io/cluster/${local.cluster_name}" = "owned"
  })
}

# ---------------------------------------------------------------------------
# EKS Cluster IAM Role
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "eks_cluster_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${local.cluster_name}-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.eks_cluster_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSClusterPolicy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role_policy_attachment" "cluster_AmazonEKSVPCResourceController" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSVPCResourceController"
}

# ---------------------------------------------------------------------------
# Control-plane security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "cluster" {
  name        = "${local.cluster_name}-cluster-sg"
  description = "EKS cluster control plane security group"
  vpc_id      = var.vpc_id

  egress {
    description = "Allow all outbound (control plane → nodes)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.cluster_name}-cluster-sg" })
}

# ---------------------------------------------------------------------------
# EKS Cluster
# ---------------------------------------------------------------------------
resource "aws_eks_cluster" "this" {
  name     = local.cluster_name
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = concat(var.private_subnet_ids, var.public_subnet_ids)
    security_group_ids      = [aws_security_group.cluster.id]
    endpoint_private_access = true
    endpoint_public_access  = var.public_api_access
    public_access_cidrs     = var.public_api_access ? var.public_access_cidrs : []
  }

  encryption_config {
    resources = ["secrets"]
    provider {
      key_arn = var.kms_key_arn
    }
  }

  enabled_cluster_log_types = [
    "api", "audit", "authenticator", "controllerManager", "scheduler"
  ]

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  tags = merge(local.common_tags, { Name = local.cluster_name })

  depends_on = [
    aws_iam_role_policy_attachment.cluster_AmazonEKSClusterPolicy,
    aws_iam_role_policy_attachment.cluster_AmazonEKSVPCResourceController,
  ]
}

# ---------------------------------------------------------------------------
# OIDC Provider (for IRSA / Pod Identity)
# ---------------------------------------------------------------------------
data "tls_certificate" "cluster" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  tags            = local.common_tags
}

# ---------------------------------------------------------------------------
# Node IAM Role
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "node_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${local.cluster_name}-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKSWorkerNodePolicy" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_AmazonEKS_CNI_Policy" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_AmazonEC2ContainerRegistryReadOnly" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "node_AmazonSSMManagedInstanceCore" {
  # SSM for node access without bastion
  role       = aws_iam_role.node.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ---------------------------------------------------------------------------
# Managed Node Group (baseline; Karpenter handles dynamic scaling)
# ---------------------------------------------------------------------------
resource "aws_eks_node_group" "baseline" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${local.cluster_name}-baseline"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.node_instance_types
  release_version = var.ami_release_version == "" ? null : var.ami_release_version
  capacity_type   = "ON_DEMAND"

  scaling_config {
    desired_size = var.node_desired
    min_size     = var.node_min
    max_size     = var.node_max
  }

  update_config {
    max_unavailable_percentage = 25
  }

  labels = {
    "chronos/node-group" = "baseline"
    "chronos/env"        = var.env
  }

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.node_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.node_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.node_AmazonEC2ContainerRegistryReadOnly,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size] # Karpenter manages this
  }
}

resource "aws_launch_template" "node" {
  name_prefix = "${local.cluster_name}-node-"
  description = "Launch template for ${local.cluster_name} EKS nodes"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 50
      volume_type           = "gp3"
      encrypted             = true
      kms_key_id            = var.kms_key_arn
      delete_on_termination = true
    }
  }

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.common_tags, {
      Name = "${local.cluster_name}-node"
    })
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# EKS Add-ons
# ---------------------------------------------------------------------------
locals {
  addons = {
    coredns = {
      version = var.addon_versions.coredns
    }
    kube-proxy = {
      version = var.addon_versions.kube_proxy
    }
    vpc-cni = {
      version = var.addon_versions.vpc_cni
    }
    aws-ebs-csi-driver = {
      version            = var.addon_versions.ebs_csi_driver
      service_account_role_arn = aws_iam_role.ebs_csi_driver.arn
    }
    eks-pod-identity-agent = {
      version = var.addon_versions.pod_identity_agent
    }
  }
}

resource "aws_eks_addon" "addons" {
  for_each = local.addons

  cluster_name             = aws_eks_cluster.this.name
  addon_name               = each.key
  addon_version            = each.value.version
  service_account_role_arn = try(each.value.service_account_role_arn, null)
  resolve_conflicts_on_update = "OVERWRITE"

  tags = local.common_tags

  depends_on = [aws_eks_node_group.baseline]
}

# ---------------------------------------------------------------------------
# EBS CSI Driver IRSA Role
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "ebs_csi_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.cluster.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${aws_iam_openid_connect_provider.cluster.url}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }
    condition {
      test     = "StringEquals"
      variable = "${aws_iam_openid_connect_provider.cluster.url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi_driver" {
  name               = "${local.cluster_name}-ebs-csi-driver"
  assume_role_policy = data.aws_iam_policy_document.ebs_csi_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ebs_csi_driver" {
  role       = aws_iam_role.ebs_csi_driver.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# ---------------------------------------------------------------------------
# Karpenter IAM Role
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "karpenter_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.cluster.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${aws_iam_openid_connect_provider.cluster.url}:sub"
      values   = ["system:serviceaccount:karpenter:karpenter"]
    }
    condition {
      test     = "StringEquals"
      variable = "${aws_iam_openid_connect_provider.cluster.url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "karpenter" {
  name               = "${local.cluster_name}-karpenter"
  assume_role_policy = data.aws_iam_policy_document.karpenter_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "karpenter_permissions" {
  statement {
    sid    = "Karpenter"
    effect = "Allow"
    actions = [
      "ec2:CreateFleet",
      "ec2:CreateLaunchTemplate",
      "ec2:CreateTags",
      "ec2:DeleteLaunchTemplate",
      "ec2:DescribeAvailabilityZones",
      "ec2:DescribeImages",
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceTypeOfferings",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSpotPriceHistory",
      "ec2:DescribeSubnets",
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "iam:PassRole",
      "pricing:GetProducts",
      "ssm:GetParameter",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "KarpenterInterruptionQueue"
    effect  = "Allow"
    actions = [
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
    ]
    resources = [aws_sqs_queue.karpenter_interruption.arn]
  }
}

resource "aws_iam_role_policy" "karpenter" {
  name   = "karpenter-permissions"
  role   = aws_iam_role.karpenter.id
  policy = data.aws_iam_policy_document.karpenter_permissions.json
}

# Karpenter interruption queue (handles Spot interruptions, instance rebalances)
resource "aws_sqs_queue" "karpenter_interruption" {
  name                      = "${local.cluster_name}-karpenter-interruptions"
  message_retention_seconds = 300

  tags = local.common_tags
}

resource "aws_sqs_queue_policy" "karpenter_interruption" {
  queue_url = aws_sqs_queue.karpenter_interruption.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowEC2Events"
        Effect = "Allow"
        Principal = {
          Service = ["events.amazonaws.com", "sqs.amazonaws.com"]
        }
        Action   = "sqs:SendMessage"
        Resource = aws_sqs_queue.karpenter_interruption.arn
      }
    ]
  })
}

# CloudWatch log group for control plane logs
resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = 90
  kms_key_id        = var.kms_key_arn

  tags = local.common_tags
}
