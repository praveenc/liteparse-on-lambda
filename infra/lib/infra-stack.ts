import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3 Bucket ---
    const bucket = new s3.Bucket(this, 'DocsBucket', {
      bucketName: `liteparse-docs-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          prefix: 'raw/',
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
        {
          prefix: 'processed/',
          expiration: cdk.Duration.days(90),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // --- ECR Repository (pre-existing, image pushed externally) ---
    // Note: DockerImageCode.fromImageAsset handles ECR push automatically

    // --- LiteParse Lambda (container image with Lambda Web Adapter) ---
    const parseFunction = new lambda.DockerImageFunction(this, 'ParseFunction', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..', 'docker')),
      architecture: lambda.Architecture.X86_64,
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      timeout: cdk.Duration.minutes(5),
      logGroup: new logs.LogGroup(this, 'ParseLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        AWS_LWA_PORT: '5000',
        AWS_LWA_READINESS_CHECK_PATH: '/parse',
        AWS_LWA_READINESS_CHECK_MIN_UNHEALTHY_STATUS: '500',
        HOME: '/tmp',
      },
    });

    // Function URL (no auth - URL is obscure, intended for personal use)
    const functionUrl = parseFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['content-type'],
      },
    });

    // --- Trigger Lambda: S3 raw/ -> parse via Function URL -> S3 processed/ ---
    const triggerFunction = new nodejs.NodejsFunction(this, 'TriggerFunction', {
      entry: path.join(__dirname, 'lambda', 'parse-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        FUNCTION_URL: functionUrl.url,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant trigger Lambda read/write to the bucket
    bucket.grantReadWrite(triggerFunction);

    // Trigger on new objects in raw/
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(triggerFunction),
      { prefix: 'raw/' },
    );

    // --- CloudWatch Alarms ---
    new cloudwatch.Alarm(this, 'ParseErrorAlarm', {
      metric: parseFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 2,
      alarmDescription: 'LiteParse function errors',
    });

    new cloudwatch.Alarm(this, 'ParseDurationAlarm', {
      metric: parseFunction.metricDuration({ period: cdk.Duration.minutes(5) }),
      threshold: 240_000, // 4 minutes (approaching 5 min timeout)
      evaluationPeriods: 2,
      alarmDescription: 'LiteParse function duration approaching timeout',
    });

    new cloudwatch.Alarm(this, 'ParseThrottleAlarm', {
      metric: parseFunction.metricThrottles({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 2,
      alarmDescription: 'LiteParse function throttled',
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'FunctionUrl', { value: functionUrl.url });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'ParseFunctionName', { value: parseFunction.functionName });
    new cdk.CfnOutput(this, 'ParseFunctionArn', { value: parseFunction.functionArn });
    new cdk.CfnOutput(this, 'TriggerFunctionName', { value: triggerFunction.functionName });
  }
}
