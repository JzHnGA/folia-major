import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { RotateCcw } from 'lucide-react';

// src/components/mobile-tutorial/NightstandRotateDemo.tsx
// 新手教程「播放与床头钟」那一步的示范动画：画在压暗层上的一部小手机，竖着时是墙，一个转向箭头亮起，手机转成横的，
// 屏幕换成床头钟（大时钟加三张小组件卡），停一会儿再转回竖的，一遍遍地演。只是画面，不接触摸；系统要求减少动态效果时不演。

const PHONE = { width: 62, height: 120 };
const LOOP_SECONDS = 5.2;

/**
 * 一遍里的几个时刻：竖着 → 箭头亮起 → 转成横的 → 床头钟亮起 → 横着停 → 床头钟淡去 → 转回竖的 → 竖着停。
 * 下面每一列的数组都与它一一对应。
 */
const TIMES = [0, 0.12, 0.2, 0.36, 0.44, 0.7, 0.76, 0.9, 1];

type NightstandRotateDemoProps = {
    /** 可以画的那一段（视口里的上下界，像素）：说明卡与高亮框之间的空处。 */
    area: { top: number; bottom: number };
};

const NightstandRotateDemo: React.FC<NightstandRotateDemoProps> = ({ area }) => {
    const reduced = useReducedMotion();
    if (reduced) return null;

    // 转成横的之后手机占 PHONE.height 宽、PHONE.width 高；竖着时占 PHONE.height 高。按空处缩小，太挤就不演。
    const room = area.bottom - area.top;
    const scale = Math.min(1, (room - 24) / PHONE.height);
    if (scale < 0.55) return null;
    const centerY = area.top + room / 2;
    const loop = { duration: LOOP_SECONDS, times: TIMES, repeat: Infinity, ease: 'easeInOut' as const };
    // 竖着的时候看得见墙，横着的时候看得见床头钟。
    const wallOpacity = [1, 1, 1, 0.6, 0, 0, 0.6, 1, 1];
    const nightstandOpacity = [0, 0, 0, 0.4, 1, 1, 0.4, 0, 0];

    return (
        <div aria-hidden="true" data-testid="mobile-tutorial-nightstand-demo" className="pointer-events-none absolute inset-x-0" style={{ top: centerY, height: 0 }}>
            {/* 一个没有大小的锚点，正落在空处的中心；手机与箭头都从它居中。 */}
            <div className="absolute left-1/2 top-0 h-0 w-0" style={{ transform: `scale(${scale})` }}>
                {/* 转向箭头：转之前亮起，提示「把手机横过来」。 */}
                <motion.div
                    className="absolute text-white"
                    style={{ left: PHONE.width / 2 + 18, top: -PHONE.height / 2 - 6 }}
                    initial={{ opacity: 0, rotate: 0 }}
                    animate={{ opacity: [0, 0.9, 0.9, 0, 0, 0, 0, 0, 0], rotate: [0, 0, -30, -90, -90, -90, -90, 0, 0] }}
                    transition={loop}
                >
                    <RotateCcw size={22} strokeWidth={2.2} />
                </motion.div>

                <motion.div
                    className="absolute left-0 top-0 overflow-hidden rounded-[14px] border-2 border-white/85 bg-black/60"
                    style={{ width: PHONE.width, height: PHONE.height, translateX: '-50%', translateY: '-50%', boxShadow: '0 14px 32px rgba(0,0,0,0.5)' }}
                    initial={{ rotate: 0 }}
                    animate={{ rotate: [0, 0, 0, -90, -90, -90, -90, 0, 0] }}
                    transition={loop}
                >
                    {/* 竖着：一面小墙，中间一条信息条。 */}
                    <motion.div className="absolute inset-[5px] grid grid-cols-2 gap-[3px]" animate={{ opacity: wallOpacity }} transition={loop}>
                        {Array.from({ length: 6 }, (_, index) => (
                            <span key={index} className={`rounded-[3px] ${index === 2 || index === 3 ? 'bg-white/45' : 'bg-white/20'}`} />
                        ))}
                    </motion.div>

                    {/* 横着：床头钟。先转 90° 摆好，手机转成横的时它正好立着。 */}
                    <motion.div
                        className="absolute left-1/2 top-1/2 flex flex-col justify-center gap-[5px] px-[8px]"
                        style={{ width: PHONE.height - 10, height: PHONE.width - 10, translateX: '-50%', translateY: '-50%', rotate: 90 }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: nightstandOpacity }}
                        transition={loop}
                    >
                        <span className="text-[19px] font-semibold leading-none tracking-tight text-white">21:30</span>
                        <span className="flex gap-[4px]">
                            <span className="h-[14px] w-[22px] rounded-[3px] bg-white/35" />
                            <span className="h-[14px] w-[22px] rounded-[3px] bg-white/35" />
                            <span className="h-[14px] w-[22px] rounded-[3px] bg-white/35" />
                        </span>
                    </motion.div>
                </motion.div>
            </div>
        </div>
    );
};

export default NightstandRotateDemo;
