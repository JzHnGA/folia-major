import { create } from 'zustand';
import { AI_PROVIDER_PRESETS, resolveAiConnection } from '../../../shared/ai/providerRegistry.mjs';
import { getStoredStringOrNull, setStoredString } from '../../stores/storagePrimitives';
import { openAIEndpointOf } from '../../utils/openAIEndpoint';
import { isNativeSecurityAvailable, secureDelete, secureGet, secureSet } from '../security/nativeSecurity';

// src/services/deviceAi/deviceAiSettings.ts
// The AI connection of the iOS app, where there is no main process and no server of ours to hold a
// key: the provider, address, model and temperature are kept in localStorage, the key in the
// Keychain (EcriaSecurity's secure* ids). The fields carry the desktop's names so the shared
// provider registry reads them unchanged. An OpenAI-compatible key is saved with the endpoint it
// was typed for and is never sent anywhere else, as the desktop's aiCredentialStore does.

const STORAGE_KEY = 'device_ai_settings_v1';
const GEMINI_KEY_ID = 'ai.gemini_api_key';
const OPENAI_KEY_ID = 'ai.openai_api_key';

/** Protocols the iOS app speaks; Anthropic's own protocol is desktop only for now. */
export const DEVICE_AI_PROTOCOLS = ['openai', 'gemini'] as const;

/** The presets the iOS form offers. */
export const DEVICE_AI_PRESETS = AI_PROVIDER_PRESETS.filter(preset => (DEVICE_AI_PROTOCOLS as readonly string[]).includes(preset.protocol));

export type DeviceAiConfig = {
    AI_PROVIDER: 'gemini' | 'openai';
    AI_PROVIDER_PRESET: string;
    OPENAI_API_URL: string;
    OPENAI_API_MODEL: string;
    GEMINI_API_MODEL: string;
    OPENAI_API_TEMPERATURE: string;
};

export type DeviceAiKeyName = 'gemini' | 'openai';

/** What the Keychain holds; the key itself never enters the store. */
type SavedKeys = { gemini: boolean; openaiEndpoint: string | null };

const DEFAULT_CONFIG: DeviceAiConfig = {
    AI_PROVIDER: 'gemini',
    AI_PROVIDER_PRESET: 'gemini',
    OPENAI_API_URL: '',
    OPENAI_API_MODEL: '',
    GEMINI_API_MODEL: '',
    OPENAI_API_TEMPERATURE: '',
};

const readConfig = (): DeviceAiConfig => {
    const text = getStoredStringOrNull(STORAGE_KEY);
    if (!text) return DEFAULT_CONFIG;
    try {
        const parsed = JSON.parse(text) as Partial<Record<keyof DeviceAiConfig, unknown>>;
        const pick = (key: keyof DeviceAiConfig) => (typeof parsed[key] === 'string' ? parsed[key] : DEFAULT_CONFIG[key]);
        return {
            AI_PROVIDER: parsed.AI_PROVIDER === 'openai' ? 'openai' : 'gemini',
            AI_PROVIDER_PRESET: pick('AI_PROVIDER_PRESET'),
            OPENAI_API_URL: pick('OPENAI_API_URL'),
            OPENAI_API_MODEL: pick('OPENAI_API_MODEL'),
            GEMINI_API_MODEL: pick('GEMINI_API_MODEL'),
            OPENAI_API_TEMPERATURE: pick('OPENAI_API_TEMPERATURE'),
        };
    } catch {
        return DEFAULT_CONFIG;
    }
};

/** The stored OpenAI-compatible key and the endpoint it belongs to, or null. */
const parseOpenAIKey = (text: string | null): { key: string; endpoint: string } | null => {
    if (!text) return null;
    try {
        const parsed = JSON.parse(text) as { key?: unknown; endpoint?: unknown };
        return typeof parsed.key === 'string' && parsed.key && typeof parsed.endpoint === 'string'
            ? { key: parsed.key, endpoint: parsed.endpoint }
            : null;
    } catch {
        return null;
    }
};

/** Which keys the Keychain holds, without reading them out into the store. */
const readSavedKeys = async (): Promise<SavedKeys> => {
    const [gemini, openai] = await Promise.all([secureGet(GEMINI_KEY_ID), secureGet(OPENAI_KEY_ID)]);
    return { gemini: Boolean(gemini), openaiEndpoint: parseOpenAIKey(openai)?.endpoint ?? null };
};

type DeviceAiState = {
    config: DeviceAiConfig;
    saved: SavedKeys;
    /** False until the Keychain has been asked which keys exist. */
    keysLoaded: boolean;
    /** The Keychain could not be read: which keys exist is unknown, which is not the same as none. */
    keysFailed: boolean;
    loadKeys: () => Promise<void>;
    /** Saves the connection; a non-empty `typedKey` replaces the key of its protocol. */
    save: (config: DeviceAiConfig, typedKey: string) => Promise<void>;
    clearKey: (name: DeviceAiKeyName) => Promise<void>;
};

export const useDeviceAiSettingsStore = create<DeviceAiState>((set, get) => ({
    config: readConfig(),
    saved: { gemini: false, openaiEndpoint: null },
    keysLoaded: false,
    keysFailed: false,
    loadKeys: async () => {
        if (!isNativeSecurityAvailable()) {
            set({ keysLoaded: true, keysFailed: false });
            return;
        }
        try {
            set({ saved: await readSavedKeys(), keysLoaded: true, keysFailed: false });
        } catch (error) {
            console.warn('[deviceAi] could not read the saved keys', error);
            set({ keysLoaded: true, keysFailed: true });
        }
    },
    save: async (config, typedKey) => {
        const key = typedKey.trim();
        if (key) {
            if (config.AI_PROVIDER === 'gemini') {
                await secureSet(GEMINI_KEY_ID, key);
            } else {
                await secureSet(OPENAI_KEY_ID, JSON.stringify({ key, endpoint: openAIEndpointOf(config.OPENAI_API_URL) }));
            }
        }
        setStoredString(STORAGE_KEY, JSON.stringify(config));
        // The config and what the Keychain holds change together: a new config read against the old
        // keys looks like "no key" for a moment, and the settings would switch the theme source away.
        try {
            set({ config, saved: await readSavedKeys(), keysLoaded: true, keysFailed: false });
        } catch (error) {
            console.warn('[deviceAi] could not read the saved keys', error);
            set({ config, keysLoaded: true, keysFailed: true });
        }
        console.info(`[deviceAi] saved the AI connection (${config.AI_PROVIDER_PRESET})${key ? ' with a new key' : ''}`);
    },
    clearKey: async (name) => {
        await secureDelete(name === 'gemini' ? GEMINI_KEY_ID : OPENAI_KEY_ID);
        await get().loadKeys();
        console.info(`[deviceAi] removed the saved ${name} key`);
    },
}));

/** Whether this app keeps its own AI key: the iOS shell, whose Keychain bridge holds it. */
export const isDeviceAiHost = (): boolean => isNativeSecurityAvailable();

/** Whether `config` has a saved key it may use: Gemini's, or an OpenAI-compatible one typed for this endpoint. */
export const hasUsableDeviceAiKey = (config: DeviceAiConfig, saved: SavedKeys): boolean => (
    config.AI_PROVIDER === 'gemini'
        ? saved.gemini
        : saved.openaiEndpoint !== null && saved.openaiEndpoint === openAIEndpointOf(config.OPENAI_API_URL)
);

/** The connection the saved settings describe, limited to the protocols the iOS app speaks. */
export const resolveDeviceAiConnection = (config: DeviceAiConfig) => (
    resolveAiConnection(config, { protocols: [...DEVICE_AI_PROTOCOLS] })
);

/**
 * The key the saved settings send with, read from the Keychain at the moment of the request, or
 * null when there is none for this connection.
 */
export const readDeviceAiKey = async (config: DeviceAiConfig): Promise<string | null> => {
    if (config.AI_PROVIDER === 'gemini') {
        return secureGet(GEMINI_KEY_ID);
    }
    const stored = parseOpenAIKey(await secureGet(OPENAI_KEY_ID));
    return stored && stored.endpoint === openAIEndpointOf(config.OPENAI_API_URL) ? stored.key : null;
};
