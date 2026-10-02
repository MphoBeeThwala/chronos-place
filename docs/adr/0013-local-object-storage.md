# ADR-0013: SeaweedFS replaces MinIO for local S3-compatible storage

## Decision
The local stack uses SeaweedFS (`chrislusf/seaweedfs`, Apache-2.0) as the S3-compatible media store instead of MinIO. Production is unchanged: Amazon S3 behind CloudFront.

## Why
- MinIO no longer publishes its community image to Docker Hub, and upstream has reduced community-edition features and distribution. A dev stack that depends on an image we cannot pull reliably, or on an unmaintained mirror, is a risk.
- Application code talks to the S3 API through the AWS SDK, so the backing store is an implementation detail. Signed-URL uploads, bucket operations and credentials work the same.
- SeaweedFS is actively maintained, runs as one container, and enforces credentials from environment variables.

## Consequences
- Pin the image tag when M0.8 first depends on it (currently `latest`).
- LocalStack still provides S3 for tests that need AWS-specific behaviour (KMS-encrypted objects, Secrets Manager).
- If SeaweedFS shows API gaps for the photo pipeline (M1.6), swap the image behind the same endpoint.
