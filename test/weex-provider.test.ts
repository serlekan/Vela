import { describe, it, expect, vi, afterEach } from 'vitest';
import { WeexProvider, normalizeTf, parseContract, candlesToOHLCV, dedupeSorted, aggregate, windowsNewestFirst } from '../src/data/providers/weex/WeexProvider';
import type { OHLCV } from '../src/core/model/ohlcv';

const MIN = 60_000;
const HOUR = 60 * MIN;
const res = (ok: boolean, body: unknown, status = ok ? 200 : 500): Response => ({ ok, status, json: () => Promise.resolve(body) }) as unknown as Response;

/** A raw WEEX candle row (all strings, like the live API). */
function row(t: number, o = '100', h = '110', l = '90', c = '101', v = '5'): string[] {
    return [String(t), o, h, l, c, v, '500'];
}

describe('WEEX pure helpers', () => {
    it('normalizeTf maps aliases to canonical keys', () => {
        expect(normalizeTf('1h')).toBe('60');
        expect(normalizeTf('4H')).toBe('240');
        expect(normalizeTf('1d')).toBe('D');
        expect(normalizeTf('1W')).toBe('W');
        expect(normalizeTf('240')).toBe('240'); // already canonical
    });

    it('parseContract maps tickers to WEEX contract ids, with or without .P', () => {
        expect(parseContract('BTCUSDT.P')).toBe('cmt_btcusdt');
        expect(parseContract(' solusdt ')).toBe('cmt_solusdt');
        expect(parseContract('FARTCOINUSDT.p')).toBe('cmt_fartcoinusdt');
    });

    it('candlesToOHLCV parses strings and drops the zero candles WEEX pads before a listing', () => {
        const out = candlesToOHLCV([['1000', '0', '0', '0', '0', '0', '0'], row(2000, '10', '12', '9', '11', '7')]);
        expect(out).toEqual([{ time: 2000, open: 10, high: 12, low: 9, close: 11, volume: 7 }]);
    });

    it('dedupeSorted sorts by time and keeps the last bar per time', () => {
        const a: OHLCV = { time: 2, open: 1, high: 1, low: 1, close: 1, volume: 0 };
        const b: OHLCV = { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 };
        const b2: OHLCV = { time: 1, open: 9, high: 9, low: 9, close: 9, volume: 0 };
        const out = dedupeSorted([a, b, b2]);
        expect(out.map((x) => x.time)).toEqual([1, 2]);
        expect(out[0]!.open).toBe(9);
    });

    it('aggregate buckets ascending sub-candles into epoch-aligned periods', () => {
        const sub: OHLCV[] = [0, 60, 120, 180].map((m, i) => ({ time: m * MIN, open: 100 + i, high: 110 + i, low: 90 + i, close: 101 + i, volume: 1 }));
        const out = aggregate(sub, 120 * MIN);
        expect(out.map((x) => x.time)).toEqual([0, 120 * MIN]);
        expect(out[0]).toMatchObject({ open: 100, close: 102, high: 111, low: 90, volume: 2 });
    });

    it('windowsNewestFirst splits a range into 100-interval windows, newest first', () => {
        const w = windowsNewestFirst(0, 250 * HOUR, HOUR);
        expect(w).toEqual([
            [150 * HOUR, 250 * HOUR],
            [50 * HOUR, 150 * HOUR],
            [0, 50 * HOUR],
        ]);
    });
});

/**
 * Stub `fetch` with a fake WEEX that keeps the live API's rules: `series` maps
 * granularity → ascending rows, the LAST row being the forming candle.
 * - `/candles` answers the newest `limit` rows (≤ 1000), forming candle included, in no order.
 * - `/historyCandles` answers CLOSED rows only (≤ 100, newest first) in `[startTime, endTime]`,
 *   and rejects an `endTime` in the future with WEEX's 40020 error.
 */
function stubWeex(series: Record<string, string[][]>, contracts: unknown[] = []): URL[] {
    const calls: URL[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((input: string | URL) => {
            const url = new URL(String(input));
            calls.push(url);
            if (url.pathname.endsWith('/contracts')) return Promise.resolve(res(true, contracts));
            const all = series[url.searchParams.get('granularity') ?? ''] ?? [];
            if (url.pathname.endsWith('/candles')) {
                const latest = all.slice(-Math.min(1000, Number(url.searchParams.get('limit') ?? 100)));
                return Promise.resolve(
                    res(
                        true,
                        [...latest].sort(() => 0.5 - Math.random()),
                    ),
                );
            }
            const s = Number(url.searchParams.get('startTime'));
            const e = Number(url.searchParams.get('endTime'));
            if (e > Date.now()) return Promise.resolve(res(false, { code: '40020', msg: 'endTime error', data: null }, 400));
            const rows = all
                .slice(0, -1)
                .filter((r) => Number(r[0]) >= s && Number(r[0]) <= e)
                .slice(-100)
                .reverse();
            return Promise.resolve(res(true, rows));
        }),
    );
    return calls;
}

describe('WeexProvider.getBars (stubbed fetch)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('takes the newest candles from /candles and older ones from history pages', async () => {
        vi.useFakeTimers({ now: 2000 * HOUR + 30 * MIN, toFake: ['Date'] });
        const rows = Array.from({ length: 2001 }, (_, i) => row(i * HOUR, '1', '2', '0.5', String(1 + i)));
        const calls = stubWeex({ '1h': rows });
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '60', { limit: 1500 });
        expect(bars).toHaveLength(1500);
        expect(bars[bars.length - 1]!.time).toBe(2000 * HOUR); // the forming candle (only /candles serves it)
        expect(bars.every((b, i) => i === 0 || b.time - bars[i - 1]!.time === HOUR)).toBe(true); // no gaps
        expect(calls.filter((u) => u.pathname.endsWith('/candles'))).toHaveLength(1);
        expect(calls.filter((u) => u.pathname.endsWith('/historyCandles')).length).toBeGreaterThan(1);
        expect(calls[0]!.searchParams.get('symbol')).toBe('cmt_btcusdt');
        expect(calls[0]!.searchParams.get('granularity')).toBe('1h');
    });

    it('never sends a history endTime in the future', async () => {
        vi.useFakeTimers({ now: 300 * HOUR + 10 * MIN, toFake: ['Date'] });
        const calls = stubWeex({ '1h': Array.from({ length: 301 }, (_, i) => row(i * HOUR)) });
        await new WeexProvider().getBars('BTCUSDT.P', '60', { limit: 300 });
        await new WeexProvider().getBars('BTCUSDT.P', '60', { to: 250 * HOUR, limit: 50 });
        const history = calls.filter((u) => u.pathname.endsWith('/historyCandles'));
        expect(history.every((u) => Number(u.searchParams.get('endTime')) <= Date.now())).toBe(true);
    });

    it('answers the live poll (limit 2) with the just-closed and the forming candle, in one request', async () => {
        vi.useFakeTimers({ now: 50 * HOUR + 20 * MIN, toFake: ['Date'] });
        const calls = stubWeex({ '1h': Array.from({ length: 51 }, (_, i) => row(i * HOUR)) });
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '60', { limit: 2 });
        expect(bars.map((b) => b.time)).toEqual([49 * HOUR, 50 * HOUR]);
        expect(calls).toHaveLength(1);
    });

    it('serves a past window from history pages alone', async () => {
        vi.useFakeTimers({ now: 5000 * HOUR, toFake: ['Date'] });
        const calls = stubWeex({ '1h': Array.from({ length: 5001 }, (_, i) => row(i * HOUR)) });
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '60', { to: 1000 * HOUR, limit: 150 });
        expect(bars).toHaveLength(150);
        expect(bars[bars.length - 1]!.time).toBe(1000 * HOUR);
        expect(calls.some((u) => u.pathname.endsWith('/candles'))).toBe(false);
    });

    it('stops walking back once windows come back empty (before the listing)', async () => {
        vi.useFakeTimers({ now: 1000 * HOUR, toFake: ['Date'] });
        const rows = Array.from({ length: 151 }, (_, i) => row((850 + i) * HOUR)); // listed 150 hours ago
        const calls = stubWeex({ '1h': rows });
        const bars = await new WeexProvider().getBars('NEWUSDT.P', '60', { limit: 5000 });
        expect(bars).toHaveLength(151);
        // 5000 bars would be 50 windows; the walk stops a few windows past genesis.
        expect(calls.length).toBeLessThan(12);
    });

    it('serves a from-bounded tail refresh, including the overlapping first bar', async () => {
        vi.useFakeTimers({ now: 100 * HOUR, toFake: ['Date'] });
        const rows = Array.from({ length: 101 }, (_, i) => row(i * HOUR));
        stubWeex({ '1h': rows });
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '60', { from: 97 * HOUR });
        expect(bars.map((b) => b.time)).toEqual([97 * HOUR, 98 * HOUR, 99 * HOUR, 100 * HOUR]);
    });

    it('aggregates a timeframe WEEX does not serve natively (2h from 1h)', async () => {
        vi.useFakeTimers({ now: 7 * HOUR + 30 * MIN, toFake: ['Date'] });
        const rows = Array.from({ length: 8 }, (_, i) => row(i * HOUR, String(10 + i), String(20 + i), String(5 + i), String(11 + i)));
        stubWeex({ '1h': rows });
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '120', { limit: 3 });
        expect(bars.map((b) => b.time)).toEqual([2 * HOUR, 4 * HOUR, 6 * HOUR]);
        expect(bars[0]).toMatchObject({ open: 12, close: 14, high: 23, low: 7 });
    });

    it('uses the daily granularity for D', async () => {
        vi.useFakeTimers({ now: 10 * 24 * HOUR, toFake: ['Date'] });
        const calls = stubWeex({ '1d': Array.from({ length: 10 }, (_, i) => row(i * 24 * HOUR)) });
        const bars = await new WeexProvider().getBars('ETHUSDT.P', 'D', { limit: 5 });
        expect(bars).toHaveLength(5);
        expect(calls.some((u) => u.searchParams.get('granularity') === '1d')).toBe(true);
    });

    it('retries a page once, so one throttled page does not empty the answer', async () => {
        vi.useFakeTimers({ now: 10 * HOUR, toFake: ['Date'] });
        let first = true;
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                if (first) {
                    first = false;
                    return Promise.resolve(res(false, {}, 429));
                }
                return Promise.resolve(res(true, Array.from({ length: 10 }, (_, i) => row(i * HOUR)).reverse()));
            }),
        );
        const bars = await new WeexProvider().getBars('BTCUSDT.P', '60', { limit: 10 });
        expect(bars).toHaveLength(10);
    });

    it('fails soft: an HTTP error yields an empty list and a warning, not a rejection', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(res(false, {}, 500))),
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(new WeexProvider().getBars('BTCUSDT.P', '60', { limit: 10 })).resolves.toEqual([]);
        warn.mockRestore();
    });

    it('rejects a timeframe it cannot serve or aggregate', async () => {
        const calls = stubWeex({});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(new WeexProvider().getBars('BTCUSDT.P', 'M', { limit: 10 })).resolves.toEqual([]);
        expect(calls).toHaveLength(0);
        warn.mockRestore();
    });
});

describe('WeexProvider symbols', () => {
    afterEach(() => vi.unstubAllGlobals());
    const contracts = [
        { symbol: 'cmt_btcusdt', underlying_index: 'BTC', quote_currency: 'USDT', tick_size: '1' },
        { symbol: 'cmt_dogeusdt', underlying_index: 'DOGE', quote_currency: 'USDT', tick_size: '5' },
    ];

    it('lists contracts as BASEQUOTE.P perpetuals', async () => {
        stubWeex({}, contracts);
        expect(await new WeexProvider().listSymbols()).toEqual([
            { ticker: 'BTCUSDT.P', description: 'BTC / USDT Perpetual', type: 'futures' },
            { ticker: 'DOGEUSDT.P', description: 'DOGE / USDT Perpetual', type: 'futures' },
        ]);
    });

    it('reads tick_size as price decimals for syminfo.mintick', async () => {
        stubWeex({}, contracts);
        const p = new WeexProvider();
        const btc = await p.getSymbolInfo('BTCUSDT.P');
        expect(btc).toMatchObject({ ticker: 'BTCUSDT.P', tickerid: 'WEEX:BTCUSDT.P', basecurrency: 'BTC', currency: 'USDT', mintick: 0.1, pricescale: 10 });
        expect((await p.getSymbolInfo('DOGEUSDT'))?.mintick).toBeCloseTo(0.00001, 10);
        expect(await p.getSymbolInfo('NOPEUSDT.P')).toBeUndefined();
    });

    it('fetches the contract list once and shares it', async () => {
        const calls = stubWeex({}, contracts);
        const p = new WeexProvider();
        await Promise.all([p.listSymbols(), p.getSymbolInfo('BTCUSDT.P'), p.getSymbolInfo('DOGEUSDT.P')]);
        expect(calls.filter((u) => u.pathname.endsWith('/contracts'))).toHaveLength(1);
    });

    it('retries the contract list after a failure instead of caching it', async () => {
        let n = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(n++ === 0 ? res(false, {}, 503) : res(true, contracts))),
        );
        const p = new WeexProvider();
        expect(await p.listSymbols()).toEqual([]);
        expect(await p.listSymbols()).toHaveLength(2);
    });
});
