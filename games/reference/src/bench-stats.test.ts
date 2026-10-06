import { describe, expect, it } from 'vitest'
import { createPartStats, Rolling, WINDOW_MS } from './bench-stats.js'

describe('bench meter: per-part statistics', () => {
  it('p50 and p95 per part are exact over a window of synthetic samples', () => {
    const stats = createPartStats()
    // 100 passes, one per 50 ms; sample i (1..100) has sim_tick i * 10 us, seal i us, frame i * 2 us.
    for (let i = 1; i <= 100; i++) {
      stats.push(i * 50, {
        wholeUs: i * 20,
        sealUs: i,
        tickUs: i * 10,
        frameUs: i * 2,
        resyncUs: i % 8 === 0 ? 1000 + i : 0,
        catchupTicks: i === 40 ? 3 : 0,
      })
    }
    const r = stats.readings()
    // Nearest rank: p50 of 1..100 is the 50th, p95 the 95th.
    expect(r.simTickP50Ms).toBe(0.5)
    expect(r.simTickP95Ms).toBe(0.95)
    expect(r.sealP95Ms).toBe(0.095)
    expect(r.frameBuildP95Ms).toBe(0.19)
    expect(r.tickP50Ms).toBe(1)
    // Resync is read over the passes that ran one (8, 16, ... 96): 12 samples, so the 12th: 1096 us.
    expect(r.resyncP95Ms).toBe(1.096)
    expect(r.catchupTicksPer10s).toBe(3)
  })

  it('the whole-pass p95 is what a plain Rolling fed the whole values gives', () => {
    const stats = createPartStats()
    const plain = new Rolling()
    let seed = 7
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const whole = 3000 + (seed % 9000)
      stats.push(i * 50, {
        wholeUs: whole,
        sealUs: 10,
        tickUs: whole - 100,
        frameUs: 50,
        resyncUs: i % 8 === 0 ? whole : 0,
        catchupTicks: 0,
      })
      plain.push(i * 50, whole / 1000)
    }
    expect(stats.readings().tickP95Ms).toBe(plain.p95())
  })

  it('samples older than the 10 s window fall out', () => {
    const stats = createPartStats()
    stats.push(0, {
      wholeUs: 9000,
      sealUs: 0,
      tickUs: 9000,
      frameUs: 0,
      resyncUs: 0,
      catchupTicks: 5,
    })
    stats.push(WINDOW_MS + 1, {
      wholeUs: 1000,
      sealUs: 0,
      tickUs: 1000,
      frameUs: 0,
      resyncUs: 0,
      catchupTicks: 0,
    })
    const r = stats.readings()
    expect(r.tickP95Ms).toBe(1)
    expect(r.catchupTicksPer10s).toBe(0)
  })
})
