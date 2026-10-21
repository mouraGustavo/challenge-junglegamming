export const config = {
  port: Number(process.env.PORT ?? '3000'),
  database: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? '5433'),
    user: process.env.DB_USER ?? 'challenge',
    password: process.env.DB_PASSWORD ?? 'challenge',
    dbName: process.env.DB_NAME ?? 'wagering',
  },
  sqs: {
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 1,
  },
};
