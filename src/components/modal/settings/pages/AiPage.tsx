import React from 'react';
import type { SettingsOptionDef } from '../kit';
import AiProviderSettings, { AI_SETTINGS_OPTIONS } from './ai/AiProviderSettings';
import DeviceAiSettings, { DEVICE_AI_SETTINGS_OPTIONS } from './ai/DeviceAiSettings';
import { useSettingsPage } from './settingsPageContext';

// src/components/modal/settings/pages/AiPage.tsx
// The AI page: which provider, key and model make the songs' themes. The desktop app's connection
// lives in its main process; the iOS app keeps its own on the phone. The web build has no page: its
// key is the deployment's.

export const OPTIONS: SettingsOptionDef[] = [...AI_SETTINGS_OPTIONS, ...DEVICE_AI_SETTINGS_OPTIONS];

const AiPage: React.FC = () => {
    const { isElectron } = useSettingsPage();
    return isElectron ? <AiProviderSettings /> : <DeviceAiSettings />;
};

export default AiPage;
