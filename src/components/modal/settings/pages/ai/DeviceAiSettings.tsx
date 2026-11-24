import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { canRunAiConnectionTest, modelAlwaysThinks, retiredModelHint, runDeviceAiConnectionTest } from '../../../../../services/aiText';
import {
    DEVICE_AI_PRESETS,
    hasUsableDeviceAiKey,
    isDeviceAiHost,
    resolveDeviceAiConnection,
    useDeviceAiSettingsStore,
    type DeviceAiConfig,
} from '../../../../../services/deviceAi/deviceAiSettings';
import { AI_PROVIDER_PRESETS } from '../../../../../services/aiText';
import { Button, Group, NumberField, Reveal, Row, Select, TextField, Value, option, parseNumberText, type SettingsGroupDef, type SettingsOptionDef } from '../../kit';
import { AiConnectionTestReply, AiConnectionTestStatus } from '../AiConnectionTest';
import { AiKeyField } from './AiProviderSettings';

// src/components/modal/settings/pages/ai/DeviceAiSettings.tsx
// The iOS app's AI connection: provider, site, key, model and temperature, kept on this phone (the
// key in the Keychain) and used for song themes. Saved with its own button, like the desktop form;
// the connection test sends the values on screen.

const AI: SettingsGroupDef = { id: 'deviceAiSettings', titleKey: 'options.deviceAiSettings', available: isDeviceAiHost };
const O = {
    provider: option(AI, 'deviceAiProvider', 'options.aiProvider'),
    endpoint: option(AI, 'deviceAiEndpoint', 'options.aiEndpoint'),
    url: option(AI, 'deviceAiApiUrl', 'options.aiApiUrl'),
    key: option(AI, 'deviceAiApiKey', 'options.aiApiKey'),
    model: option(AI, 'deviceAiModel', 'options.aiModel'),
    temperature: option(AI, 'deviceAiTemperature', 'options.openaiApiTemperature'),
};
export const DEVICE_AI_SETTINGS_OPTIONS: SettingsOptionDef[] = Object.values(O);

/** Origin and path of an address, without a trailing slash: what tells two spellings of one site apart. */
const siteKeyOf = (url: string) => {
    try {
        const parsed = new URL(url.trim());
        return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
    } catch {
        return url.trim();
    }
};

const DeviceAiSettings: React.FC = () => {
    const { t } = useTranslation();
    const { config, saved, keysLoaded, loadKeys, save, clearKey } = useDeviceAiSettingsStore(useShallow(state => ({
        config: state.config,
        saved: state.saved,
        keysLoaded: state.keysLoaded,
        loadKeys: state.loadKeys,
        save: state.save,
        clearKey: state.clearKey,
    })));
    const [draft, setDraft] = useState<DeviceAiConfig>(config);
    const [typedKey, setTypedKey] = useState('');
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
    const [testRunning, setTestRunning] = useState(false);
    const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);
    const host = isDeviceAiHost();

    useEffect(() => {
        if (!keysLoaded) void loadKeys();
    }, [keysLoaded, loadKeys]);

    // Any edit makes an earlier test result or "saved" mark misleading. Saving itself empties the
    // key field; that one change is not an edit.
    const justSavedRef = useRef(false);
    useEffect(() => {
        setTestResult(null);
        if (justSavedRef.current) {
            justSavedRef.current = false;
            return;
        }
        setSaveStatus(status => (status === 'saving' ? status : 'idle'));
    }, [draft, typedKey]);

    const connection = resolveDeviceAiConnection(draft);
    const gemini = draft.AI_PROVIDER === 'gemini';
    // Custom is always in the list, and is what an address no preset claims resolves to.
    const preset = DEVICE_AI_PRESETS.find(value => value.id === connection.presetId)
        ?? DEVICE_AI_PRESETS[DEVICE_AI_PRESETS.length - 1];
    const adapter = AI_PROVIDER_PRESETS.find(value => value.id === connection.adapterId) ?? preset;
    const keySaved = hasUsableDeviceAiKey(draft, saved);
    const sites = gemini || preset.id === 'custom' ? [] : preset.endpoints;
    const site = sites.find(endpoint => siteKeyOf(endpoint.baseUrl) === siteKeyOf(draft.OPENAI_API_URL));
    const ready = Boolean(connection.model) && (preset.id !== 'custom' || Boolean(draft.OPENAI_API_URL.trim()));
    const retired = retiredModelHint(connection.adapterId, connection.model);
    const alwaysThinks = modelAlwaysThinks(connection.adapterId, connection.model);
    const temperature = adapter.temperature;
    const modelField = gemini ? 'GEMINI_API_MODEL' : 'OPENAI_API_MODEL';

    const providerOptions = useMemo(() => DEVICE_AI_PRESETS.map(value => ({ value: value.id, label: t('options.aiProvider_' + value.id) })), [t]);

    const selectProvider = (id: string) => {
        const next = DEVICE_AI_PRESETS.find(value => value.id === id);
        if (!next || next.id === preset.id) return;
        setTypedKey('');
        setDraft(previous => ({
            ...previous,
            AI_PROVIDER_PRESET: id,
            AI_PROVIDER: next.protocol === 'gemini' ? 'gemini' : 'openai',
            ...(next.protocol !== 'gemini' ? {
                // Custom keeps the address in use, so it can be edited rather than typed again.
                OPENAI_API_URL: next.id === 'custom' && !gemini ? previous.OPENAI_API_URL : next.baseUrl,
                OPENAI_API_MODEL: next.recommendedModel ?? '',
            } : {}),
        }));
    };

    const onSave = async () => {
        setSaveStatus('saving');
        try {
            await save(draft, typedKey);
            justSavedRef.current = typedKey !== '';
            setTypedKey('');
            setSaveStatus('saved');
        } catch (error) {
            console.warn('[deviceAi] saving the AI connection failed', error);
            setSaveStatus('failed');
        }
    };

    const onTest = async () => {
        if (testRunning || !canRunAiConnectionTest()) return;
        setTestRunning(true);
        setTestResult(null);
        const result = await runDeviceAiConnectionTest(draft, typedKey);
        setTestResult(result);
        setTestRunning(false);
    };

    return (
        <Group def={AI}>
            {!host && <Row notice={t('options.deviceAiUnavailable')} />}
            <Row option={O.provider} hint={t('options.deviceAiKeychainDesc')}>
                <Select value={preset.id} options={providerOptions} onChange={selectProvider} />
            </Row>
            {sites.length > 1 && (
                <Row option={O.endpoint}>
                    <Select
                        value={site?.id ?? ''}
                        options={[
                            ...(site ? [] : [{ value: '', label: draft.OPENAI_API_URL }]),
                            ...sites.map(endpoint => ({ value: endpoint.id, label: t('options.aiEndpoint_' + endpoint.id) })),
                        ]}
                        onChange={id => {
                            const next = sites.find(endpoint => endpoint.id === id);
                            if (next) setDraft(previous => ({ ...previous, OPENAI_API_URL: next.baseUrl }));
                        }}
                    />
                </Row>
            )}
            {preset.id === 'custom' && (
                <Row option={O.url}>
                    <TextField value={draft.OPENAI_API_URL} onChange={value => setDraft(previous => ({ ...previous, OPENAI_API_URL: value }))} placeholder={preset.baseUrl} />
                </Row>
            )}
            <Row option={gemini ? { ...O.key, labelKey: 'options.geminiApiKey' } : O.key} hint={keySaved && !typedKey ? t('options.aiApiKeySavedDesc') : undefined}>
                <AiKeyField
                    value={typedKey}
                    saved={keySaved}
                    onChange={setTypedKey}
                    onClear={() => void clearKey(gemini ? 'gemini' : 'openai')}
                />
            </Row>
            <Row option={O.model}>
                <TextField
                    value={draft[modelField]}
                    onChange={value => setDraft(previous => ({ ...previous, [modelField]: value }))}
                    placeholder={connection.model || preset.recommendedModel || ''}
                />
            </Row>
            {retired && <Row notice={t('options.aiModelRetired', { model: retired.model, replacement: retired.replacement })} />}
            {alwaysThinks && <Row notice={t('options.aiModelAlwaysThinks')} />}
            <Reveal when={!gemini && Boolean(temperature)}>
                <Row option={O.temperature} note={t('options.aiTemperatureNote')} hint={temperature ? t(adapter.temperaturePerModel ? 'options.aiTemperaturePerModelDesc' : 'options.aiTemperatureRangeDesc', temperature) : undefined}>
                    <NumberField
                        value={parseNumberText(draft.OPENAI_API_TEMPERATURE)}
                        onChange={value => setDraft(previous => ({ ...previous, OPENAI_API_TEMPERATURE: value === null ? '' : String(value) }))}
                        min={temperature?.min ?? 0}
                        max={temperature?.max ?? 2}
                        step={0.1}
                        placeholder="0.7"
                    />
                </Row>
            </Reveal>
            <Row
                label={testResult && <AiConnectionTestStatus result={testResult} />}
                below={testResult && <AiConnectionTestReply result={testResult} />}
            >
                {saveStatus === 'saved' && <Value>{t('options.settingsSaved')}</Value>}
                {saveStatus === 'failed' && <Value>{t('options.deviceAiSaveFailed')}</Value>}
                <Button icon={Zap} tip={t('options.aiTestConnectionDesc')} onClick={() => void onTest()} disabled={!host || testRunning || !ready || !(keySaved || typedKey.trim())}>
                    {t(testRunning ? 'options.aiTestRunning' : 'options.aiTestConnection')}
                </Button>
                <Button variant="primary" onClick={() => void onSave()} disabled={!host || saveStatus === 'saving' || !ready}>
                    {t(saveStatus === 'saving' ? 'options.settingsSaving' : 'options.save')}
                </Button>
            </Row>
        </Group>
    );
};

export default DeviceAiSettings;
