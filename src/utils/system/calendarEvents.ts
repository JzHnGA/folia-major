// src/utils/system/calendarEvents.ts
// 读系统日历里的日程（iCloud、Exchange 等账户都会汇进 iOS 的日历库）：原生壳走 Capacitor
// Calendar 插件（EventKit），其余环境回 unavailable。只读，不写日历。

export interface CalendarEventInfo {
    title: string;
    startDate: number;
    endDate: number;
    isAllDay: boolean;
}

export type CalendarEventsResult =
    | { status: 'ready'; events: CalendarEventInfo[] }
    /** 非原生壳，或读取失败。 */
    | { status: 'unavailable' }
    /** 用户拒绝了日历权限。 */
    | { status: 'denied' };

/** 今天的日程（0 点到 24 点），按开始时间排好序。 */
export const listTodayCalendarEvents = async (): Promise<CalendarEventsResult> => {
    const plugin = window.Capacitor?.isNativePlatform?.() === true ? window.Capacitor.Plugins?.CapacitorCalendar : undefined;
    if (!plugin) return { status: 'unavailable' };
    try {
        let permission = (await plugin.checkPermission({ scope: 'readCalendar' })).result;
        if (permission === 'prompt' || permission === 'prompt-with-rationale') {
            permission = (await plugin.requestPermission({ scope: 'readCalendar' })).result;
        }
        if (permission !== 'granted' && permission !== 'limited') return { status: 'denied' };
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const { result } = await plugin.listEventsInRange({ from: start.getTime(), to: end.getTime() });
        return { status: 'ready', events: [...result].sort((a, b) => a.startDate - b.startDate) };
    } catch (error) {
        console.warn('[Nightstand] 读取日历失败', error);
        return { status: 'unavailable' };
    }
};

/** 还没开始或正在进行的事件，最多 count 条。 */
export const upcomingEvents = (events: CalendarEventInfo[], now: number, count: number): CalendarEventInfo[] =>
    events.filter(event => event.endDate >= now).slice(0, count);
