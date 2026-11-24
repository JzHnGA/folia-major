import React, { useState } from 'react';
import { PictureGrid } from '../../src/components/modal/settings/kit/PictureGrid';
import { SettingsKitThemeContext, settingsTokens } from '../../src/components/modal/settings/kit/kitTheme';
import { kitMotionTokens } from '../../src/components/modal/settings/kit/motion';
import { DEFAULT_THEME, DAYLIGHT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';
// dev/probes/pictureGridScrollHint.probe.tsx

/**
 * 横向一行的 PictureGrid（手机宽度下的歌词样式“Styles”一行）右端的箭头。
 *
 * 右边还有图时箭头出现并左右轻推，滚到头就隐去；点它向右滚大约一屏。
 * 两种主题、手机宽度（375px）各挂一份。
 */
const OPTIONS = ['Hanabi', 'Machi', 'Nebbia', 'Tempera', 'Monet', 'Classic', 'Partita', 'Cadenza'].map(name => ({ value: name, label: name }));
const HUES = [10, 200, 40, 280, 140, 330, 90, 240];

const drawPicture = (value: string) => {
    const hue = HUES[OPTIONS.findIndex(option => option.value === value)] ?? 0;
    return <span className="block h-full w-full" style={{ background: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${hue + 40} 60% 25%))` }} />;
};

const Row: React.FC<{ isDaylight: boolean }> = ({ isDaylight }) => {
    const [value, setValue] = useState('Nebbia');
    const theme = isDaylight ? DAYLIGHT_THEME : DEFAULT_THEME;
    return (
        <div
            data-probe-daylight={String(isDaylight)}
            className="st-window w-[375px] rounded-2xl bg-[var(--st-win)] p-4 text-[color:var(--st-t1)]"
            style={{ ...settingsTokens(isDaylight, theme), ...kitMotionTokens(false) }}
        >
            <SettingsKitThemeContext.Provider value={{ isDaylight, theme }}>
                <h3 className="mb-2 px-1 text-[13px] font-semibold text-[color:var(--st-t2)]">Styles {OPTIONS.length}</h3>
                <PictureGrid value={value} options={OPTIONS} picture={drawPicture} columns={2} onChange={setValue} label="Styles" horizontal />
            </SettingsKitThemeContext.Provider>
        </div>
    );
};

const PictureGridScrollHintProbe: React.FC = () => (
    <div className="flex flex-col gap-6 p-8">
        <Row isDaylight={false} />
        <Row isDaylight />
    </div>
);

const probe: ProbeDefinition = {
    id: 'pictureGridScrollHint',
    title: '横向 PictureGrid / 右端箭头',
    description: '手机宽度下横向一行的图片选择：右边还有图时出现轻推的箭头，滚到头隐去，点击向右滚一屏；两种主题。',
    Component: PictureGridScrollHintProbe,
};

export default probe;
