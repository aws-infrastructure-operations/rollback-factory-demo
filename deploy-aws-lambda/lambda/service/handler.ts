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

  // DEMO BRANCH (demo/pr-environment-fails) - DO NOT MERGE.
  // Shows the pull request environment stopping a bad change before it can be merged: the service
  // now needs a pricing table, but nobody added PRICING_TABLE to the stack. The unit tests don't
  // call the handler, so the PR's "test" job passes; its "pr environment" job deploys
  // service-lambda-pr-<n>, every call to it throws, the integration tests fail, and the stack is
  // deleted again. With "pr environment" as a required check, the PR can't be merged.
  const pricingTable = process.env.PRICING_TABLE;
  if (!pricingTable) throw new Error('PRICING_TABLE is not configured');

  const result = { version: context.functionVersion };
  console.log(JSON.stringify({ msg: 'done', version: context.functionVersion, durationMs: Date.now() - started }));
  return result;
};
