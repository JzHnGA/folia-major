import type { OnlineMusicProvider } from '../../../types/onlineMusic';
import { neteaseProvider as legacyNeteaseProvider } from './neteaseProvider';
import { neteaseOfficialProvider } from './official/officialProvider';

// src/services/onlineMusic/netease/neteaseProviderChoice.ts
// Which implementation is the `netease` platform in this build: the legacy NeteaseCloudMusicApi
// provider (the default) or the official OpenAPI one behind the Ecria gateway
// (VITE_NETEASE_PROVIDER=official). Exactly one is registered, so their logins, ids and caches
// never mix; switching back is a rebuild with the variable unset.

const choice = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_NETEASE_PROVIDER;

export const usesOfficialNetease = choice === 'official';

export const neteaseProvider: OnlineMusicProvider = usesOfficialNetease ? neteaseOfficialProvider : legacyNeteaseProvider;
