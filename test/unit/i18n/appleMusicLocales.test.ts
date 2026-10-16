import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import ind from '../../../src/i18n/locales/in';
import zhCN from '../../../src/i18n/locales/zh-CN';

// test/unit/i18n/appleMusicLocales.test.ts
// The appleMusic section must define the same keys in every locale, each with real text.

const keys = [
    'permissionDenied',
    'takeover',
    'engineStopped',
    'playFailed',
    'exportUnsupported',
    'audioSettingsHint',
    'spectrumCapture',
    'spectrumCaptureHint',
    'spectrumCaptureDenied',
] as const;

describe('appleMusic translations', () => {
    it.each([
        ['zh-CN', zhCN],
        ['en', en],
        ['in', ind],
    ])('%s defines exactly the appleMusic keys', (_locale, locale) => {
        expect(Object.keys(locale.appleMusic).sort()).toEqual([...keys].sort());
        for (const key of keys) expect(locale.appleMusic[key].trim()).not.toBe('');
    });
});
