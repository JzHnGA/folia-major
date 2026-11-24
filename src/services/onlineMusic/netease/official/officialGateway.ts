import { OnlineProviderError } from '../../../../types/onlineMusic';
import { isNativeSecurityAvailable, secureDelete, secureGet, secureSet } from '../../../security/nativeSecurity';
import type { SecuritySecureId } from '../../../security/types';

// src/services/onlineMusic/netease/official/officialGateway.ts
// The official NetEase OpenAPI, reached only through the Ecria gateway (a Vercel function that holds
// the private key and app secret and signs every request). The user's NetEase access/refresh tokens
// and the device's anonymous token live in the iOS Keychain; this module keeps an in-memory copy and
// hands the right one to each request. Nothing here logs a token.
//
// The gateway is called as the app's own silent anonymous Firebase identity (GatewayIdentity in
// ios/App/App/FirebaseREST.swift), never the Google account: NetEase needs no Google sign-in. Both
// records name that identity's uid: the gateway derives NetEase's deviceId from it, so records made
// under another identity (a reinstall that lost it) are not used with the wrong deviceId.
// The access and refresh token are one Keychain record (netease.official.access), written in one
// call, so a crash or two racing writes cannot leave a new access token with an old refresh token.
// Every change to the records runs one at a time, and a request that started before a login was
// kept or dropped never drops or overwrites what came after it (the generation check).

/** The gateway's actions (gateway/ecria-netease-gateway/lib/actions.js; the native side allow-lists the same). */
export type NeteaseGatewayAction =
    | 'authStart'
    | 'anonymousToken'
    | 'authPoll'
    | 'authRefresh'
    | 'search'
    | 'songDetail'
    | 'playUrl'
    | 'lyric'
    | 'wordByWordLyric'
    | 'userProfile'
    | 'recentPlays'
    | 'reportPlay'
    | 'userPlaylists'
    | 'likedPlaylist'
    | 'playlistDetail'
    | 'playlistTracks'
    | 'albumDetail'
    | 'albumTracks'
    | 'userAlbums'
    | 'dailySongs'
    | 'radarPlaylists';

/**
 * What the gateway answers, with the HTTP status the native side saw. `ok: false` with `error` is the
 * gateway refusing (sign-in, payload, rate); with `upstreamCode` it is NetEase refusing (1406 etc.).
 */
export type NeteaseGatewayResult = {
    readonly httpStatus: number;
    readonly ok: boolean;
    readonly error?: { readonly code: string; readonly message: string };
    readonly upstreamCode?: number | null;
    readonly subCode?: string | null;
    readonly message?: string | null;
    readonly [field: string]: unknown;
};

// `callNetease` of the EcriaSecurity plugin (ios/App/App/EcriaSecurityPlugin.swift). It is typed here,
// with the platform, rather than in the shared bridge type.
type GatewayBridge = {
    callNetease?(options: { action: NeteaseGatewayAction; payload: Record<string, unknown> }): Promise<NeteaseGatewayResult>;
    gatewayIdentity?(): Promise<{ uid: string }>;
};

const gatewayBridge = (): GatewayBridge | undefined => (
    (typeof window === 'undefined' ? undefined : window.Capacitor?.Plugins?.EcriaSecurity) as GatewayBridge | undefined
);

const callNetease = (action: NeteaseGatewayAction, payload: Record<string, unknown>): Promise<NeteaseGatewayResult> => {
    const bridge = gatewayBridge();
    if (!bridge?.callNetease) return Promise.reject(new Error('The official NetEase gateway is only available in the iOS app.'));
    return bridge.callNetease({ action, payload });
};

const SESSION: SecuritySecureId = 'netease.official.access';
// An earlier layout kept the refresh token apart; it is cleared whenever the session is written.
const OLD_REFRESH: SecuritySecureId = 'netease.official.refresh';
const ANONYMOUS: SecuritySecureId = 'netease.official.anonymous';

// NetEase's token answers: 1406 the access token ran out (refresh it), 1407 the account is gone or
// banned, 1408 the token is invalid (both: sign in again). -444/-445/-446 the app's rate limit.
const TOKEN_EXPIRED = 1406;
const SIGN_IN_AGAIN = new Set([1407, 1408]);
const TOKEN_REFUSED = new Set([TOKEN_EXPIRED, 1407, 1408]);
// 301 用户未授权当前接口: the interface wants a signed-in user (the CLI app type answers every content
// interface so for the anonymous token, checked 2026-11-19). 300 应用未授权: the app may not call it.
const USER_REQUIRED = 301;
const APP_NOT_ALLOWED = 300;
const RATE_LIMITED = new Set([-444, -445, -446]);

type Session = { uid: string; access: string; refresh: string };
type State = { uid: string; session: Session | null; anonymous: string | null };

let state: State | null = null;
let loading: Promise<State> | null = null;
let refreshing: Promise<'renewed' | 'refused' | 'failed'> | null = null;
// Bumped by every keep and drop of the user's sign-in.
let generation = 0;
let identityUid: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Runs record changes one after another. */
const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
};

const parse = <T>(text: string | null, check: (value: Record<string, unknown>) => T | null): T | null => {
    if (!text) return null;
    try {
        const value: unknown = JSON.parse(text);
        return value && typeof value === 'object' ? check(value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

const readSession = (text: string | null): Session | null => parse(text, value => (
    typeof value.uid === 'string' && typeof value.access === 'string' && typeof value.refresh === 'string' && value.access && value.refresh
        ? { uid: value.uid, access: value.access, refresh: value.refresh }
        : null
));

const readAnonymous = (text: string | null): { uid: string; token: string } | null => parse(text, value => (
    typeof value.uid === 'string' && typeof value.token === 'string' && value.token ? { uid: value.uid, token: value.token } : null
));

/**
 * The uid of the app's gateway identity, asked once (the native side makes the identity on first use).
 * A failure to get it fails the request: it is never read as "another identity", which would drop a
 * NetEase sign-in over a moment without network.
 */
const currentUid = async (): Promise<string> => {
    if (identityUid) return identityUid;
    const bridge = gatewayBridge();
    if (!bridge?.gatewayIdentity) throw new OnlineProviderError('unavailable', 'The official NetEase gateway is only available in the iOS app.', 'netease');
    try {
        identityUid = (await bridge.gatewayIdentity()).uid;
    } catch (error) {
        throw new OnlineProviderError('network', 'Could not get the app identity for the NetEase gateway', 'netease', error);
    }
    return identityUid;
};

const readState = async (): Promise<State> => {
    const uid = await currentUid();
    if (state && state.uid === uid) return state;
    loading ??= exclusive(async () => {
        const [sessionText, anonymousText] = await Promise.all([secureGet(SESSION), secureGet(ANONYMOUS)]);
        const session = readSession(sessionText);
        const anonymous = readAnonymous(anonymousText);
        // Records of another identity (or of the old layout) would go out with the wrong deviceId: they go.
        if (sessionText && (!session || session.uid !== uid)) {
            await secureDelete(SESSION);
            await secureDelete(OLD_REFRESH);
            generation += 1;
            console.info('[NeteaseOfficial] A NetEase sign-in made under another app identity was removed');
        }
        if (anonymousText && (!anonymous || anonymous.uid !== uid)) await secureDelete(ANONYMOUS);
        state = {
            uid,
            session: session && session.uid === uid ? session : null,
            anonymous: anonymous && anonymous.uid === uid ? anonymous.token : null,
        };
        return state;
    }).finally(() => {
        loading = null;
    });
    return loading;
};

const writeSession = (session: Session | null, onlyIf?: number): Promise<boolean> => exclusive(async () => {
    if (onlyIf !== undefined && onlyIf !== generation) return false;
    if (session) await secureSet(SESSION, JSON.stringify(session));
    else await secureDelete(SESSION);
    await secureDelete(OLD_REFRESH);
    generation += 1;
    if (state) state = { ...state, session };
    else if (session) state = { uid: session.uid, session, anonymous: null };
    return true;
});

const writeAnonymous = (uid: string | null, token: string | null): Promise<void> => exclusive(async () => {
    if (token && uid) await secureSet(ANONYMOUS, JSON.stringify({ uid, token }));
    else await secureDelete(ANONYMOUS);
    if (state && state.uid === uid) state = { ...state, anonymous: token };
});

/** The gateway is there to be asked: the iOS shell with its address built in. */
export const officialGatewayReady = (): boolean => isNativeSecurityAvailable();

const IDENTITY_CODES = new Set(['auth-missing', 'auth-invalid', 'auth-not-google', 'auth-unverified', 'auth-required', 'auth-wrong-project', 'auth-disabled']);

const gatewayError = (result: NeteaseGatewayResult, what: string): OnlineProviderError => {
    const code = result.error?.code ?? '';
    if (IDENTITY_CODES.has(code)) {
        return new OnlineProviderError('unavailable', `The NetEase gateway did not accept this app (${code})`, 'netease', result, result.httpStatus);
    }
    if (result.httpStatus === 429 || RATE_LIMITED.has(Number(result.upstreamCode))) {
        return new OnlineProviderError('unavailable', `NetEase limited the requests for ${what}`, 'netease', result, 429);
    }
    if (result.httpStatus === 502 || result.httpStatus === 504) {
        return new OnlineProviderError('network', `The gateway could not reach NetEase for ${what}`, 'netease', result, result.httpStatus);
    }
    if (Number(result.upstreamCode) === APP_NOT_ALLOWED) {
        return new OnlineProviderError('unsupported', `This NetEase app may not call the interface for ${what} (code 300)`, 'netease', result);
    }
    if (TOKEN_REFUSED.has(Number(result.upstreamCode)) || Number(result.upstreamCode) === USER_REQUIRED) {
        return new OnlineProviderError('auth-required', `NetEase refused the sign-in for ${what}: code ${result.upstreamCode}`, 'netease', result);
    }
    const detail = result.error ? `${result.error.code}: ${result.error.message}` : `code ${result.upstreamCode ?? 'none'}: ${result.message ?? ''}`;
    return new OnlineProviderError('unavailable', `The official NetEase service refused ${what} (${detail})`, 'netease', result, result.httpStatus || undefined);
};

const call = async (action: NeteaseGatewayAction, payload: Record<string, unknown>): Promise<NeteaseGatewayResult> => {
    try {
        return await callNetease(action, payload);
    } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'gateway-not-configured') {
            throw new OnlineProviderError('unavailable', 'This build has no NetEase gateway address (ECRIA_NETEASE_GATEWAY_URL)', 'netease', error);
        }
        throw new OnlineProviderError('network', 'Could not reach the official NetEase gateway', 'netease', error);
    }
};

/**
 * Trades the refresh token for a new pair. 'refused': NetEase said no to the refresh token itself
 * (sign in again). 'failed': the refresh did not get an answer about the token (gateway, network,
 * no app secret configured): the sign-in stays.
 */
const refreshTokens = (session: Session, startedAt: number): Promise<'renewed' | 'refused' | 'failed'> => {
    refreshing ??= (async () => {
        const result = await call('authRefresh', { refreshToken: session.refresh, accessToken: session.access });
        if (result.ok && typeof result.accessToken === 'string' && typeof result.refreshToken === 'string') {
            const written = await writeSession({ uid: session.uid, access: result.accessToken, refresh: result.refreshToken }, startedAt);
            if (written) console.info('[NeteaseOfficial] The sign-in was renewed with the refresh token');
            return 'renewed' as const;
        }
        const upstream = Number(result.upstreamCode);
        const refused = TOKEN_REFUSED.has(upstream) || upstream === 400;
        console.warn('[NeteaseOfficial] The token refresh did not succeed', { upstreamCode: result.upstreamCode ?? null, error: result.error?.code ?? null, refused });
        return refused ? 'refused' as const : 'failed' as const;
    })().finally(() => {
        refreshing = null;
    });
    return refreshing;
};

/**
 * One content request, run as the signed-in user. The CLI app type answers content requests made with
 * the anonymous token with 301, so without a NetEase sign-in the request is not made at all. A 1406
 * renews the tokens once and asks again; NetEase refusing the sign-in itself drops it, unless the
 * sign-in changed while the request was out.
 */
export const officialRequest = async (action: NeteaseGatewayAction, payload: Record<string, unknown>, what: string): Promise<NeteaseGatewayResult> => {
    const current = await readState();
    const startedAt = generation;
    const session = current.session;
    if (!session) {
        throw new OnlineProviderError('auth-required', `Sign in to NetEase for ${what}`, 'netease', undefined);
    }

    let result = await call(action, { ...payload, accessToken: session.access });
    const code = Number(result.upstreamCode);
    if (code === TOKEN_EXPIRED) {
        const renewal = await refreshTokens(session, startedAt);
        if (renewal === 'renewed') {
            const renewed = (await readState()).session;
            if (renewed) result = await call(action, { ...payload, accessToken: renewed.access });
        } else if (renewal === 'refused') {
            await writeSession(null, startedAt);
        }
    } else if (SIGN_IN_AGAIN.has(code)) {
        await writeSession(null, startedAt);
    }
    if (!result.ok) throw gatewayError(result, what);
    return result;
};

export const hasOfficialSignIn = async (): Promise<boolean> => Boolean((await readState()).session);

/** Keeps the tokens of a confirmed QR login. Only checkLogin calls it, after NetEase's 803. */
export const keepOfficialSignIn = async (accessToken: string, refreshToken: string): Promise<void> => {
    const { uid } = await readState();
    await writeSession({ uid, access: accessToken, refresh: refreshToken });
};

/** The user's sign-in goes; the device's anonymous token stays, as NetEase binds it to the device. */
export const dropOfficialSignIn = async (): Promise<void> => {
    await readState();
    await writeSession(null);
};

/** Starts a QR login: NetEase's anonymous login and a code bound to it. */
export const startOfficialLogin = async (): Promise<{ uniKey: string; qrCodeUrl: string; anonymousToken: string }> => {
    const { uid } = await readState();
    const result = await call('authStart', {});
    const { uniKey, qrCodeUrl, anonymousToken: anonymous } = result;
    if (!result.ok || typeof uniKey !== 'string' || typeof qrCodeUrl !== 'string' || typeof anonymous !== 'string') {
        throw gatewayError(result, 'the login code');
    }
    await writeAnonymous(uid, anonymous);
    return { uniKey, qrCodeUrl, anonymousToken: anonymous };
};

export const pollOfficialLogin = async (uniKey: string, anonymous: string): Promise<NeteaseGatewayResult> => {
    const result = await call('authPoll', { uniKey, anonymousToken: anonymous });
    if (!result.ok) throw gatewayError(result, 'the login check');
    return result;
};

/** For tests. */
export const resetOfficialGatewayState = (): void => {
    state = null;
    loading = null;
    refreshing = null;
    identityUid = null;
    generation = 0;
    queue = Promise.resolve();
};
