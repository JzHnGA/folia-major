import { budgetFor } from '../../../shared/ai/aiTasks.mjs';
import { runAttempts, walkAttempts } from '../../../shared/ai/attemptRunner.mjs';
import { MAX_ERROR_BODY_CHARS, buildCompatibleBody, exhaustedByReasoning, withErrorHint } from '../../../shared/ai/compatibleBody.mjs';
import { generateContentUrl } from '../../../shared/ai/gemini.mjs';
import { getAiAdapter } from '../../../shared/ai/providerRegistry.mjs';
import {
    THEME_GEMINI_SCHEMA,
    THEME_JSON_SCHEMA,
    THEME_JSON_SCHEMA_NAME,
    THEME_MAX_OUTPUT_TOKENS,
    THEME_SOURCE_MAX_CHARS,
    buildThemeSourcePrompt,
    buildThemeSystemPrompt,
} from '../../../shared/ai/themePrompt.mjs';
import { sendOpenAICompatibleRequest } from '../../../shared/openAICompatibleRequest.mjs';
import type { DualTheme } from '../../types';
import { readDeviceAiKey, resolveDeviceAiConnection, type DeviceAiConfig } from './deviceAiSettings';

// src/services/deviceAi/deviceAiClient.ts
// The iOS app's own AI requests: the theme made from a song's lyrics and the settings form's
// connection test, sent from the app with the user's key. Bodies, attempts and reasoning switches
// come from the shared provider adapters (shared/ai/), the same ones the desktop main process
// sends with; Capacitor's native HTTP carries the request, so the providers' CORS rules do not
// apply. Only the OpenAI-compatible and Gemini protocols are spoken here.

const THEME_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 512;
const TEST_PROMPT = 'hello';
const TEST_MAX_REPLY_CHARS = 500;
const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TEMPERATURE = 0.7;

type SendResult = {
    ok: boolean;
    status?: number;
    content?: string | null;
    exhausted?: boolean;
    errorText?: string;
    errorBody?: string;
};

/** A signal that aborts after `ms`, also where AbortSignal.timeout is missing (older WebKit). */
const timeoutSignal = (ms: number): AbortSignal => {
    if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
};

/** The chat completions address of an OPENAI_API_URL, completed as the desktop and the web route do. */
export const chatCompletionsUrlOf = (rawUrl: string): string => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return DEFAULT_OPENAI_CHAT_COMPLETIONS_URL;
    try {
        const parsed = new URL(trimmed);
        const path = parsed.pathname.replace(/\/+$/, '');
        if (!path || path === '/') {
            parsed.pathname = '/v1/chat/completions';
        } else if (/\/v\d+$/.test(path)) {
            parsed.pathname = `${path}/chat/completions`;
        } else {
            parsed.pathname = path;
        }
        return parsed.toString();
    } catch {
        return trimmed.replace(/\/+$/, '');
    }
};

/** The provider's own error line out of an error body, or the body itself. */
const errorLineOf = (status: number, statusText: string, rawText: string) => {
    let detail = rawText.trim();
    try {
        const parsed = JSON.parse(rawText) as { error?: unknown; message?: unknown };
        const error = parsed.error;
        const message = typeof error === 'string'
            ? error
            : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message
                : typeof parsed.message === 'string' ? parsed.message : null;
        detail = message || detail;
    } catch {
        // Not JSON: keep the text.
    }
    return `API error (${status}): ${detail || statusText}`;
};

/** The text of an OpenAI-compatible message, or null; a refusal is thrown. */
const messageText = (message: { content?: unknown; refusal?: unknown } | undefined): string | null => {
    if (!message) return null;
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new Error(`Model refused request: ${message.refusal}`);
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        const text = message.content
            .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === 'object')
            .filter(part => part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text as string)
            .join('');
        return text || null;
    }
    return null;
};

type Attempt = { label: string; reasoningOff: boolean; params: Record<string, unknown>; knobs: string[]; sendTemperature?: boolean };

type AskOptions = {
    task: 'theme' | 'test';
    config: DeviceAiConfig;
    apiKey: string;
    systemPrompt?: string;
    sourcePrompt: string;
    answerTokens: number;
    timeoutMs: number;
};

type Ask = {
    adapter: NonNullable<ReturnType<typeof getAiAdapter>>;
    url: string;
    model: string;
    send: (attempt: Attempt) => Promise<SendResult>;
};

/** One ask in the shape the attempt runner walks: where it goes, and how one attempt is sent. */
const prepareAsk = ({ task, config, apiKey, systemPrompt, sourcePrompt, answerTokens, timeoutMs }: AskOptions): Ask => {
    const connection = resolveDeviceAiConnection(config);
    const adapter = getAiAdapter(connection.adapterId);
    if (!adapter) throw new Error(`Unknown AI provider ${connection.adapterId}`);
    const model = connection.model;

    if (connection.protocol === 'gemini') {
        const url = generateContentUrl(model);
        if (!adapter.buildBody) throw new Error('The Gemini adapter builds no request body');
        const buildBody = (request: Parameters<NonNullable<typeof adapter.buildBody>>[0]): Record<string, unknown> => (
            adapter.buildBody?.(request) as Record<string, unknown>
        );
        return {
            adapter, url, model,
            send: async (attempt) => {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    body: JSON.stringify(buildBody({
                        task, model, attempt, systemPrompt, sourcePrompt,
                        ...(task === 'theme' ? { geminiSchema: THEME_GEMINI_SCHEMA } : {}),
                        budget: budgetFor(task, answerTokens, attempt),
                    })),
                    signal: timeoutSignal(timeoutMs),
                });
                if (!response.ok) {
                    const rawText = await response.text();
                    return { ok: false, status: response.status, errorText: errorLineOf(response.status, response.statusText, rawText), errorBody: rawText.slice(0, MAX_ERROR_BODY_CHARS) };
                }
                const data = await response.json() as {
                    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
                    usageMetadata?: { thoughtsTokenCount?: number };
                };
                const candidate = data.candidates?.[0];
                const text = (candidate?.content?.parts ?? [])
                    .filter(part => part.thought !== true && typeof part.text === 'string')
                    .map(part => part.text as string)
                    .join('');
                return {
                    ok: true,
                    status: response.status,
                    content: text || null,
                    // Gemini counts thinking inside maxOutputTokens: a MAX_TOKENS finish with thoughts means thinking ate the cap.
                    exhausted: candidate?.finishReason === 'MAX_TOKENS' && (data.usageMetadata?.thoughtsTokenCount ?? 0) > 0,
                };
            },
        };
    }

    const url = chatCompletionsUrlOf(config.OPENAI_API_URL);
    const typedTemperature = Number.parseFloat(config.OPENAI_API_TEMPERATURE.trim());
    const temperature = Number.isFinite(typedTemperature) ? typedTemperature : DEFAULT_TEMPERATURE;
    return {
        adapter, url, model,
        send: async (attempt) => {
            const response = await sendOpenAICompatibleRequest({
                apiUrl: url,
                provider: adapter.id,
                ...(adapter.rejectedParameter
                    ? { rejectsFormat: (status: number, text: string, field: string) => Boolean(adapter.rejectedParameter?.(status, text, field)) }
                    : {}),
                body: buildCompatibleBody(adapter, {
                    task, model, attempt, systemPrompt, sourcePrompt,
                    ...(task === 'theme' ? { schema: THEME_JSON_SCHEMA, schemaName: THEME_JSON_SCHEMA_NAME } : {}),
                    budget: budgetFor(task, answerTokens, attempt),
                    temperature,
                }),
                init: {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                    signal: timeoutSignal(timeoutMs),
                },
            });
            if (!response.ok) {
                const rawText = await response.text();
                // withErrorHint is untyped JS: it hands back this same shape, with a hint appended to errorText.
                return withErrorHint(adapter, {
                    ok: false,
                    status: response.status,
                    errorText: errorLineOf(response.status, response.statusText, rawText),
                    errorBody: rawText.slice(0, MAX_ERROR_BODY_CHARS),
                }) as SendResult;
            }
            const data = await response.json() as {
                choices?: Array<{ finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }>;
                usage?: unknown;
            };
            const choice = data.choices?.[0];
            return {
                ok: true,
                status: response.status,
                content: messageText(choice?.message),
                exhausted: exhaustedByReasoning(choice, data.usage, adapter),
            };
        },
    };
};

const PROVIDER_LABELS: Record<string, string> = { gemini: 'Google Gemini (iOS)' };

/**
 * A theme for the lyrics, asked of the provider in the iOS settings with the key in the Keychain.
 * Fails with "AI API key is not configured" when there is no key for the saved connection, which
 * the theme controller reads as "no key" (aiText.isMissingAiApiKeyError).
 */
export const generateDeviceTheme = async (
    config: DeviceAiConfig,
    lyricsText: string,
    options?: { isPureMusic?: boolean; songTitle?: string },
): Promise<DualTheme> => {
    const apiKey = await readDeviceAiKey(config);
    if (!apiKey) throw new Error('AI API key is not configured');
    const ask = prepareAsk({
        task: 'theme',
        config,
        apiKey,
        systemPrompt: buildThemeSystemPrompt(),
        sourcePrompt: buildThemeSourcePrompt(lyricsText.slice(0, THEME_SOURCE_MAX_CHARS), Boolean(options?.isPureMusic), options?.songTitle),
        answerTokens: THEME_MAX_OUTPUT_TOKENS,
        timeoutMs: THEME_TIMEOUT_MS,
    });
    const startedAt = Date.now();
    const content = await runAttempts({
        adapter: ask.adapter,
        task: 'theme',
        url: ask.url,
        model: ask.model,
        attempts: ask.adapter.attempts('theme', ask.model),
        send: ask.send,
        log: (line: string) => console.info(line),
        describeEmpty: (result: SendResult) => (result.exhausted
            ? `Model "${ask.model}" used its entire output budget on reasoning and returned no theme.`
            : 'Failed to generate theme JSON'),
    });
    let json = content.trim();
    if (json.startsWith('```')) {
        json = json.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
    }
    const theme = JSON.parse(json) as Partial<DualTheme>;
    const provider = PROVIDER_LABELS[ask.adapter.id] ?? `${ask.adapter.label} (iOS)`;
    // The answer is checked by sanitizeDualTheme afterwards; a mode it left out is not filled in here.
    for (const mode of [theme.light, theme.dark]) {
        if (mode && typeof mode === 'object') {
            mode.provider = provider;
            mode.fontStyle = 'sans';
        }
    }
    console.info(`[deviceAi] theme from ${ask.adapter.id} ${ask.model} in ${Date.now() - startedAt} ms`);
    return theme as DualTheme;
};

/**
 * The settings form's connection test with the values on screen: one "hello". An empty typed key
 * tests the key saved for this connection.
 */
export const testDeviceAiConnection = async (config: DeviceAiConfig, typedKey: string): Promise<AiConnectionTestResult> => {
    const startedAt = Date.now();
    const apiKey = typedKey.trim() || await readDeviceAiKey(config);
    if (!apiKey) {
        return { ok: false, durationMs: 0, errorKind: 'config', error: 'AI API key is not configured' };
    }
    try {
        const ask = prepareAsk({ task: 'test', config, apiKey, sourcePrompt: TEST_PROMPT, answerTokens: TEST_MAX_TOKENS, timeoutMs: TEST_TIMEOUT_MS });
        const { result } = await walkAttempts({
            adapter: ask.adapter,
            task: 'test',
            url: ask.url,
            model: ask.model,
            attempts: ask.adapter.attempts('test', ask.model),
            send: ask.send,
            cache: null,
        }) as { result: SendResult };
        const durationMs = Date.now() - startedAt;
        if (!result.ok) {
            return { ok: false, status: result.status, durationMs, errorKind: 'http', error: result.errorText };
        }
        const text = (result.content ?? '').slice(0, TEST_MAX_REPLY_CHARS);
        return {
            ok: true,
            status: result.status,
            durationMs,
            model: ask.model,
            text,
            ...(text ? {} : { emptyReason: result.exhausted ? 'reasoning' as const : 'empty' as const }),
        };
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return {
            ok: false,
            durationMs: Date.now() - startedAt,
            errorKind: timedOut ? 'timeout' : 'network',
            error: error instanceof Error ? error.message : String(error),
        };
    }
};
