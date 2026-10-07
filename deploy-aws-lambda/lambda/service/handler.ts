import type { Context } from 'aws-lambda';

/** Set once per execution environment: the first call after a cold start sees true. */
let coldStart = true;

/** The demo service: reports which published version served the call. */
export const handler = async (event: unknown, context: Context) => {
  const started = Date.now();
  console.log(`Lambda version: ${context.functionVersion}`);
  console.log(`Request id: ${context.awsRequestId}`);
  // which alias was called (…:service-lambda-dev:live), whether this environment is new, and the
  // event's shape without its values
  console.log(JSON.stringify({
    msg: 'invoked',
    invokedArn: context.invokedFunctionArn,
    coldStart,
    eventKeys: event && typeof event === 'object' ? Object.keys(event).sort() : typeof event,
    remainingMs: context.getRemainingTimeInMillis(),
  }));
  coldStart = false;

  const result = { version: context.functionVersion };
  console.log(JSON.stringify({ msg: 'done', version: context.functionVersion, durationMs: Date.now() - started }));
  return result;
};
