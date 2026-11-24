import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    hasOfficialSignIn,
    keepOfficialSignIn,
    officialRequest,
    resetOfficialGatewayState,
} from '../../../src/services/onlineMusic/netease/official/officialGateway';

// test/unit/onlineMusic/neteaseOfficialGateway.test.ts
// The official provider's token handling against a fake EcriaSecurity plugin: refresh on 1406, a
// stale request never drops a login kept after it started, a refresh failure that says nothing about
// the token keeps the sign-in, and records made under another app identity are not used.

type Answer = Record<string, unknown>;

const keychain = new Map<string, string>();
let uid: string | null = 'uid-a';
// The gateway identity of the native side; null makes gatewayIdentity fail.
let handler: (action: string, payload: Record<string, unknown>) => Promise<Answer>;
const calls: Array<{ action: string; accessToken: unknown }> = [];

beforeEach(() => {
    keychain.clear();
    calls.length = 0;
    uid = 'uid-a';
    resetOfficialGatewayState();
    (globalThis as unknown as { window: unknown }).window = {
        Capacitor: {
            Plugins: {
                EcriaSecurity: {
                    gatewayIdentity: () => (uid ? Promise.resolve({ uid }) : Promise.reject(new Error('no identity'))),
                    secureGet: ({ id }: { id: string }) => Promise.resolve({ value: keychain.get(id) ?? null }),
                    secureSet: ({ id, value }: { id: string; value: string }) => { keychain.set(id, value); return Promise.resolve(); },
                    secureDelete: ({ id }: { id: string }) => { keychain.delete(id); return Promise.resolve(); },
                    callNetease: ({ action, payload }: { action: string; payload: Record<string, unknown> }) => {
                        calls.push({ action, accessToken: payload.accessToken });
                        return handler(action, payload);
                    },
                },
            },
        },
    };
});

afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
});

const ok = (extra: Answer = {}): Answer => ({ httpStatus: 200, ok: true, data: {}, ...extra });
const refused = (upstreamCode: number): Answer => ({ httpStatus: 200, ok: false, upstreamCode, message: 'no' });

describe('official NetEase tokens', () => {
    it('renews on 1406 and asks again with the new token', async () => {
        await keepOfficialSignIn('oldAccess', 'oldRefresh');
        handler = (action, payload) => {
            if (action === 'authRefresh') return Promise.resolve(ok({ accessToken: 'newAccess', refreshToken: 'newRefresh' }));
            return Promise.resolve(payload.accessToken === 'oldAccess' ? refused(1406) : ok());
        };
        await officialRequest('lyric', { songId: 'ABC1' }, 'the lyrics');
        expect(calls.map(call => call.accessToken)).toEqual(['oldAccess', 'oldAccess', 'newAccess']);
        expect(keychain.get('netease.official.access')).toContain('newAccess');
    });

    it('does not drop a login kept while a stale request was out', async () => {
        await keepOfficialSignIn('oldAccess', 'oldRefresh');
        let release!: () => void;
        handler = action => (action === 'lyric'
            ? new Promise(resolve => { release = () => resolve(refused(1408)); })
            : Promise.resolve(ok()));
        const stale = officialRequest('lyric', { songId: 'ABC1' }, 'the lyrics').catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 0));
        await keepOfficialSignIn('freshAccess', 'freshRefresh');
        release();
        await stale;
        expect(await hasOfficialSignIn()).toBe(true);
        expect(keychain.get('netease.official.access')).toContain('freshAccess');
    });

    it('keeps the sign-in when the refresh fails for another reason', async () => {
        await keepOfficialSignIn('oldAccess', 'oldRefresh');
        handler = action => Promise.resolve(action === 'authRefresh'
            ? { httpStatus: 503, ok: false, error: { code: 'not-configured', message: 'x' } }
            : refused(1406));
        await expect(officialRequest('lyric', { songId: 'ABC1' }, 'the lyrics')).rejects.toThrow();
        expect(await hasOfficialSignIn()).toBe(true);
    });

    it('drops the sign-in when NetEase refuses the refresh token', async () => {
        await keepOfficialSignIn('oldAccess', 'oldRefresh');
        handler = () => Promise.resolve(refused(1406));
        await expect(officialRequest('lyric', { songId: 'ABC1' }, 'the lyrics')).rejects.toThrow();
        expect(await hasOfficialSignIn()).toBe(false);
    });

    it('does not use a NetEase sign-in made under another app identity', async () => {
        await keepOfficialSignIn('aAccess', 'aRefresh');
        resetOfficialGatewayState();
        uid = 'uid-b';
        expect(await hasOfficialSignIn()).toBe(false);
        expect(keychain.has('netease.official.access')).toBe(false);
    });

    it('asks nothing without a NetEase sign-in, and reads 301 as sign-in needed', async () => {
        handler = () => Promise.resolve(ok());
        await expect(officialRequest('search', { keyword: 'x' }, 'the search')).rejects.toMatchObject({ code: 'auth-required' });
        expect(calls).toEqual([]);

        await keepOfficialSignIn('access', 'refresh');
        handler = () => Promise.resolve(refused(301));
        await expect(officialRequest('search', { keyword: 'x' }, 'the search')).rejects.toMatchObject({ code: 'auth-required' });
        expect(await hasOfficialSignIn()).toBe(true);
    });

    it('keeps the NetEase sign-in when the app identity cannot be read for a moment', async () => {
        await keepOfficialSignIn('access', 'refresh');
        resetOfficialGatewayState();
        uid = null;
        await expect(hasOfficialSignIn()).rejects.toMatchObject({ code: 'network' });
        uid = 'uid-a';
        expect(await hasOfficialSignIn()).toBe(true);
    });
});
