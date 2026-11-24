import React, { createContext, useContext, useMemo } from 'react';

// src/components/modal/settings/kit/device.ts
// The settings kit's view of the machine it is drawn on: the phone shell hides rows marked mobileHidden.
// The settings dialog provides it; kit components and pages read it. A page rendered outside the
// dialog (a probe, a test) gets the desktop default and draws everything.

type SettingsDevice = { isMobile: boolean };

const SettingsDeviceContext = createContext<SettingsDevice>({ isMobile: false });

export const useSettingsDevice = (): SettingsDevice => useContext(SettingsDeviceContext);

export const SettingsDeviceProvider: React.FC<{ isMobile: boolean; children: React.ReactNode }> = ({ isMobile, children }) => {
    const value = useMemo(() => ({ isMobile }), [isMobile]);
    return <SettingsDeviceContext.Provider value={value}>{children}</SettingsDeviceContext.Provider>;
};
