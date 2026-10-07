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

  // DEMO BRANCH (demo/break-lambda) - DO NOT MERGE.
  // A bad release that only shows in production: calls through the live alias need a pricing table
  // that only exists there, and it was never configured, so they throw. CI tests the integration
  // alias, so this version passes and gets promoted to live; then any call to live is a function
  // error, the errors alarm fires and the rollback service moves live back to the previous version.
  if (context.invokedFunctionArn.endsWith(':live')) {
    const pricingTable = process.env.PRICING_TABLE;
    if (!pricingTable) throw new Error('PRICING_TABLE is not configured');
  }

  const result = { version: context.functionVersion };
  console.log(JSON.stringify({ msg: 'done', version: context.functionVersion, durationMs: Date.now() - started }));
  return result;
};
