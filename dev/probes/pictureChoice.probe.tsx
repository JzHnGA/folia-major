import React, { useState } from 'react';
import { PictureChoice } from '../../src/components/modal/settings/kit/PictureChoice';
import { settingsTokens } from '../../src/components/modal/settings/kit/kitTheme';
import { EntryViewPicture } from '../../src/components/modal/settings/pages/pictures';
import type { ProbeDefinition } from './definition';

// dev/probes/pictureChoice.probe.tsx
// 设置页「播放后进入的视图」的三张卡片：在手机设置栏的窄宽度里必须排成一行。

const PictureChoiceProbe: React.FC = () => {
    const [value, setValue] = useState<'player' | 'lattice' | 'stay'>('player');
    return (
        <div
            className="w-[343px] max-w-full p-4"
            data-probe-picture-choice
            style={{ ...settingsTokens(false), '--text-primary': '#f4f4f5' } as React.CSSProperties}
        >
            <PictureChoice
                columns={3}
                value={value}
                onChange={setValue}
                options={[
                    { value: 'player', label: 'Visualizer', picture: <EntryViewPicture view="player" /> },
                    { value: 'lattice', label: 'Lattice (queue collage)', picture: <EntryViewPicture view="lattice" /> },
                    { value: 'stay', label: 'Stay here', picture: <EntryViewPicture view="stay" /> },
                ]}
            />
        </div>
    );
};

const probe: ProbeDefinition = {
    id: 'pictureChoice',
    title: 'Picture choice',
    description: 'Three picture choices in a narrow settings column: one row, no wrapped third card.',
    Component: PictureChoiceProbe,
};

export default probe;
