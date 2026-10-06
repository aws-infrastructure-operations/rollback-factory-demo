import type { Context } from 'aws-lambda';

/** The demo service: reports which published version served the call. */
export const handler = async (_event: unknown, context: Context) => {
  console.log(`Lambda version: ${context.functionVersion}`);
  console.log(`Request id: ${context.awsRequestId}`);
  return { version: context.functionVersion };
};
