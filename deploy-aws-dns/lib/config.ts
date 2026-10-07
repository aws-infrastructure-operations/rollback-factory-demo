/** Every resource of this repo is named rollback-factory-demo-<resource>[-<env>]. */
export const PROJECT_NAME = 'rollback-factory-demo';
/** This project's folder and stack name. One stack for every environment: the zone is shared. */
export const STACK_NAME = 'deploy-aws-dns';

/** The parent domain. Its DNS is hosted elsewhere: it delegates ZONE_NAME to the zone this stack creates. */
export const PARENT_DOMAIN = 'ionuteliantudor.com';
/** The zone of every site this repo serves: <env>[-integration].rollback.ionuteliantudor.com. */
export const ZONE_NAME = `rollback.${PARENT_DOMAIN}`;

/**
 * The domain of each CloudFront distribution (deploy-aws-cloudfront), in this zone:
 * - dev:  dev.rollback… (frontend-user-dev), dev-integration.rollback… (frontend-user-dev-integration)
 * - prod: rollback… (frontend-user-prod), integration.rollback… (frontend-user-prod-integration)
 */
export function siteDomains(envName: string): { site: string; integration: string } {
  return envName === 'prod'
    ? { site: ZONE_NAME, integration: `integration.${ZONE_NAME}` }
    : { site: `${envName}.${ZONE_NAME}`, integration: `${envName}-integration.${ZONE_NAME}` };
}
