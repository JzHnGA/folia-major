import React from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Check, ListMusic, Pause, Play, Search, SkipBack, SkipForward } from 'lucide-react';

// src/components/mobile-tutorial/TutorialDemos.tsx
// 新手教程说明卡顶部的示范小动画：每一步一段循环的微缩画面（手指点、划、拖，画面跟着变），只是画，不接触摸。
// 颜色跟教程卡片：线条与底板用 currentColor 的不同浓度，强调色给手指和「正在发生」的那一下。
// 系统要求减少动态效果时不循环，停在能说明这一步的那一帧。

export type TutorialDemoId =
    | 'welcome'
    | 'search'
    | 'wallPlay'
    | 'barTap'
    | 'barSwipe'
    | 'barExpand'
    | 'widgets'
    | 'finish';

/** 示范画面里的样例文字（歌名、歌词、搜索词），走 i18n，跟着界面语言。 */
type DemoText = { song: string; nextSong: string; artist: string; query: string; lyrics: [string, string, string] };

type DemoProps = { accent: string; reduced: boolean; text: DemoText };

/** 一段循环的时长与时刻；减少动态效果时直接落到最后一帧，不循环。 */
const loop = (reduced: boolean, duration: number, times: number[]): Transition => (reduced
    ? { duration: 0 }
    : { duration, times, repeat: Infinity, ease: 'easeInOut' });

const tint = (percent: number) => `color-mix(in srgb, currentColor ${percent}%, transparent)`;

/** 手指：一个强调色的圆点，按下时缩一下、外面一圈涟漪。x / y 是关键帧（像素，相对舞台左上）。 */
const Finger: React.FC<{
    accent: string;
    reduced: boolean;
    duration: number;
    times: number[];
    x: number[];
    y: number[];
    /** 每个时刻按没按着（1 按着，0 悬着），按着时圆点缩小、涟漪扩开。 */
    press: number[];
    opacity?: number[];
}> = ({ accent, reduced, duration, times, x, y, press, opacity }) => {
    const transition = loop(reduced, duration, times);
    return (
        <motion.div
            className="pointer-events-none absolute left-0 top-0 h-0 w-0"
            initial={false}
            animate={{ x, y, opacity: opacity ?? times.map(() => 1) }}
            transition={transition}
        >
            <motion.span
                className="absolute -left-5 -top-5 h-10 w-10 rounded-full"
                style={{ border: `2px solid ${accent}` }}
                initial={false}
                animate={{ scale: press.map(value => (value ? 1.5 : 0.6)), opacity: press.map(value => (value ? 0 : 0.5)) }}
                transition={transition}
            />
            <motion.span
                className="absolute -left-3 -top-3 h-6 w-6 rounded-full shadow-lg"
                style={{ backgroundColor: accent, boxShadow: `0 0 18px ${accent}` }}
                initial={false}
                animate={{ scale: press.map(value => (value ? 0.78 : 1)) }}
                transition={transition}
            />
        </motion.div>
    );
};

/** 微缩的胶囊（底部播放条）：封面、歌名、进度。 */
const MiniCapsule: React.FC<{ title: React.ReactNode; className?: string; style?: React.CSSProperties }> = ({ title, className, style }) => (
    <div
        className={`flex h-9 items-center gap-2 overflow-hidden rounded-full px-1.5 ${className ?? ''}`}
        style={{ backgroundColor: tint(14), border: `1px solid ${tint(18)}`, ...style }}
    >
        <span className="h-6 w-6 shrink-0 rounded-full" style={{ background: 'linear-gradient(135deg,#f97316,#db2777)' }} />
        <div className="relative min-w-0 flex-1 overflow-hidden text-[11px] font-semibold leading-none">{title}</div>
        <Pause size={13} className="mr-1.5 shrink-0" aria-hidden="true" />
    </div>
);

const COVERS = ['#f97316', '#0ea5e9', '#a855f7', '#22c55e', '#eab308', '#ec4899', '#14b8a6', '#6366f1'];

// —— 欢迎：封面一张张亮起拼成墙，中间那张开始放，歌词浮出 ——
const WelcomeDemo: React.FC<DemoProps> = ({ accent, reduced }) => {
    const transition = (index: number) => (reduced ? { duration: 0 } : {
        duration: 4.8, times: [0, 0.08 + index * 0.04, 0.2 + index * 0.04, 0.86, 1], repeat: Infinity, ease: 'easeOut' as const,
    });
    return (
        <div className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-1.5 p-3">
            {COVERS.map((color, index) => (
                <motion.span
                    key={color}
                    className="relative grid place-items-center rounded-lg"
                    style={{ background: `linear-gradient(140deg, ${color}, color-mix(in srgb, ${color} 40%, #111))` }}
                    initial={false}
                    animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.7, 0.7, 1, 1, 0.94], y: [8, 8, 0, 0, 0] }}
                    transition={transition(index)}
                >
                    {index === 2 && (
                        <motion.span
                            className="grid h-6 w-6 place-items-center rounded-full bg-white/90 text-black"
                            initial={false}
                            animate={{ scale: [0, 0, 0, 1, 1, 0] }}
                            transition={loop(reduced, 4.8, [0, 0.3, 0.45, 0.52, 0.86, 1])}
                        >
                            <Pause size={12} aria-hidden="true" />
                        </motion.span>
                    )}
                </motion.span>
            ))}
            <motion.div
                className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-sm font-bold tracking-wide"
                style={{ color: accent, textShadow: '0 1px 12px rgba(0,0,0,0.6)' }}
                initial={false}
                animate={{ opacity: [0, 0, 1, 1, 0], y: [6, 6, 0, 0, -4] }}
                transition={loop(reduced, 4.8, [0, 0.5, 0.6, 0.86, 1])}
            >
                ♪ ♫ ♪
            </motion.div>
        </div>
    );
};

// —— 搜索：点搜索框，字一个个打出来，结果一行行滑进来 ——
const SearchDemo: React.FC<DemoProps> = ({ accent, reduced, text }) => {
    const T = [0, 0.12, 0.2, 0.45, 0.55, 0.85, 1];
    return (
        <div className="absolute inset-0 flex flex-col gap-2 p-3">
            <div className="flex h-8 items-center gap-2 rounded-full px-3 text-xs" style={{ backgroundColor: tint(12), border: `1px solid ${tint(18)}` }}>
                <Search size={13} aria-hidden="true" className="opacity-60" />
                <div className="relative overflow-hidden whitespace-nowrap font-medium">
                    <motion.span
                        className="block overflow-hidden"
                        initial={false}
                        animate={{ width: ['0%', '0%', '0%', '100%', '100%', '100%', '0%'] }}
                        transition={loop(reduced, 4.4, T)}
                    >
                        {text.query}
                    </motion.span>
                </div>
                <motion.span
                    className="h-3.5 w-px"
                    style={{ backgroundColor: accent }}
                    initial={false}
                    animate={{ opacity: [0, 0, 1, 1, 1, 1, 0] }}
                    transition={loop(reduced, 4.4, T)}
                />
            </div>
            {[0, 1, 2].map(row => (
                <motion.div
                    key={row}
                    className="flex items-center gap-2 rounded-xl px-2 py-1"
                    style={{ backgroundColor: row === 0 ? `color-mix(in srgb, ${accent} 18%, transparent)` : tint(6) }}
                    initial={false}
                    animate={{ opacity: [0, 0, 0, 0, 1, 1, 0], x: [16, 16, 16, 16, 0, 0, 0] }}
                    transition={reduced ? { duration: 0 } : { duration: 4.4, times: [0, 0.12, 0.2, 0.45 + row * 0.04, 0.55 + row * 0.04, 0.85, 1], repeat: Infinity, ease: 'easeOut' }}
                >
                    <span className="h-5 w-5 rounded-md" style={{ backgroundColor: COVERS[row + 3] }} />
                    <span className="h-1.5 rounded-full" style={{ width: `${54 - row * 12}%`, backgroundColor: tint(row === 0 ? 70 : 35) }} />
                </motion.div>
            ))}
            <Finger
                accent={accent}
                reduced={reduced}
                duration={4.4}
                times={T}
                x={[150, 90, 90, 90, 90, 150, 150]}
                y={[96, 28, 28, 28, 28, 96, 96]}
                press={[0, 0, 1, 0, 0, 0, 0]}
                opacity={[0, 1, 1, 0, 0, 0, 0]}
            />
        </div>
    );
};

// —— 墙上就地播放：手指点一张封面，那张卡亮起暂停标记，画面不跳走 ——
const WallPlayDemo: React.FC<DemoProps> = ({ accent, reduced }) => {
    const T = [0, 0.2, 0.3, 0.38, 0.8, 1];
    return (
        <div className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-1.5 p-3">
            {COVERS.map((color, index) => (
                <motion.span
                    key={color}
                    className="relative rounded-lg"
                    style={{ background: index === 5 ? `linear-gradient(140deg, ${color}, #111)` : tint(14) }}
                    initial={false}
                    animate={index === 5 ? { scale: [1, 1, 0.92, 1.06, 1.06, 1], boxShadow: ['0 0 0 0 transparent', '0 0 0 0 transparent', '0 0 0 0 transparent', `0 0 0 2px ${accent}`, `0 0 0 2px ${accent}`, '0 0 0 0 transparent'] } : {}}
                    transition={loop(reduced, 4, T)}
                >
                    {index === 5 && (
                        <motion.span
                            className="absolute bottom-1 right-1 flex gap-px"
                            initial={false}
                            animate={{ opacity: [0, 0, 0, 1, 1, 0] }}
                            transition={loop(reduced, 4, T)}
                        >
                            {[0, 1, 2].map(bar => (
                                <motion.span
                                    key={bar}
                                    className="w-0.5 rounded-full bg-white"
                                    initial={false}
                                    animate={reduced ? { height: 8 } : { height: [4, 10, 5, 9, 4] }}
                                    transition={reduced ? { duration: 0 } : { duration: 0.9, repeat: Infinity, delay: bar * 0.15 }}
                                />
                            ))}
                        </motion.span>
                    )}
                </motion.span>
            ))}
            <Finger
                accent={accent}
                reduced={reduced}
                duration={4}
                times={T}
                x={[200, 112, 112, 112, 200, 200]}
                y={[120, 92, 92, 92, 120, 120]}
                press={[0, 0, 1, 0, 0, 0]}
                opacity={[0, 1, 1, 0.9, 0, 0]}
            />
        </div>
    );
};

// —— 点播放条进可视化：手指点胶囊，画面从墙换成大字歌词 ——
const BarTapDemo: React.FC<DemoProps> = ({ accent, reduced, text }) => {
    const T = [0, 0.2, 0.28, 0.4, 0.82, 0.92, 1];
    const transition = loop(reduced, 4.6, T);
    return (
        <div className="absolute inset-0">
            <motion.div
                className="absolute inset-0 grid grid-cols-4 grid-rows-2 gap-1.5 p-3 pb-14"
                initial={false}
                animate={{ opacity: [1, 1, 1, 0, 0, 1, 1] }}
                transition={transition}
            >
                {COVERS.map(color => <span key={color} className="rounded-md" style={{ backgroundColor: tint(14) }} />)}
            </motion.div>
            <motion.div
                className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 pb-10"
                initial={false}
                animate={{ opacity: [0, 0, 0, 1, 1, 0, 0], scale: [1.08, 1.08, 1.08, 1, 1, 1, 1.08] }}
                transition={transition}
            >
                {text.lyrics.map((line, index) => (
                    <span
                        key={line}
                        className={index === 1 ? 'text-lg font-black' : 'text-[11px] font-semibold opacity-40'}
                        style={index === 1 ? { color: accent } : undefined}
                    >
                        {line}
                    </span>
                ))}
            </motion.div>
            <MiniCapsule className="absolute inset-x-6 bottom-3" title={<span>{text.song}</span>} />
            <Finger
                accent={accent}
                reduced={reduced}
                duration={4.6}
                times={T}
                x={[220, 140, 140, 140, 220, 220, 220]}
                y={[140, 112, 112, 112, 140, 140, 140]}
                press={[0, 0, 1, 0, 0, 0, 0]}
                opacity={[0, 1, 1, 0, 0, 0, 0]}
            />
        </div>
    );
};

// —— 播放条左右划切歌：手指往左拖，歌名滑出、下一首滑进；再往右拖回到上一首 ——
const BarSwipeDemo: React.FC<DemoProps> = ({ accent, reduced, text }) => {
    const T = [0, 0.1, 0.3, 0.38, 0.5, 0.6, 0.8, 0.88, 1];
    const transition = loop(reduced, 5.2, T);
    return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
            <div className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider opacity-50">
                <SkipBack size={13} aria-hidden="true" />
                <SkipForward size={13} aria-hidden="true" />
            </div>
            <MiniCapsule
                className="w-full"
                title={(
                    <>
                        <motion.span
                            className="block whitespace-nowrap"
                            initial={false}
                            animate={{ x: [0, 0, -60, -60, -60, -60, 60, 60, 0], opacity: [1, 1, 0, 0, 0, 0, 0, 0, 1] }}
                            transition={transition}
                        >
                            {text.song}
                        </motion.span>
                        <motion.span
                            className="absolute inset-0 block whitespace-nowrap"
                            style={{ color: accent }}
                            initial={false}
                            animate={{ x: [60, 60, 60, 0, 0, 0, 0, 0, -60], opacity: [0, 0, 0, 1, 1, 1, 0, 0, 0] }}
                            transition={transition}
                        >
                            {text.nextSong}
                        </motion.span>
                    </>
                )}
            />
            <Finger
                accent={accent}
                reduced={reduced}
                duration={5.2}
                times={T}
                x={[250, 230, 110, 110, 110, 110, 230, 230, 250]}
                y={[90, 90, 90, 90, 90, 90, 90, 90, 90]}
                press={[0, 1, 1, 0, 0, 1, 1, 0, 0]}
                opacity={[0, 1, 1, 0, 0, 1, 1, 0, 0]}
            />
        </div>
    );
};

// —— 播放条上滑展开：手指往上推，胶囊长高，露出歌手、按钮那一排；往下推收回 ——
const BarExpandDemo: React.FC<DemoProps> = ({ accent, reduced, text }) => {
    const T = [0, 0.12, 0.3, 0.4, 0.72, 0.84, 1];
    const transition = loop(reduced, 5, T);
    return (
        <div className="absolute inset-0 flex items-end justify-center px-6 pb-3">
            <motion.div
                className="flex w-full flex-col justify-end overflow-hidden rounded-[22px] px-2 pb-1.5"
                style={{ backgroundColor: tint(14), border: `1px solid ${tint(18)}` }}
                initial={false}
                animate={{ height: [36, 36, 112, 112, 112, 36, 36] }}
                transition={transition}
            >
                <motion.div
                    className="mb-2 flex flex-col gap-2"
                    initial={false}
                    animate={{ opacity: [0, 0, 1, 1, 1, 0, 0] }}
                    transition={transition}
                >
                    <div className="flex items-center gap-2">
                        <span className="h-9 w-9 shrink-0 rounded-lg" style={{ background: 'linear-gradient(135deg,#f97316,#db2777)' }} />
                        <div className="flex flex-col gap-1">
                            <span className="text-xs font-bold leading-none">{text.song}</span>
                            <span className="text-[10px] leading-none opacity-60">{text.artist}</span>
                        </div>
                    </div>
                    <div className="flex items-center justify-around">
                        {[SkipBack, Play, SkipForward, ListMusic].map((Icon, index) => (
                            <span key={index} className="grid h-6 w-6 place-items-center rounded-full" style={index === 1 ? { backgroundColor: accent, color: '#000' } : { backgroundColor: tint(10) }}>
                                <Icon size={12} aria-hidden="true" />
                            </span>
                        ))}
                    </div>
                </motion.div>
                <div className="flex h-6 shrink-0 items-center gap-2">
                    <span className="h-1 flex-1 rounded-full" style={{ backgroundColor: tint(20) }}>
                        <span className="block h-full w-2/5 rounded-full" style={{ backgroundColor: tint(70) }} />
                    </span>
                    <Pause size={12} aria-hidden="true" />
                </div>
            </motion.div>
            <Finger
                accent={accent}
                reduced={reduced}
                duration={5}
                times={T}
                x={[150, 150, 150, 150, 150, 150, 150]}
                y={[136, 136, 70, 70, 70, 136, 136]}
                press={[0, 1, 1, 0, 1, 1, 0]}
                opacity={[0, 1, 1, 0, 1, 1, 0]}
            />
        </div>
    );
};

// —— 床头钟小组件：横着的屏幕上三张卡在编辑态里抖，一张被拖到另一张的位置，两张换位 ——
const WidgetsDemo: React.FC<DemoProps> = ({ accent, reduced }) => {
    const T = [0, 0.15, 0.25, 0.5, 0.6, 0.85, 1];
    const transition = loop(reduced, 5, T);
    const jiggle = reduced ? {} : { rotate: [-1.2, 1.2, -1.2] };
    const jiggleTransition = (index: number): Transition => (reduced ? { duration: 0 } : { duration: 0.9 + index * 0.15, repeat: Infinity, ease: 'easeInOut' });
    const Card: React.FC<{ label: string; index: number; x: number[] }> = ({ label, index, x }) => (
        <motion.div
            className="absolute top-4 h-12 w-[30%]"
            style={{ left: '6%' }}
            initial={false}
            animate={{ x }}
            transition={transition}
        >
            <motion.div
                className="relative grid h-full w-full place-items-center rounded-xl text-[11px] font-semibold"
                style={{ backgroundColor: tint(14), border: `1px solid ${tint(20)}` }}
                initial={false}
                animate={jiggle}
                transition={jiggleTransition(index)}
            >
                {label}
                <span className="absolute -left-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full text-[10px] leading-none" style={{ backgroundColor: tint(30) }}>−</span>
            </motion.div>
        </motion.div>
    );
    return (
        <div className="absolute inset-0">
            {/* 横着的手机：宽屏底板，右上角编辑按钮 */}
            <div className="absolute inset-x-3 inset-y-2 rounded-2xl" style={{ border: `1.5px solid ${tint(28)}` }} />
            <span className="absolute right-6 top-4 grid h-5 w-5 place-items-center rounded-full" style={{ backgroundColor: accent, color: '#000' }}>
                <Check size={11} aria-hidden="true" />
            </span>
            <Card label="10:42" index={0} x={[0, 0, 0, 92, 92, 92, 0]} />
            <Card label="☁ 18°" index={1} x={[92, 92, 92, 0, 0, 0, 92]} />
            <div className="absolute top-4 h-12 w-[24%] rounded-xl" style={{ left: '70%', backgroundColor: tint(10), border: `1px dashed ${tint(30)}` }} />
            <div className="absolute inset-x-8 bottom-5 h-6 rounded-full" style={{ backgroundColor: tint(10) }} />
            <Finger
                accent={accent}
                reduced={reduced}
                duration={5}
                times={T}
                x={[56, 56, 56, 148, 148, 148, 56]}
                y={[44, 44, 44, 44, 44, 44, 44]}
                press={[0, 1, 1, 1, 0, 0, 0]}
                opacity={[0, 1, 1, 1, 0, 0, 0]}
            />
        </div>
    );
};

// —— 结尾：均衡器一样跳动的几根柱子，中间一个对勾 ——
const FinishDemo: React.FC<DemoProps> = ({ accent, reduced }) => (
    <div className="absolute inset-0 flex items-end justify-center gap-1.5 pb-6">
        {Array.from({ length: 13 }, (_, index) => (
            <motion.span
                key={index}
                className="w-2 rounded-full"
                style={{ backgroundColor: index % 3 === 0 ? accent : tint(40) }}
                initial={false}
                animate={reduced ? { height: 20 + ((index * 17) % 40) } : { height: [12, 30 + ((index * 23) % 50), 16, 40 + ((index * 11) % 30), 12] }}
                transition={reduced ? { duration: 0 } : { duration: 1.4 + (index % 4) * 0.2, repeat: Infinity, ease: 'easeInOut', delay: index * 0.05 }}
            />
        ))}
        <motion.span
            className="absolute left-1/2 top-4 grid h-10 w-10 -translate-x-1/2 place-items-center rounded-full"
            style={{ backgroundColor: accent, color: '#000' }}
            initial={reduced ? false : { scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 14, delay: 0.2 }}
        >
            <Check size={22} aria-hidden="true" />
        </motion.span>
    </div>
);

const DEMOS: Record<TutorialDemoId, React.FC<DemoProps>> = {
    welcome: WelcomeDemo,
    search: SearchDemo,
    wallPlay: WallPlayDemo,
    barTap: BarTapDemo,
    barSwipe: BarSwipeDemo,
    barExpand: BarExpandDemo,
    widgets: WidgetsDemo,
    finish: FinishDemo,
};

/** 卡片顶部的示范舞台：固定 300×150 的画面，按卡片宽度等比缩放（卡片在窄屏上会比 300 窄）。 */
export const TutorialDemo: React.FC<{ id: TutorialDemoId; accent: string }> = ({ id, accent }) => {
    const { t } = useTranslation();
    const reduced = useReducedMotion() ?? false;
    const Demo = DEMOS[id];
    const text: DemoText = {
        song: t('mobileTutorial.demo.song'),
        nextSong: t('mobileTutorial.demo.nextSong'),
        artist: t('mobileTutorial.demo.artist'),
        query: t('mobileTutorial.demo.query'),
        lyrics: [t('mobileTutorial.demo.lyric1'), t('mobileTutorial.demo.lyric2'), t('mobileTutorial.demo.lyric3')],
    };
    return (
        <div
            aria-hidden="true"
            data-testid={`mobile-tutorial-demo-${id}`}
            className="relative mb-3 aspect-[2/1] w-full overflow-hidden rounded-2xl"
            style={{ backgroundColor: tint(5), border: `1px solid ${tint(10)}` }}
        >
            <div className="absolute left-1/2 top-1/2 h-[150px] w-[300px] -translate-x-1/2 -translate-y-1/2">
                <Demo key={id} accent={accent} reduced={reduced} text={text} />
            </div>
        </div>
    );
};
