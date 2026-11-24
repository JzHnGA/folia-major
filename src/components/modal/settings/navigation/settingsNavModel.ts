import { Boxes, Contrast, Database, Gauge, Keyboard, LayoutGrid, Link2, Monitor, MonitorPlay, PlayCircle, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, TextAlignStart, type LucideIcon } from 'lucide-react';
// src/components/modal/settings/navigation/settingsNavModel.ts
// Single source of truth for the settings categories: their order in the side list, their grouping,
// icons and names. A category is cut by what the listener is looking at or doing, so each page holds
// one subject; which page an option is on is settingsAnchorModel's and the page files' to say.

export type SettingsSectionId =
    | 'appearance'
    | 'player'
    | 'home'
    | 'graphics'
    | 'playback'
    | 'lyrics'
    | 'general'
    | 'interaction'
    | 'integration'
    | 'ai'
    | 'storage'
    | 'account'
    | 'desktop'
    | 'mods'
    | 'developer';

export interface SettingsNavItem {
    id: SettingsSectionId;
    icon: LucideIcon;
    label: string;
}

export interface SettingsNavGroup {
    id: string;
    label: string;
    items: SettingsNavItem[];
}

type Translate = (key: string) => string;

interface SectionSpec {
    id: SettingsSectionId;
    icon: LucideIcon;
    labelKey: string;
    /** Sections that only exist on the desktop build. */
    electronOnly?: boolean;
    /** Sections the phone shell hides: they hold desktop- or keyboard-centred options. */
    mobileHidden?: boolean;
    /** Sections only the desktop and iOS apps have: the web build keeps such things on its server. */
    appOnly?: boolean;
}

interface GroupSpec {
    id: string;
    labelKey: string;
    sections: SectionSpec[];
}

export const SETTINGS_NAV_GROUP_SPECS: GroupSpec[] = [
    {
        id: 'interface',
        labelKey: 'options.settingsGroupInterface',
        sections: [
            { id: 'appearance', icon: Contrast, labelKey: 'options.settingsPageAppearance' },
            { id: 'player', icon: MonitorPlay, labelKey: 'options.settingsPagePlayer' },
            { id: 'home', icon: LayoutGrid, labelKey: 'options.settingsPageHome' },
            { id: 'graphics', icon: Gauge, labelKey: 'options.settingsPageGraphics', mobileHidden: true },
        ],
    },
    {
        id: 'music',
        labelKey: 'options.settingsGroupMusic',
        sections: [
            { id: 'playback', icon: PlayCircle, labelKey: 'options.settingsPagePlayback' },
            { id: 'lyrics', icon: TextAlignStart, labelKey: 'options.settingsPageLyrics' },
        ],
    },
    {
        id: 'app',
        labelKey: 'options.settingsGroupApp',
        sections: [
            { id: 'general', icon: SlidersHorizontal, labelKey: 'options.settingsPageGeneral' },
            { id: 'interaction', icon: Keyboard, labelKey: 'options.settingsPageInteraction', mobileHidden: true },
            { id: 'integration', icon: Link2, labelKey: 'options.settingsPageIntegration', mobileHidden: true },
            // The web build's AI key is the deployment's, set on its server.
            { id: 'ai', icon: Sparkles, labelKey: 'options.settingsPageAi', appOnly: true },
            { id: 'storage', icon: Database, labelKey: 'options.settingsPageStorage' },
            { id: 'account', icon: ShieldCheck, labelKey: 'options.settingsPageAccount' },
            { id: 'desktop', icon: Monitor, labelKey: 'options.settingsPageDesktop', electronOnly: true },
        ],
    },
    {
        id: 'advanced',
        labelKey: 'options.settingsGroupAdvanced',
        sections: [
            // The loader only exists in the desktop main process; on web there is nothing to switch on.
            { id: 'mods', icon: Boxes, labelKey: 'options.settingsPageMods', electronOnly: true },
            { id: 'developer', icon: Terminal, labelKey: 'options.settingsPageDeveloper', mobileHidden: true },
        ],
    },
];

/** Whether a section is shown on this runtime: the desktop app, the phone shell, or a browser. */
export const isSettingsSectionShown = (
    section: Pick<SectionSpec, 'electronOnly' | 'mobileHidden' | 'appOnly'>,
    { isElectron, mobile }: { isElectron: boolean; mobile?: boolean },
): boolean => (!section.electronOnly || isElectron)
    && (!section.mobileHidden || !mobile)
    && (!section.appOnly || isElectron || Boolean(mobile));

/** Resolves the grouping into translated nav items, dropping sections this runtime hides (and groups left empty). */
export const buildSettingsNavGroups = (t: Translate, options: { isElectron: boolean; mobile?: boolean }): SettingsNavGroup[] => (
    SETTINGS_NAV_GROUP_SPECS
        .map(group => ({
            id: group.id,
            label: t(group.labelKey),
            items: group.sections
                .filter(section => isSettingsSectionShown(section, options))
                .map(section => ({
                    id: section.id,
                    icon: section.icon,
                    label: t(section.labelKey),
                })),
        }))
        .filter(group => group.items.length > 0)
);

export const flattenSettingsNavItems = (groups: SettingsNavGroup[]): SettingsNavItem[] => (
    groups.flatMap(group => group.items)
);

export const findSettingsNavItem = (groups: SettingsNavGroup[], id: SettingsSectionId): SettingsNavItem | undefined => (
    flattenSettingsNavItems(groups).find(item => item.id === id)
);
