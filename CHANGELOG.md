# Changelog

## [1.0.0] - 2026-05-23

Initial release. Lambda-only architecture for serverless document parsing.

### Added
- Lambda function running LiteParse slim image (1.8 GB) with AWS Lambda Web Adapter
- Lambda Function URL for direct HTTP access (no ALB, no VPC)
- S3 batch pipeline: upload to raw/, trigger Lambda parses, outputs to processed/
- Local web UI with drag-and-drop, direct parse via Function URL, text/JSON preview
- CDK stack deploying: S3 bucket, Lambda (Docker), Function URL, trigger Lambda, CloudWatch alarms
- Portless integration for stable https://liteparse.localhost URL
- Architecture decisions documentation
- 1024 MB ephemeral storage and HOME=/tmp for LibreOffice compatibility in Lambda

### Performance
- Cold start: 15-30 seconds (1.8 GB container image)
- Warm parse: 1-6 seconds depending on file size
- Supported formats: PDF, DOCX, XLSX, PPTX, PNG, JPG

### Cost
- Pay per parse only (~$0.008 per document at 4 GB / 2 min)
- Zero cost when idle (no always-on compute)
- Estimated $2-3/month at ~100 documents/month
