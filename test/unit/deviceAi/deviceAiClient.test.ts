import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/deviceAi/deviceAiClient.test.ts
// The iOS app's own AI requests: where they go, with which key, and that an OpenAI-compatible key
// never leaves for an endpoint other than the one it was saved for.

const keychain = new Map<string, string>();

vi.mock('../../../src/services/security/nativeSecurity', () => ({
    isNativeSecurityAvailable: () => true,
    secureGet: async (id: string) => keychain.get(id) ?? null,
    secureSet: async (id: string, value: string) => { keychain.set(id, value); },
    secureDelete: async (id: string) => { keychain.delete(id); },
}));

const { generateDeviceTheme, testDeviceAiConnection, chatCompletionsUrlOf } = await import('../../../src/services/deviceAi/deviceAiClient');
const { hasUsableDeviceAiKey, readDeviceAiKey, useDeviceAiSettingsStore } = await import('../../../src/services/deviceAi/deviceAiSettings');
type Config = Parameters<typeof readDeviceAiKey>[0];

const THEME = {
    name: 'n', description: 'd', backgroundColor: '#000000', primaryColor: '#ffffff', accentColor: '#ff0000',
    secondaryColor: '#cccccc', wordColors: [], lyricsIcons: [],
};

const gemini: Config = {
    AI_PROVIDER: 'gemini', AI_PROVIDER_PRESET: 'gemini', OPENAI_API_URL: '', OPENAI_API_MODEL: '', GEMINI_API_MODEL: '', OPENAI_API_TEMPERATURE: '',
};
const deepseek: Config = {
    AI_PROVIDER: 'openai', AI_PROVIDER_PRESET: 'deepseek', OPENAI_API_URL: 'https://api.deepseek.com', OPENAI_API_MODEL: 'deepseek-chat', GEMINI_API_MODEL: '', OPENAI_API_TEMPERATURE: '',
};

const fetchMock = vi.fn();

beforeEach(() => {
    keychain.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('device AI client', () => {
    it('asks Gemini with the Keychain key in a header, never in the address', async () => {
        keychain.set('ai.gemini_api_key', 'g-key');
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ light: THEME, dark: THEME }) }] } }],
        }), { status: 200 }));

        const theme = await generateDeviceTheme(gemini, 'some lyrics');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
        expect(url).not.toContain('g-key');
        expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
        expect(JSON.parse(init.body as string).generationConfig.responseSchema.required).toEqual(['light', 'dark']);
        expect(theme.light.provider).toBe('Google Gemini (iOS)');
    });

    it('asks an OpenAI-compatible provider at its chat completions address with a bearer key', async () => {
        await useDeviceAiSettingsStore.getState().save(deepseek, 'ds-key');
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ light: THEME, dark: THEME }) } }],
        }), { status: 200 }));

        await generateDeviceTheme(deepseek, 'some lyrics');

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ds-key');
        expect(JSON.parse(init.body as string).model).toBe('deepseek-chat');
    });

    it('never shows a saved connection without its key while saving', async () => {
        await useDeviceAiSettingsStore.getState().save(gemini, 'g-key');
        const seen: boolean[] = [];
        const stop = useDeviceAiSettingsStore.subscribe(state => {
            seen.push(hasUsableDeviceAiKey(state.config, state.saved));
        });
        await useDeviceAiSettingsStore.getState().save(deepseek, 'ds-key');
        stop();
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(Boolean)).toBe(true);
    });

    it('does not send a saved key to another endpoint', async () => {
        await useDeviceAiSettingsStore.getState().save(deepseek, 'ds-key');
        const elsewhere: Config = { ...deepseek, AI_PROVIDER_PRESET: 'custom', OPENAI_API_URL: 'https://evil.example/v1' };

        expect(await readDeviceAiKey(elsewhere)).toBeNull();
        expect(hasUsableDeviceAiKey(elsewhere, useDeviceAiSettingsStore.getState().saved)).toBe(false);
        await expect(generateDeviceTheme(elsewhere, 'some lyrics')).rejects.toThrow('AI API key is not configured');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a missing key from the connection test without sending anything', async () => {
        const result = await testDeviceAiConnection(gemini, '');
        expect(result).toMatchObject({ ok: false, errorKind: 'config' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('tests with a typed key and returns the reply', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'Hello!' } }],
        }), { status: 200 }));

        const result = await testDeviceAiConnection(deepseek, 'typed');

        expect(result).toMatchObject({ ok: true, status: 200, text: 'Hello!', model: 'deepseek-chat' });
        expect(((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>).Authorization).toBe('Bearer typed');
    });

    it('completes chat completion addresses as the desktop does', () => {
        expect(chatCompletionsUrlOf('')).toBe('https://api.openai.com/v1/chat/completions');
        expect(chatCompletionsUrlOf('https://host.example/v1/')).toBe('https://host.example/v1/chat/completions');
        expect(chatCompletionsUrlOf('https://host.example/custom/path')).toBe('https://host.example/custom/path');
    });
});
