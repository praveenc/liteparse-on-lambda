# LiteParse on AWS - Architecture Decisions

## Compute: Lambda with Container Image

- **Decision**: Lambda running the LiteParse slim image extended with AWS Lambda Web Adapter
- **History**: Started with ECS Fargate (v0.1-v0.4). Moved to Lambda-only to eliminate $60/month in always-on compute costs (Fargate + ALB + NAT). At low usage (~100 docs/month) Lambda costs under $3/month.
- **Rationale**: The pre-built `ghcr.io/run-llama/liteparse-server:main` slim image (1.8 GB) runs an Express server on port 5000. The AWS Lambda Web Adapter wraps this unmodified HTTP server as a Lambda function. No custom application code needed.
- **Configuration**:
  - Memory: 4096 MB
  - Timeout: 5 minutes (300 seconds)
  - Architecture: X86_64 (upstream image does not publish ARM64)
  - Ephemeral storage: 1024 MB (LibreOffice needs temp space for conversions)
  - HOME=/tmp (Lambda filesystem is read-only except /tmp; LibreOffice needs a writable home)
  - Concurrency: unreserved (auto-scales)
- **Cold start**: 15-30 seconds for the 1.8 GB container. Acceptable for ad-hoc usage. Provisioned Concurrency available if needed (~$15/month for 1 warm instance).

## Container Image

- **Base**: `ghcr.io/run-llama/liteparse-server:main` (pre-built slim server, 1.8 GB)
- **Extension**: AWS Lambda Web Adapter layer added via Dockerfile
- **Stored in**: ECR private repository (`liteparse:latest`)
- **Includes**: Bun, LibreOffice, ImageMagick, Ghostscript, Tesseract.js, LiteParse, Lambda Web Adapter
- **Dockerfile**: 3 lines (FROM, COPY adapter, ENV port)

```dockerfile
FROM ghcr.io/run-llama/liteparse-server:main
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=5000
```

## API Interface

- **Endpoint**: Lambda Function URL (public, IAM auth optional)
- **Protocol**: HTTP multipart form POST (file upload directly to `/parse`)
- **No ALB, no VPC, no NAT required**

### Native LiteParse API (used directly)

**POST /parse** - Parse a document

Form fields:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to parse |
| `config` | string | No | JSON-serialized LiteParseConfig (e.g., `{"ocrEnabled": true}`) |

Query parameters:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | boolean | `false` | If `true`, returns `text/plain`; otherwise returns JSON with `pages` array |

Responses:
- `200 text/plain` - extracted text (when `?text=true`)
- `200 application/json` - `{ "pages": [...] }` (when `?text=false`)
- `400` - missing file
- `429` - rate limit exceeded

**POST /screenshots** - Screenshot pages

Form fields:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to screenshot |
| `config` | string | No | JSON-serialized LiteParseConfig |

Query parameters:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pages` | string | all | Comma-separated 1-based page numbers |

Response: NDJSON stream with base64 PNGs per page.

## Architecture Overview

```
+---------------------------------------------------------------+
|                                                               |
|  Local UI / curl / any HTTP client                            |
|       |                                                       |
|       | POST /parse (multipart file upload)                   |
|       v                                                       |
|  +----------------------------+                               |
|  | Lambda Function URL        |                               |
|  | (LiteParse container)      |                               |
|  | 4 GB, 5 min timeout, x86   |                               |
|  +----------------------------+                               |
|                                                               |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
| Batch / async pipeline (optional)                             |
|                                                               |
|  +----------+     +-------------------+     +----------+      |
|  | S3 raw/  |---->| S3 Notification   |---->| Trigger  |      |
|  |          |     |                   |     | Lambda   |      |
|  +----------+     +-------------------+     +----+-----+      |
|                                                  |             |
|                         POST file to Function URL|             |
|                                                  v             |
|                                    +----------------------------+
|                                    | Lambda Function URL        |
|                                    | (LiteParse container)      |
|                                    +-------------+--------------+
|                                                  |             |
|                                                  v             |
|                                           +----------+         |
|                                           |S3 processed/|      |
|                                           +----------+         |
+---------------------------------------------------------------+
```

## S3 Bucket (for batch pipeline and archival)

```
s3://liteparse-docs-{account-id}/
  raw/YYYYMMDD/report.docx            <-- input files (batch pipeline)
  processed/YYYYMMDD/report.docx.txt  <-- text output
  processed/YYYYMMDD/report.docx.json <-- json output
```

- S3 is optional for interactive use (UI posts directly to Function URL)
- S3 pipeline remains for batch workflows and integrations
- Date partitioning avoids staleness when same filename is uploaded on different days

## S3 Lifecycle and Storage

- **Storage class**: S3 Standard (low volume, IA transition not worth the retrieval fees)
- **Versioning**: Enabled for accidental overwrite/delete recovery
- **Retention**: 90 days for both `raw/` and `processed/` prefixes

## Event-Driven Parsing Pipeline (batch)

- **Trigger**: S3 `OBJECT_CREATED` notification on `raw/` prefix
- **Lambda**: Lightweight Node.js handler (ARM64, 256 MB, 5-min timeout)
- **Flow**: Download file from S3, POST to LiteParse Function URL, write `.txt` and `.json` to `processed/`
- **No VPC needed**: Function URL is publicly addressable (secured via IAM SigV4)

## Security

- Lambda Function URL with `NONE` auth type (URL is an opaque random string)
- The Function URL is not publicly advertised; obscurity provides baseline protection
- S3 bucket access controlled via IAM (Lambda roles get read/write grants)
- For stricter control, add a Lambda resource policy restricting source IP or switch to `AWS_IAM` auth
- No VPC, no public IPs on containers, no security groups to manage

## Infrastructure as Code

- **Tool**: AWS CDK (TypeScript)
- **Stack**: Single stack covering ECR image (via DockerImageAsset), Lambda, Function URL, S3 bucket, trigger Lambda, IAM roles
- **Platform**: X86_64 (pre-built image constraint)

## Networking

- No VPC required
- No NAT Gateway
- No VPC endpoints
- Lambda runs in AWS-managed networking (public internet access built-in)

## Observability

- CloudWatch Logs (2-week retention) for Lambda invocations
- Lambda built-in metrics: invocations, duration, errors, throttles, cold starts
- CloudWatch Alarms:
  - Error rate
  - Duration approaching timeout (>4 min)
  - Throttles

## Scaling

- Lambda auto-scales to handle concurrent requests (no configuration needed)
- Each invocation gets its own container (no contention between parses)
- Burst concurrency: 500-3000 depending on region
- No circuit breaker needed (Lambda handles failures per-invocation)

## Bucket Naming

- **Name**: `liteparse-docs-{account-id}` (explicit, stable across deployments)

## Cost Estimate

Per-parse: 120 seconds x 4 GB x $0.0000166667/GB-sec = ~$0.008 per document

| Monthly volume | Lambda cost | Previous (Fargate+ALB+NAT) |
|----------------|-------------|----------------------------|
| 50 docs        | $0.40       | ~$60                       |
| 200 docs       | $1.60       | ~$60                       |
| 1000 docs      | $8.00       | ~$60                       |
| 5000 docs      | $40.00      | ~$60                       |

Break-even at ~7,500 docs/month.

## Migration from v0.4 (ECS Fargate)

Removed:
- VPC (subnets, route tables, security groups, NAT Gateway)
- ECS cluster, Fargate service, task definition
- ALB, target group, listener
- Auto-scaling policies
- ECS-specific CloudWatch alarms

Added:
- Dockerfile extending slim image with Lambda Web Adapter
- Lambda function (container image from ECR)
- Lambda Function URL
- Trigger Lambda for S3 pipeline

Changed:
- UI posts directly to Function URL instead of uploading to S3 and polling
- S3 pipeline trigger Lambda posts to Function URL instead of internal ALB
