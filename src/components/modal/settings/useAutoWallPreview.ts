import { useEffect } from 'react';
import { useGridViewSettingsStore } from '../../../stores/useGridViewSettingsStore';
import { useHomeLayoutSettingsStore } from '../../../stores/useHomeLayoutSettingsStore';
import { useLibraryWallLookStore } from '../../../stores/useLibraryWallLookStore';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';

// src/components/modal/settings/useAutoWallPreview.ts
// On a phone the settings window covers the home wall, so a change to how the wall looks could not
// be seen. While the window is open there, a change to one of the stores the wall is drawn from
// lowers the window into its preview, as the eye button in the page header does by hand.

/** The stores the home wall's look is drawn from. */
const WALL_STORES = [useLibraryWallLookStore, useGridViewSettingsStore, useHomeLayoutSettingsStore] as const;

/**
 * Lowers an open settings window into its preview when one of the wall's stores changes. Returns
 * the function that stops watching.
 */
export const watchWallStoresForPreview = (): (() => void) => {
    const unsubscribes = WALL_STORES.map(store => store.subscribe((next, previous) => {
        if (next === previous) return;
        const settings = useSettingsModalStore.getState();
        if (settings.settingsModalState.isOpen && !settings.isSettingsPreviewSplit) {
            console.info('[settings] a wall setting changed; showing the preview');
            settings.setIsSettingsPreviewSplit(true);
        }
    }));
    return () => unsubscribes.forEach(unsubscribe => unsubscribe());
};

export const useAutoWallPreview = (enabled: boolean) => {
    useEffect(() => (enabled ? watchWallStoresForPreview() : undefined), [enabled]);
};
