// What a recorded deployment of api-user-<env> serves, from its OpenAPI export in S3: the routes
// (method + path), so the page can say what a rollback or restore changes. Only a summary is sent
// on: the export also holds integration details (Lambda ARNs, authorizer config) the page doesn't need.
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getRecordedDeployment } from './api-gateway-deployments.js';

/** What GET /api/api-gateways/<id>/spec?deployedAt=... returns (app/src/api.ts has the same shape). */
export interface ApiSpecSummary {
  deployedAt: string;
  title?: string;
  version?: string;
  /** "GET /users", sorted; ANY for x-amazon-apigateway-any-method */
  routes: string[];
}

/** Larger exports are refused: api-user's is a few KB. */
export const MAX_SPEC_BYTES = 1024 * 1024;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** The routes of an OpenAPI document. */
export function routesOf(spec: { paths?: Record<string, Record<string, unknown>> }): string[] {
  const routes: string[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const key of Object.keys(item ?? {})) {
      if (METHODS.includes(key)) routes.push(`${key.toUpperCase()} ${path}`);
      else if (key === 'x-amazon-apigateway-any-method') routes.push(`ANY ${path}`);
    }
  }
  return routes.sort();
}

export type SpecResult =
  | { ok: true; spec: ApiSpecSummary }
  | { ok: false; status: 404 | 502; message: string };

export async function getRecordedSpec(
  dynamo: DynamoDBDocumentClient,
  s3: S3Client,
  project: string,
  api: { id: string; name: string },
  deployedAt: string,
): Promise<SpecResult> {
  const record = await getRecordedDeployment(dynamo, project, api, deployedAt);
  if (!record) return { ok: false, status: 404, message: `No deployment of ${api.name} recorded at ${deployedAt}` };

  let text: string;
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: record.specBucket, Key: record.specKey }));
    if ((object.ContentLength ?? 0) > MAX_SPEC_BYTES) {
      return { ok: false, status: 502, message: `The OpenAPI export of ${deployedAt} is too large to read here` };
    }
    text = await object.Body!.transformToString();
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return { ok: false, status: 404, message: `The OpenAPI export of ${deployedAt} is missing from S3` };
    throw err;
  }
  const spec = JSON.parse(text) as { info?: { title?: string; version?: string }; paths?: Record<string, Record<string, unknown>> };
  return {
    ok: true,
    spec: {
      deployedAt,
      ...(spec.info?.title && { title: spec.info.title }),
      ...(spec.info?.version && { version: spec.info.version }),
      routes: routesOf(spec),
    },
  };
}
