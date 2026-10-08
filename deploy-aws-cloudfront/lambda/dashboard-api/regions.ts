// The regions the dashboard's region picker offers: the API Gateway and Lambda panels read the chosen
// one (?region=<code>). CloudFront is global, and the deployment records, rollbacks and the rollback
// services stay in the dashboard's own region (AWS_REGION), whichever region is picked.

/** The regions every account has enabled (opt-in regions left out), with their names in the console. */
export const REGIONS: Readonly<Record<string, string>> = {
  'us-east-1': 'N. Virginia',
  'us-east-2': 'Ohio',
  'us-west-1': 'N. California',
  'us-west-2': 'Oregon',
  'ca-central-1': 'Canada Central',
  'sa-east-1': 'São Paulo',
  'eu-central-1': 'Frankfurt',
  'eu-west-1': 'Ireland',
  'eu-west-2': 'London',
  'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm',
  'ap-south-1': 'Mumbai',
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-2': 'Seoul',
  'ap-northeast-3': 'Osaka',
  'ap-southeast-1': 'Singapore',
  'ap-southeast-2': 'Sydney',
};

export interface RegionList {
  /** the dashboard's own region: the default, and the only one with deployment records */
  home: string;
  regions: Array<{ code: string; name: string }>;
}

export function regionList(home: string): RegionList {
  const codes = Object.keys(REGIONS).includes(home) ? Object.keys(REGIONS) : [home, ...Object.keys(REGIONS)];
  return { home, regions: codes.map((code) => ({ code, name: REGIONS[code] ?? code })) };
}

/** ?region=<code>: the home region when absent, undefined when it isn't one the picker offers. */
export function regionOf(query: URLSearchParams, home: string): string | undefined {
  const region = query.get('region');
  if (!region || region === home) return home;
  return Object.hasOwn(REGIONS, region) ? region : undefined;
}

/** One SDK client per region, created on first use and kept for the container's lifetime. */
export function perRegion<T>(create: (region: string) => T): (region: string) => T {
  const clients = new Map<string, T>();
  return (region) => {
    let client = clients.get(region);
    if (!client) clients.set(region, (client = create(region)));
    return client;
  };
}
