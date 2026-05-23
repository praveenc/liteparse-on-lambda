# Infrastructure

CDK stack for the LiteParse-on-Lambda service. Deploys:

- S3 bucket (`liteparse-docs-{account-id}`) with lifecycle rules
- Lambda function (Docker container: LiteParse slim + Lambda Web Adapter)
- Lambda Function URL for direct HTTP access
- Trigger Lambda for the S3 batch pipeline
- CloudWatch alarms (errors, duration, throttles)

## Prerequisites

- Node.js 24+
- Docker (for building the container image)
- AWS CLI configured with appropriate credentials
- CDK bootstrapped in your account/region

## Commands

```bash
npm install          # install dependencies
npx cdk synth        # synthesize CloudFormation template
npx cdk deploy       # deploy to AWS
npx cdk diff         # compare deployed stack with local changes
npx cdk destroy      # tear down the stack (bucket retained)
```

## Docker Image

The `docker/Dockerfile` extends the pre-built LiteParse slim server (1.8 GB) with the AWS Lambda Web Adapter:

```dockerfile
FROM ghcr.io/run-llama/liteparse-server:main
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=5000
```

CDK builds and pushes this image to ECR automatically during `cdk deploy`.

## Lambda Configuration

| Setting | Value |
|---------|-------|
| Memory | 4096 MB |
| Timeout | 5 minutes |
| Ephemeral storage | 1024 MB |
| Architecture | X86_64 |
| HOME | /tmp (LibreOffice needs writable home) |
