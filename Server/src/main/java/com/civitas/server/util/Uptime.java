package com.civitas.server.util;

/** 进程运行时长（等价 Node 的 process.uptime()，用于 /healthz 的 uptimeSec） */
public final class Uptime {
    private static final long START_NANOS = System.nanoTime();

    private Uptime() {}

    /** Math.round(process.uptime()) 的等价物：四舍五入到秒 */
    public static long seconds() {
        return Math.round((System.nanoTime() - START_NANOS) / 1_000_000_000.0);
    }
}
