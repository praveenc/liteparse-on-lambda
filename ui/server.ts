import express from 'express';
import multer from 'multer';
import https from 'https';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STACK_NAME = process.env.LITEPARSE_STACK || 'LiteparseStack';
const REGION = process.env.AWS_REGION || 'us-west-2';
const PORT = parseInt(process.env.PORT || '3000');

const signer = new SignatureV4({
  service: 'lambda',
  region: REGION,
  credentials: defaultProvider(),
  sha256: Sha256,
});

interface StackConfig {
  bucket: string;
  functionUrl: string;
}

async function resolveStackConfig(): Promise<StackConfig> {
  const bucket = process.env.LITEPARSE_BUCKET;
  const functionUrl = process.env.LITEPARSE_FUNCTION_URL;

  if (bucket && functionUrl) {
    return { bucket, functionUrl };
  }

  const cfn = new CloudFormationClient({});
  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: STACK_NAME }));
    const outputs = resp.Stacks?.[0]?.Outputs || [];
    const getOutput = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue;

    const resolvedBucket = bucket || getOutput('BucketName');
    const resolvedUrl = functionUrl || getOutput('FunctionUrl');

    if (resolvedBucket && resolvedUrl) {
      return { bucket: resolvedBucket, functionUrl: resolvedUrl };
    }
  } catch (err: any) {
    // Fall through to error
  }

  console.error(`\n  ERROR: Could not resolve stack configuration.`);
  console.error(`  Either deploy the stack ("${STACK_NAME}") or set LITEPARSE_BUCKET and LITEPARSE_FUNCTION_URL env vars.\n`);
  process.exit(1);
}

const config = await resolveStackConfig();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const s3 = new S3Client({});

// Parse file directly via Lambda Function URL
app.post('/api/parse', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const mode = req.query.text === 'true' ? '?text=true' : '';
  const queryParams: Record<string, string> = req.query.text === 'true' ? { text: 'true' } : {};
  const boundary = `----FormBoundary${Date.now()}`;
  const formParts: Buffer[] = [];

  formParts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${req.file.originalname}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  ));
  formParts.push(req.file.buffer);
  formParts.push(Buffer.from('\r\n'));
  formParts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(formParts);
  const url = new URL('parse', config.functionUrl);

  try {
    const request = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: url.hostname,
      path: url.pathname,
      query: queryParams,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
        host: url.hostname,
      },
      body,
    });

    const signed = await signer.sign(request);

    const fetchUrl = `${url.origin}${url.pathname}${mode}`;
    const response = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${mode}`,
        method: 'POST',
        headers: signed.headers as Record<string, string>,
      }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve({
          status: resp.statusCode || 500,
          headers: resp.headers as Record<string, string>,
          body: data,
        }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json({ error: `Parse failed: ${response.status}`, detail: response.body });
    }

    const contentType = response.headers['content-type'] || 'text/plain';
    res.setHeader('Content-Type', contentType);
    res.send(response.body);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to reach parse service', detail: err.message });
  }
});

// Upload to S3 for batch processing (keeps the S3 pipeline working)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = req.file.originalname.replace(/\s+/g, '_');
  const key = `raw/${today}/${fileName}`;

  await s3.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
  }));

  const processedPrefix = `processed/${today}/${fileName}`;
  res.json({ key, processedPrefix, bucket: config.bucket });
});

// Poll for processed results (used by batch/S3 pipeline)
app.get('/api/status', async (req, res) => {
  const prefix = req.query.prefix as string;
  if (!prefix) return res.status(400).json({ error: 'Missing prefix param' });

  const txtKey = `${prefix}.txt`;
  const jsonKey = `${prefix}.json`;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: txtKey }));
    await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: jsonKey }));
    res.json({ ready: true, txtKey, jsonKey });
  } catch {
    res.json({ ready: false });
  }
});

// Download processed result
app.get('/api/download', async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const contentType = key.endsWith('.json') ? 'application/json' : 'text/plain';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);

    const stream = resp.Body as Readable;
    stream.pipe(res);
  } catch (err: any) {
    res.status(404).json({ error: 'File not found', detail: err.message });
  }
});

// Preview parsed text
app.get('/api/preview', async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Missing key param' });

  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as Readable) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(Buffer.concat(chunks).toString('utf-8'));
  } catch (err: any) {
    res.status(404).json({ error: 'File not found' });
  }
});

// Static files served after API routes
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  ╶─── LiteParse UI ───╴\n`);
  console.log(`  Local:        http://localhost:${PORT}`);
  console.log(`  Function URL: ${config.functionUrl}`);
  console.log(`  Bucket:       ${config.bucket}\n`);
});
