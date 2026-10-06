import { GetAliasCommand, InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

export const lambda = new LambdaClient({});

/** The version an alias points to, or undefined if the function or alias doesn't exist yet. */
export async function aliasVersion(functionName: string, alias: string) {
  try {
    const { FunctionVersion, RevisionId } = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: alias }));
    return { version: FunctionVersion!, revisionId: RevisionId };
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return undefined;
    throw err;
  }
}

/** Invokes a function synchronously; returns the parsed payload, or throws on a function error. */
export async function invokeJson<T = unknown>(functionName: string, payload: unknown, qualifier?: string): Promise<T> {
  const res = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    Qualifier: qualifier,
    Payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  const text = res.Payload ? new TextDecoder().decode(res.Payload) : '';
  if (res.FunctionError) throw new Error(`${functionName}${qualifier ? `:${qualifier}` : ''} failed (${res.FunctionError}): ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
