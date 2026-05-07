import { OperationSource } from 'nocodb-sdk';
import { useAgent } from 'request-filtering-agent';
import { isCloud } from '~/utils/constants';

function buildAgents(url: string) {
  return { httpAgent: useAgent(url), httpsAgent: useAgent(url) };
}

export function getFilteredAgents({
  url,
  source,
}: {
  url: string;
  source?: OperationSource;
}) {
  // Cloud always enforces SSRF protection — NC_ALLOW_LOCAL_NETWORK is ignored
  if (isCloud) return buildAgents(url);

  // Global override — disables all SSRF protection for self-hosted
  if (process.env.NC_ALLOW_LOCAL_NETWORK === 'true') return {};

  // Granular overrides (existing env vars)
  if (
    source === OperationSource.HOOKS &&
    process.env.NC_ALLOW_LOCAL_HOOKS === 'true'
  )
    return {};

  if (
    source === OperationSource.EXTERNAL_DBS &&
    process.env.NC_ALLOW_LOCAL_EXTERNAL_DBS === 'true'
  )
    return {};

  return buildAgents(url);
}
