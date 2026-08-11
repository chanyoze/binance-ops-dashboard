import {
  type AppConfig,
  type Interval,
  type Kline,
  type Logger,
  buildStreamUrl,
  nextReconnectDelay,
  parseWsMessage,
} from '@app/shared'
import { CHANNELS, type KlineRepository, type RealtimeBus } from '@app/db'
import WebSocket from 'ws'
import type { BackfillService } from './backfill-service.js'

/**
 * WebSocket 수집기.
 *
 * 평상시 가동 시간의 대부분은 그냥 받아 적는 일을 한다. 나머지 코드는 전부
 * **"받아 적지 못하게 된 상황"을 감지하고 복구하는 장치**다.
 *
 * 가장 위험한 장애는 연결이 끊기는 게 아니라 **끊긴 걸 모르는 것**이다.
 * TCP 는 살아 있는데 데이터만 안 오면 onclose 가 호출되지 않아 재연결 로직이
 * 영영 발동하지 않고, 대시보드는 멀쩡한 얼굴로 몇 시간 전 값을 띄운다.
 * watchdog 이 이 조용한 실패를 잡는다. (docs/DECISIONS.md D-04)
 */

/** 상태 테이블 갱신 주기. aggTrade 는 초당 수십 건이라 매번 쓰면 DB 가 낭비된다. */
const STATE_FLUSH_INTERVAL_MS = 1_000

export class WsCollector {
  private socket: WebSocket | null = null
  private watchdog: NodeJS.Timeout | null = null
  private stateFlusher: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  private reconnectAttempt = 0
  private lastMessageAt = 0
  private connectedSince: number | null = null
  private disconnectedAt: number | null = null
  private stopped = false

  /** 심볼별 최신가 — aggTrade 로 갱신되며 DB 에는 주기적으로만 반영한다. (D-08) */
  private readonly latestPrice = new Map<string, { price: string; at: number }>()
  private readonly dirtySymbols = new Set<string>()

  constructor(
    private readonly config: AppConfig,
    private readonly repo: KlineRepository,
    private readonly bus: RealtimeBus,
    private readonly backfill: BackfillService,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false
    this.connect()
    this.startWatchdog()
    this.startStateFlusher()
  }

  async stop(): Promise<void> {
    this.stopped = true

    if (this.watchdog) clearInterval(this.watchdog)
    if (this.stateFlusher) clearInterval(this.stateFlusher)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

    this.socket?.removeAllListeners()
    this.socket?.terminate()
    this.socket = null

    await this.flushState()
  }

  // ---------------------------------------------------------------- 연결

  private connect(): void {
    if (this.stopped) return

    const url = buildStreamUrl(
      this.config.BINANCE_WS_BASE,
      this.config.SYMBOLS,
      this.config.KLINE_INTERVAL,
    )

    this.logger.info('WebSocket 연결 시도', {
      symbols: this.config.SYMBOLS,
      attempt: this.reconnectAttempt + 1,
    })

    const socket = new WebSocket(url)
    this.socket = socket

    socket.on('open', () => void this.onOpen())
    socket.on('message', (data) => this.onMessage(data.toString()))
    socket.on('close', (code, reason) => this.onClose(code, reason.toString()))
    socket.on('error', (error) => this.onError(error))
  }

  private async onOpen(): Promise<void> {
    const now = Date.now()
    const wasReconnect = this.disconnectedAt !== null
    const downtimeMs = wasReconnect ? now - this.disconnectedAt! : 0

    this.reconnectAttempt = 0
    this.lastMessageAt = now
    this.connectedSince = now

    this.logger.info('WebSocket 연결됨', {
      reconnect: wasReconnect,
      downtimeSeconds: Math.round(downtimeMs / 1000),
    })

    await this.repo.recordEvent('connected', null, {
      reconnect: wasReconnect,
      downtimeMs,
    })

    for (const symbol of this.config.SYMBOLS) {
      await this.repo.updateState(symbol, this.config.KLINE_INTERVAL, {
        wsConnectedSinceMs: now,
        lastMessageAtMs: now,
        lastError: null,
      })
    }

    // **재연결 직후 갭 복구.** 끊겨 있던 동안의 구멍을 스스로 메운다.
    // 부팅 시퀀스와 완전히 같은 함수를 호출한다 — 상황만 다를 뿐 같은 문제다. (D-02)
    if (wasReconnect) {
      this.disconnectedAt = null
      await this.recoverGapAfterReconnect(downtimeMs)
    }
  }

  private async recoverGapAfterReconnect(downtimeMs: number): Promise<void> {
    for (const symbol of this.config.SYMBOLS) {
      try {
        const result = await this.backfill.backfillFromLastKnownForReconnect(
          symbol,
          this.config.KLINE_INTERVAL,
        )

        if (result.fetched > 0) {
          this.logger.info('재연결 갭 복구 완료', {
            symbol,
            downtimeSeconds: Math.round(downtimeMs / 1000),
            recovered: result.fetched,
          })
        }
      } catch (error) {
        // 복구 실패해도 수집은 계속되어야 한다. 무결성 스캐너가 다시 시도한다.
        this.logger.error('재연결 갭 복구 실패 — 스캐너가 재시도합니다', {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // ---------------------------------------------------------------- 수신

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now()

    const parsed = parseWsMessage(raw)

    if (parsed.kind === 'kline') {
      void this.handleKline(parsed.kline)
      return
    }

    if (parsed.kind === 'trade') {
      // aggTrade 는 저장하지 않는다. 최신가만 갱신하고 버린다. (D-08)
      this.latestPrice.set(parsed.symbol, { price: parsed.price, at: parsed.tradeTime })
      this.dirtySymbols.add(parsed.symbol)
    }
  }

  private async handleKline(kline: Kline): Promise<void> {
    try {
      await this.repo.upsertKlines([kline])

      // 봉이 확정된 시점에만 상태를 갱신한다 — 진행 중 봉은 매초 오므로 낭비다.
      if (kline.isClosed) {
        await this.repo.updateState(kline.symbol, kline.interval as Interval, {
          lastOpenTimeMs: kline.openTime,
        })
      }

      await this.bus.publish(CHANNELS.kline, kline)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // DB 쓰기 실패는 재시도 큐에 넣지 않는다.
      // 원본이 Binance 에 남아 있으므로 복구 후 백필로 메워진다. (D-12)
      this.logger.error('캔들 저장 실패 — 백필로 복구됩니다', {
        symbol: kline.symbol,
        openTime: new Date(kline.openTime).toISOString(),
        error: message,
      })
    }
  }

  // ---------------------------------------------------------------- 감시

  /**
   * 좀비 연결 감지.
   *
   * BTCUSDT / ETHUSDT 는 Binance 에서 가장 거래가 활발한 심볼이다.
   * aggTrade 는 초당 수 건~수십 건, kline 은 초당 1~2회 갱신된다.
   * **10초간 무소식이면 정상 상황일 수 없다.**
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      if (this.stopped || this.socket === null) return
      if (this.socket.readyState !== WebSocket.OPEN) return

      const silenceMs = Date.now() - this.lastMessageAt
      if (silenceMs < this.config.STALE_THRESHOLD_MS) return

      this.logger.warn('좀비 연결 감지 — 강제 재연결', {
        silenceMs,
        threshold: this.config.STALE_THRESHOLD_MS,
      })

      void this.repo.recordEvent('stale_detected', null, {
        silenceMs,
        threshold: this.config.STALE_THRESHOLD_MS,
      })

      // close() 가 아니라 terminate() — 응답하지 않는 소켓은 close 핸드셰이크도 못 끝낸다.
      this.socket.terminate()
    }, 1_000)
  }

  /** 최신가를 주기적으로만 DB 에 반영한다. aggTrade 마다 쓰면 초당 수십 회가 된다. */
  private startStateFlusher(): void {
    this.stateFlusher = setInterval(() => {
      void this.flushState()
    }, STATE_FLUSH_INTERVAL_MS)
  }

  private async flushState(): Promise<void> {
    if (this.dirtySymbols.size === 0) return

    const symbols = [...this.dirtySymbols]
    this.dirtySymbols.clear()

    for (const symbol of symbols) {
      const latest = this.latestPrice.get(symbol)
      if (!latest) continue

      try {
        await this.repo.updateState(symbol, this.config.KLINE_INTERVAL, {
          lastPrice: latest.price,
          lastPriceAtMs: latest.at,
          lastMessageAtMs: this.lastMessageAt,
        })

        await this.bus.publish(CHANNELS.ticker, {
          symbol,
          price: latest.price,
          at: latest.at,
        })
      } catch (error) {
        this.logger.debug('상태 갱신 실패', {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // ---------------------------------------------------------------- 재연결

  private onClose(code: number, reason: string): void {
    if (this.stopped) return

    // Binance 는 24시간마다 연결을 강제 종료한다. 별도 처리가 필요 없다 —
    // 아래 재연결 로직이 그대로 흡수한다.
    this.logger.warn('WebSocket 연결 종료', { code, reason })

    this.markDisconnected({ code, reason })
    this.scheduleReconnect()
  }

  private onError(error: Error): void {
    this.logger.error('WebSocket 오류', { error: error.message })

    // 'error' 뒤에는 'close' 가 따라오므로 여기서 재연결을 예약하지 않는다.
    // 중복 예약하면 연결이 두 개 열린다.
    void this.repo.recordEvent('error', null, { error: error.message })
  }

  private markDisconnected(detail: Record<string, unknown>): void {
    if (this.disconnectedAt === null) this.disconnectedAt = Date.now()
    this.connectedSince = null

    void this.repo.recordEvent('disconnected', null, detail)
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer) return

    this.reconnectAttempt += 1
    const delay = nextReconnectDelay(
      this.reconnectAttempt,
      this.config.RECONNECT_BASE_MS,
      this.config.RECONNECT_MAX_MS,
    )

    this.logger.info('재연결 예약', { attempt: this.reconnectAttempt, delayMs: delay })

    void this.repo.recordEvent('reconnecting', null, {
      attempt: this.reconnectAttempt,
      delayMs: delay,
    })

    for (const symbol of this.config.SYMBOLS) {
      void this.repo.updateState(symbol, this.config.KLINE_INTERVAL, {
        incrementReconnect: true,
        wsConnectedSinceMs: null,
      })
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.socket?.removeAllListeners()
      this.socket = null
      this.connect()
    }, delay)
  }

  /** 대시보드 운영 지표용 스냅샷 */
  snapshot(): {
    connected: boolean
    connectedSince: number | null
    lastMessageAt: number
    reconnectAttempt: number
  } {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      connectedSince: this.connectedSince,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempt: this.reconnectAttempt,
    }
  }
}
