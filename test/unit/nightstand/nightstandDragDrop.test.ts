import { describe, expect, it } from 'vitest';
import {
    clampSizeFor,
    nextWidgetSize,
    reorderedForDrop,
    sizeForResizeDrag,
    widgetSizeOf,
    type NightstandWidgetId,
    type NightstandWidgetsConfig,
} from '@/components/nightstand/widgets/nightstandWidgets';
import { upcomingEvents, type CalendarEventInfo } from '@/utils/system/calendarEvents';

// test/unit/nightstand/nightstandDragDrop.test.ts
// 床头钟编辑模式的纯逻辑：拖拽落点换算成新顺序、手柄拖拽位移按格子换算成尺寸档位、各卡支持的档位；
// 以及日历卡「今天接下来的日程」的挑选。

const ORDER: NightstandWidgetId[] = ['clock', 'weather', 'calendar', 'hitokoto', 'albumArt'];

describe('reorderedForDrop', () => {
    it('把拖动的卡插到目标卡前面或后面', () => {
        expect(reorderedForDrop(ORDER, 'clock', 'calendar', false)).toEqual(['weather', 'clock', 'calendar', 'hitokoto', 'albumArt']);
        expect(reorderedForDrop(ORDER, 'clock', 'calendar', true)).toEqual(['weather', 'calendar', 'clock', 'hitokoto', 'albumArt']);
    });

    it('往后挪时先摘掉再插入，位置不串', () => {
        expect(reorderedForDrop(ORDER, 'hitokoto', 'clock', false)).toEqual(['hitokoto', 'clock', 'weather', 'calendar', 'albumArt']);
        expect(reorderedForDrop(ORDER, 'weather', 'albumArt', true)).toEqual(['clock', 'calendar', 'hitokoto', 'albumArt', 'weather']);
    });

    it('拖到自己身上、或任一边不在列表里，顺序原样返回', () => {
        expect(reorderedForDrop(ORDER, 'clock', 'clock', true)).toBe(ORDER);
        expect(reorderedForDrop(ORDER, 'clock', 'gone' as NightstandWidgetId, true)).toBe(ORDER);
        expect(reorderedForDrop(ORDER, 'gone' as NightstandWidgetId, 'clock', true)).toBe(ORDER);
    });
});

describe('sizeForResizeDrag', () => {
    const STEP = 136; // 一格 124 + 间距 12

    it('向右过半格加一列（小 → 中），向下过半格加一行（中 → 大）', () => {
        expect(sizeForResizeDrag('clock', 'S', 0, 0, STEP)).toBe('S');
        expect(sizeForResizeDrag('clock', 'S', 67, 0, STEP)).toBe('S');
        expect(sizeForResizeDrag('clock', 'S', 68, 0, STEP)).toBe('M');
        expect(sizeForResizeDrag('clock', 'M', 0, 68, STEP)).toBe('L');
        expect(sizeForResizeDrag('clock', 'S', 140, 140, STEP)).toBe('L');
    });

    it('往左上缩小，左右对称地过半进位', () => {
        expect(sizeForResizeDrag('clock', 'L', 0, -68, STEP)).toBe('M');
        expect(sizeForResizeDrag('clock', 'L', -68, -68, STEP)).toBe('S');
        expect(sizeForResizeDrag('clock', 'M', -67, 0, STEP)).toBe('M');
        expect(sizeForResizeDrag('clock', 'M', -68, 0, STEP)).toBe('S');
    });

    it('占两行就是大号（没有 1×2），并且钳在 S–L 之间', () => {
        expect(sizeForResizeDrag('clock', 'S', 0, 140, STEP)).toBe('L');
        expect(sizeForResizeDrag('clock', 'L', 500, 500, STEP)).toBe('L');
        expect(sizeForResizeDrag('clock', 'S', -500, -500, STEP)).toBe('S');
    });

    it('钳到这张卡支持的档位：一言没有小号', () => {
        expect(sizeForResizeDrag('hitokoto', 'M', -200, 0, STEP)).toBe('M');
        expect(sizeForResizeDrag('hitokoto', 'M', 0, 140, STEP)).toBe('L');
    });
});

describe('尺寸档位', () => {
    const config = (sizes: NightstandWidgetsConfig['sizes']): NightstandWidgetsConfig => ({
        order: ORDER, hidden: [], cardStyle: 'glass', layout: 'row', sizes,
    });

    it('没存过的用各卡默认值，存过的钳到支持范围内', () => {
        expect(widgetSizeOf(config({}), 'clock')).toBe('M');
        expect(widgetSizeOf(config({}), 'weather')).toBe('S');
        expect(widgetSizeOf(config({ hitokoto: 'S' }), 'hitokoto')).toBe('M');
        expect(clampSizeFor('hitokoto', 'L')).toBe('L');
    });

    it('点一下手柄在支持的档位里循环', () => {
        expect(nextWidgetSize('clock', 'S')).toBe('M');
        expect(nextWidgetSize('clock', 'M')).toBe('L');
        expect(nextWidgetSize('clock', 'L')).toBe('S');
        expect(nextWidgetSize('hitokoto', 'M')).toBe('L');
        expect(nextWidgetSize('hitokoto', 'L')).toBe('M');
    });
});

describe('upcomingEvents', () => {
    const event = (title: string, startHour: number, endHour: number): CalendarEventInfo => ({
        title,
        startDate: new Date(2026, 10, 17, startHour).getTime(),
        endDate: new Date(2026, 10, 17, endHour).getTime(),
        isAllDay: false,
    });

    it('跳过已结束的，留下正在进行的和还没开始的，按条数截断', () => {
        const now = new Date(2026, 10, 17, 12, 0).getTime();
        const events = [
            event('past', 9, 10),
            event('ongoing', 11, 13),
            event('next', 14, 15),
            event('later', 16, 17),
        ];
        expect(upcomingEvents(events, now, 3).map(e => e.title)).toEqual(['ongoing', 'next', 'later']);
        expect(upcomingEvents(events, now, 2).map(e => e.title)).toEqual(['ongoing', 'next']);
    });
});
