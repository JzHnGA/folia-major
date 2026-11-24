import { afterEach, describe, expect, it } from 'vitest';
import { watchWallStoresForPreview } from '../../../src/components/modal/settings/useAutoWallPreview';
import { useLibraryWallLookStore } from '../../../src/stores/useLibraryWallLookStore';
import { selectSettingsCoversApp, useSettingsModalStore } from '../../../src/stores/useSettingsModalStore';

// test/unit/settings/settingsPreviewSplit.test.ts
// The phone's settings preview: the window lowered so the app above it shows. A change to how the
// wall looks turns it on by itself, closing the window turns it off, and while it is on the window
// no longer counts as covering the app.

const settings = () => useSettingsModalStore.getState();

afterEach(() => {
    settings().closeSettings();
});

describe('settings preview split', () => {
    it('lowers the open window when a wall setting changes', () => {
        settings().openSettings('home');
        const stop = watchWallStoresForPreview();
        const wall = useLibraryWallLookStore.getState();
        wall.setCollectionStackEdges(!wall.collectionStackEdges);
        stop();

        expect(settings().isSettingsPreviewSplit).toBe(true);
        expect(selectSettingsCoversApp(settings())).toBe(false);
    });

    it('leaves a closed window alone', () => {
        const stop = watchWallStoresForPreview();
        const wall = useLibraryWallLookStore.getState();
        wall.setCollectionStackEdges(!wall.collectionStackEdges);
        stop();

        expect(settings().isSettingsPreviewSplit).toBe(false);
    });

    it('stops watching once told to', () => {
        settings().openSettings('home');
        watchWallStoresForPreview()();
        const wall = useLibraryWallLookStore.getState();
        wall.setCollectionStackEdges(!wall.collectionStackEdges);

        expect(settings().isSettingsPreviewSplit).toBe(false);
        expect(selectSettingsCoversApp(settings())).toBe(true);
    });

    it('ends the preview when the window closes', () => {
        settings().openSettings('home');
        settings().setIsSettingsPreviewSplit(true);
        settings().closeSettings();

        expect(settings().isSettingsPreviewSplit).toBe(false);
    });
});
