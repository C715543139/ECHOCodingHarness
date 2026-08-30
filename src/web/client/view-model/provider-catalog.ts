import type { ProviderConfigDto } from '../../../contracts/web.js';

export function catalogModels(provider: ProviderConfigDto): readonly string[] {
  return provider.catalog.source === 'manual'
    ? provider.catalog.models
    : provider.catalog.cachedModels;
}
