# LiteParse on Lambda

Self-hosted document parsing on AWS. Drop in a DOCX, PDF, or spreadsheet and get structured text back. Pay per parse, nothing running when idle.

This runs [LiteParse](https://github.com/run-llama/liteparse) (the open-source layout-aware parser from LlamaIndex) as a Lambda function behind a Function URL, with an optional S3 pipeline for batch processing. Deployed via CDK.

---

## Quick Start

**Deploy the stack:**

```bash
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy
```

**Run the local UI:**

```bash
cd ui
npm install
npm start
```

Open [https://liteparse.localhost](https://liteparse.localhost) and drag a file in. You'll see the parsed text and can download `.txt` or `.json` results.

The local UI uses [Portless](https://portless.sh/) for a stable named URL. On first run it'll prompt once to trust the local CA.

---

## How It Works

There are two ways to use the service:

### 1. Local Web UI (direct parse)

The simplest option. A drag-and-drop interface that sends your file directly to the Lambda Function URL and shows the parsed result. No S3 involved, no polling. Response comes back in seconds.

```bash
cd ui && npm start
# https://liteparse.localhost
```

### 2. S3 Pipeline (event-driven, batch)

Upload a file to the `raw/` prefix in S3 and walk away. A trigger Lambda picks it up, sends it to the parse function, and writes the output to `processed/`. Useful for batch workflows or integrations that already produce files in S3.

```bash
aws s3 cp report.docx s3://liteparse-docs-ACCOUNT_ID/raw/20260523/report.docx

# A few seconds later:
aws s3 ls s3://liteparse-docs-ACCOUNT_ID/processed/20260523/
#   report.docx.txt
#   report.docx.json
```

You can also call the Function URL directly with `curl`:

```bash
# Plain text
curl -X POST "https://FUNCTION_URL/parse?text=true" -F "file=@document.docx"

# Structured JSON (pages with bounding boxes)
curl -X POST "https://FUNCTION_URL/parse" -F "file=@document.pdf"
```

---

## Supported Formats

PDF, DOCX, XLSX, PPTX, PNG, and JPG. Images go through Tesseract.js OCR automatically.

---

## Architecture

```
+---------------------------------------------------------------+
| Direct parse (UI, curl, any HTTP client)                      |
|                                                               |
|   POST /parse -----> Lambda Function URL                      |
|                      (LiteParse container, 4 GB, 5 min)       |
|                      <----- parsed text or JSON               |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
| Batch pipeline (optional)                                     |
|                                                               |
|   S3 raw/ -----> S3 Notification -----> Trigger Lambda        |
|                                              |                |
|                                    POST to Function URL       |
|                                              |                |
|                                              v                |
|                                         S3 processed/         |
+---------------------------------------------------------------+
```

The Lambda runs the pre-built [LiteParse slim server image](https://github.com/run-llama/liteparse) (1.8 GB) extended with the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter). No custom application code inside the container.

**Key design choices:**

- No always-on compute. Lambda scales to zero when idle.
- The Function URL is public (NONE auth) with an opaque random hostname. For stricter access control, add a resource policy or switch to AWS_IAM auth.
- LibreOffice runs inside the container for DOCX/XLSX/PPTX conversion. HOME is set to /tmp since Lambda's filesystem is read-only.
- Cold starts take 15-30 seconds (1.8 GB image). Warm invocations complete in 1-6 seconds depending on file size.

---

## Configuration

| Setting | Default | What it does |
|---------|---------|--------------|
| `LITEPARSE_FUNCTION_URL` env var | (from stack outputs) | Override the Function URL used by the local UI |
| `LITEPARSE_BUCKET` env var | (from stack outputs) | Override the S3 bucket used by the local UI |
| `LITEPARSE_STACK` env var | `LiteparseStack` | CloudFormation stack name to query for outputs |

The UI resolves both values from CloudFormation stack outputs at startup. No manual configuration needed after deploy.

---

## Cost

| Monthly volume | Lambda cost | Total (with S3, ECR) |
|----------------|-------------|----------------------|
| 50 docs | ~$0.40 | ~$1-2 |
| 200 docs | ~$1.60 | ~$2-3 |
| 1000 docs | ~$8.00 | ~$9-10 |
| 5000 docs | ~$40.00 | ~$41 |

Per-parse cost: ~$0.008 (120 seconds at 4 GB memory). Nothing when idle.

---

## Stack Outputs

After `cdk deploy`, you'll see:

| Output | Value |
|--------|-------|
| `FunctionUrl` | Lambda Function URL (for direct API calls) |
| `BucketName` | S3 bucket for the batch pipeline |
| `ParseFunctionName` | Main parse Lambda function name |
| `TriggerFunctionName` | S3 trigger Lambda function name |

---

## Project Layout

```
infra/
  bin/infra.ts                CDK app entry point
  lib/infra-stack.ts          Stack: S3, Lambda (container), Function URL, trigger
  lib/lambda/parse-handler.ts S3 event handler (download -> parse -> write)
  docker/Dockerfile           Extends LiteParse slim image with Lambda Web Adapter

ui/
  server.ts                   Express server (direct parse, upload, preview, download)
  public/index.html           Drag-and-drop frontend

docs/
  architecture-decisions.md   Full design rationale
  liteparse-overview.md       What LiteParse is and how it works
```

---

## Further Reading

- [Architecture Decisions](docs/architecture-decisions.md): Why Lambda over ECS, container setup, security model.
- [LiteParse Overview](docs/liteparse-overview.md): How LiteParse's three-stage pipeline works.
- [LiteParse Server API](https://developers.llamaindex.ai/liteparse/guides/server-usage/#api-specification): Official endpoint documentation.
