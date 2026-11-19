################################################################################
# Module: s3
#
# S3 buckets for Chronos Place:
#
#   media         – member photos, voice notes. Served via CloudFront signed URLs.
#                   EXIF/GPS stripped before storage (M1.6).
#   assets        – static web assets (admin, partner portal) served via CloudFront.
#   logs          – S3 access logs, ALB logs, CloudFront logs.
#   erasure_ledger– Out-of-database erasure ledger (ADR-0014). Object Lock COMPLIANCE
#                   mode; disclosure-service may PUT, never DELETE.
#
# CloudFront distribution is created for media and assets buckets.
# All buckets: versioning, encryption (KMS), access logging, block-all-public-access.
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

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  common_tags = merge(var.tags, {
    "chronos:module" = "s3"
    "chronos:env"    = var.env
  })
}

# ---------------------------------------------------------------------------
# Helper: reusable bucket configuration
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "media" {
  bucket        = "${var.prefix}-${var.env}-media-${local.account_id}"
  force_destroy = var.env == "dev"
  tags          = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-media", "chronos:data-class" = "confidential" })
}

resource "aws_s3_bucket" "assets" {
  bucket        = "${var.prefix}-${var.env}-assets-${local.account_id}"
  force_destroy = var.env == "dev"
  tags          = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-assets", "chronos:data-class" = "public" })
}

resource "aws_s3_bucket" "logs" {
  bucket        = "${var.prefix}-${var.env}-logs-${local.account_id}"
  force_destroy = var.env == "dev"
  tags          = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-logs", "chronos:data-class" = "internal" })
}

resource "aws_s3_bucket" "erasure_ledger" {
  bucket        = "${var.prefix}-${var.env}-erasure-ledger-${local.account_id}"
  force_destroy = false # NEVER force-destroy the ledger
  object_lock_enabled = true
  tags = merge(local.common_tags, {
    Name                   = "${var.prefix}-${var.env}-erasure-ledger"
    "chronos:data-class"   = "restricted"
    "chronos:object-lock"  = "compliance"
  })
}

# ---------------------------------------------------------------------------
# Block all public access
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "erasure_ledger" {
  bucket                  = aws_s3_bucket.erasure_ledger.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# Versioning
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "assets" {
  bucket = aws_s3_bucket.assets.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "erasure_ledger" {
  bucket = aws_s3_bucket.erasure_ledger.id
  versioning_configuration { status = "Enabled" }
}

# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.media_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.media_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.logs_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "erasure_ledger" {
  bucket = aws_s3_bucket.erasure_ledger.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.logs_kms_key_arn
    }
    bucket_key_enabled = true
  }
}

# ---------------------------------------------------------------------------
# Object Lock configuration for erasure ledger (ADR-0014)
# COMPLIANCE mode: once written, objects cannot be deleted or overwritten
# during the retention period — not even by account root.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_object_lock_configuration" "erasure_ledger" {
  bucket = aws_s3_bucket.erasure_ledger.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 7 # Align with POPIA record-retention requirements
    }
  }
}

# ---------------------------------------------------------------------------
# Access logging (all buckets log to the logs bucket)
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_logging" "media" {
  bucket        = aws_s3_bucket.media.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access-logs/media/"
}

resource "aws_s3_bucket_logging" "assets" {
  bucket        = aws_s3_bucket.assets.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access-logs/assets/"
}

# ---------------------------------------------------------------------------
# Lifecycle rules
# ---------------------------------------------------------------------------
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "move-to-ia"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ---------------------------------------------------------------------------
# CloudFront Origin Access Control
# ---------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.prefix}-${var.env}-media-oac"
  description                       = "OAC for media bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = "${var.prefix}-${var.env}-assets-oac"
  description                       = "OAC for assets bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---------------------------------------------------------------------------
# CloudFront distribution: media
# ---------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "media" {
  enabled             = true
  price_class         = "PriceClass_200" # covers Africa, Europe, NA, APAC
  default_root_object = ""
  comment             = "Chronos ${var.env} member media"
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = "s3-media"
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-media"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Photos are served via signed URLs — short TTL so revoked photos stop serving quickly.
    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    # Signed URLs / cookies required
    trusted_key_groups = var.cloudfront_key_group_ids
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.media_acm_cert_arn == "" ? true : false
    acm_certificate_arn            = var.media_acm_cert_arn == "" ? null : var.media_acm_cert_arn
    ssl_support_method             = var.media_acm_cert_arn == "" ? null : "sni-only"
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/media/"
    include_cookies = false
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-media-cdn" })
}

# ---------------------------------------------------------------------------
# CloudFront distribution: assets (web app static files)
# ---------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "assets" {
  enabled             = true
  price_class         = "PriceClass_200"
  default_root_object = "index.html"
  comment             = "Chronos ${var.env} static assets"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  aliases             = var.assets_domain_aliases

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    min_ttl                = 0
    default_ttl            = 86400
    max_ttl                = 31536000

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }
  }

  # SPA routing: return index.html on 403/404 from S3
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.assets_acm_cert_arn == "" ? true : false
    acm_certificate_arn            = var.assets_acm_cert_arn == "" ? null : var.assets_acm_cert_arn
    ssl_support_method             = var.assets_acm_cert_arn == "" ? null : "sni-only"
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/assets/"
    include_cookies = false
  }

  tags = merge(local.common_tags, { Name = "${var.prefix}-${var.env}-assets-cdn" })
}

# ---------------------------------------------------------------------------
# Bucket policies: allow CloudFront OAC
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "media_bucket_policy" {
  statement {
    sid    = "AllowCloudFrontOAC"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

data "aws_iam_policy_document" "assets_bucket_policy" {
  statement {
    sid    = "AllowCloudFrontOAC"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.assets.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.assets.arn]
    }
  }
}

data "aws_iam_policy_document" "erasure_ledger_bucket_policy" {
  # Only the disclosure-service role may PUT. No DELETE ever.
  statement {
    sid    = "AllowDisclosureServicePut"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = var.disclosure_service_role_arns
    }
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.erasure_ledger.arn,
      "${aws_s3_bucket.erasure_ledger.arn}/*",
    ]
  }

  statement {
    sid    = "DenyDeleteEveryone"
    effect = "Deny"
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    actions = [
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.erasure_ledger.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_bucket_policy.json
  depends_on = [aws_s3_bucket_public_access_block.media]
}

resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id
  policy = data.aws_iam_policy_document.assets_bucket_policy.json
  depends_on = [aws_s3_bucket_public_access_block.assets]
}

resource "aws_s3_bucket_policy" "erasure_ledger" {
  bucket = aws_s3_bucket.erasure_ledger.id
  policy = data.aws_iam_policy_document.erasure_ledger_bucket_policy.json
  depends_on = [aws_s3_bucket_public_access_block.erasure_ledger]
}
