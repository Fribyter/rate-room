import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { fetchAccessInfo, fetchSharedState } from './api'

const POLL_INTERVAL_MS = 4000
const RECONNECTED_NOTICE_MS = 3000
const DEFAULT_ACTIVITY_TYPE = 'food'
const DEFAULT_RESULTS_VISIBILITY = 'live'
const ACTIVITY_OPTIONS = [
  {
    value: 'food',
    label: 'Food tasting',
    title: 'Neighborhood Tasting Board',
    description: 'Run a shared LAN tasting round for dishes, desserts, snacks, or coffee.',
    itemSingular: 'Dish',
    itemPlural: 'Dishes',
    winnerLabel: 'Top Rated Dish',
  },
  {
    value: 'cocktail',
    label: 'Cocktail flight',
    title: 'Cocktail Flight Scoreboard',
    description: 'Score cocktails, mocktails, bottles, or tasting flights together on the same LAN.',
    itemSingular: 'Cocktail',
    itemPlural: 'Cocktails',
    winnerLabel: 'Top Rated Cocktail',
  },
  {
    value: 'custom',
    label: 'Custom session',
    title: 'LAN Rating Session',
    description: 'Create a shared local-network scoreboard for any in-person event.',
    itemSingular: 'Entry',
    itemPlural: 'Entries',
    winnerLabel: 'Top Rated Entry',
  },
]

const DEFAULT_EVENT = {
  title: 'Neighborhood Tasting Board',
  description: 'Run a shared LAN tasting round for dishes, desserts, snacks, or coffee.',
  activityType: DEFAULT_ACTIVITY_TYPE,
  hostName: 'adam',
  customItemLabelSingular: '',
  customItemLabelPlural: '',
  resultsVisibility: DEFAULT_RESULTS_VISIBILITY,
  resultsPublished: true,
}

function getActivityOption(activityType) {
  return ACTIVITY_OPTIONS.find((option) => option.value === activityType) ?? ACTIVITY_OPTIONS[0]
}

function normalizeEventConfig(event = {}) {
  const activityType = ACTIVITY_OPTIONS.some((option) => option.value === event.activityType)
    ? event.activityType
    : DEFAULT_ACTIVITY_TYPE
  const option = getActivityOption(activityType)

  return {
    title: typeof event.title === 'string' && event.title.trim() ? event.title.trim() : option.title,
    description:
      typeof event.description === 'string' && event.description.trim()
        ? event.description.trim()
        : option.description,
    activityType,
    hostName:
      typeof event.hostName === 'string' && event.hostName.trim() ? event.hostName.trim() : 'adam',
    customItemLabelSingular:
      activityType === 'custom' &&
      typeof event.customItemLabelSingular === 'string' &&
      event.customItemLabelSingular.trim()
        ? event.customItemLabelSingular.trim()
        : option.itemSingular,
    customItemLabelPlural:
      activityType === 'custom' &&
      typeof event.customItemLabelPlural === 'string' &&
      event.customItemLabelPlural.trim()
        ? event.customItemLabelPlural.trim()
        : option.itemPlural,
    resultsVisibility:
      typeof event.resultsVisibility === 'string' ? event.resultsVisibility : DEFAULT_RESULTS_VISIBILITY,
    resultsPublished:
      typeof event.resultsPublished === 'boolean' ? event.resultsPublished : true,
  }
}

function getItemLabels(eventConfig) {
  const option = getActivityOption(eventConfig.activityType)

  if (eventConfig.activityType === 'custom') {
    return {
      singular: eventConfig.customItemLabelSingular || option.itemSingular,
      plural: eventConfig.customItemLabelPlural || option.itemPlural,
    }
  }

  return {
    singular: option.itemSingular,
    plural: option.itemPlural,
  }
}

function computeSummary(items, ratings) {
  const summary = items.map((item) => {
    let totalScore = 0
    let voteCount = 0

    ratings.forEach((rating) => {
      const score = rating?.scores?.[item.id]
      if (typeof score === 'number') {
        totalScore += score
        voteCount += 1
      }
    })

    return {
      itemId: item.id,
      totalScore,
      voteCount,
      averageScore: voteCount > 0 ? totalScore / voteCount : 0,
      createdAt: Number(item.createdAt) || 0,
    }
  })

  return summary
    .sort((a, b) => {
      if (b.averageScore !== a.averageScore) {
        return b.averageScore - a.averageScore
      }
      if (b.voteCount !== a.voteCount) {
        return b.voteCount - a.voteCount
      }
      if (b.totalScore !== a.totalScore) {
        return b.totalScore - a.totalScore
      }
      return a.createdAt - b.createdAt
    })
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

function formatScore(value) {
  return Number(value).toFixed(2)
}

function formatTime(value) {
  if (!value) return '--:--:--'

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

function isJoinableHostName(hostname) {
  return hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
}

function getJoinUrl(accessInfo) {
  const candidates = [...(accessInfo?.lanOrigins ?? []), accessInfo?.currentOrigin].filter(Boolean)

  const joinableCandidates = candidates.filter((url) => {
    try {
      const parsedUrl = new URL(url)
      return isJoinableHostName(parsedUrl.hostname)
    } catch {
      return false
    }
  })

  return joinableCandidates[0] ?? accessInfo?.currentOrigin ?? ''
}

function MonitorPage() {
  const [eventConfig, setEventConfig] = useState(DEFAULT_EVENT)
  const [accessInfo, setAccessInfo] = useState({ currentOrigin: '', lanOrigins: [] })
  const [items, setItems] = useState([])
  const [ratings, setRatings] = useState([])
  const [connectionStatus, setConnectionStatus] = useState('connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0)
  const [rankEffects, setRankEffects] = useState({})
  const [qrCodeImage, setQrCodeImage] = useState('')
  const cardRefs = useRef(new Map())
  const previousRanksRef = useRef(new Map())
  const previousTopsRef = useRef(new Map())
  const itemLabels = useMemo(() => getItemLabels(eventConfig), [eventConfig])
  const activityOption = useMemo(
    () => getActivityOption(eventConfig.activityType),
    [eventConfig.activityType],
  )
  const summary = useMemo(() => computeSummary(items, ratings), [items, ratings])
  const summaryWithItems = useMemo(
    () =>
      summary
        .map((entry) => ({
          ...entry,
          item: items.find((item) => item.id === entry.itemId) ?? null,
        }))
        .filter((entry) => entry.item),
    [items, summary],
  )
  const leader = summaryWithItems[0] ?? null
  const joinUrl = useMemo(() => getJoinUrl(accessInfo), [accessInfo])

  function applyState(nextState) {
    setEventConfig(normalizeEventConfig(nextState?.event))
    setItems(Array.isArray(nextState?.items) ? nextState.items : [])
    setRatings(Array.isArray(nextState?.ratings) ? nextState.ratings : [])
    setLastUpdatedAt(Date.now())
  }

  async function refreshSharedState({ silent = false } = {}) {
    if (!silent) {
      setLoading(true)
    }

    try {
      const nextState = await fetchSharedState()
      applyState(nextState)
      setConnectionStatus((current) => (current === 'disconnected' ? 'reconnected' : 'connected'))
      setError((current) =>
        typeof current === 'string' && current.includes('API server is unavailable') ? '' : current,
      )
    } catch (requestError) {
      setConnectionStatus('disconnected')
      if (!silent) {
        setError(requestError.message)
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  async function refreshAccessState() {
    try {
      const nextAccessInfo = await fetchAccessInfo()
      setAccessInfo({
        currentOrigin:
          typeof nextAccessInfo.currentOrigin === 'string' ? nextAccessInfo.currentOrigin : '',
        lanOrigins: Array.isArray(nextAccessInfo.lanOrigins) ? nextAccessInfo.lanOrigins : [],
      })
    } catch {
      // Access hints are optional.
    }
  }

  useEffect(() => {
    void refreshSharedState()
    void refreshAccessState()
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshSharedState({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (connectionStatus !== 'reconnected') {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setConnectionStatus('connected')
    }, RECONNECTED_NOTICE_MS)

    return () => window.clearTimeout(timeoutId)
  }, [connectionStatus])

  useEffect(() => {
    const eventSource = new EventSource('/api/events')

    eventSource.onopen = () => {
      setConnectionStatus((current) => (current === 'disconnected' ? 'reconnected' : 'connected'))
    }

    eventSource.onerror = () => {
      setConnectionStatus('disconnected')
    }

    eventSource.addEventListener('state-changed', () => {
      void refreshSharedState({ silent: true })
      void refreshAccessState()
    })

    return () => {
      eventSource.close()
    }
  }, [])

  useEffect(() => {
    const nextRanks = new Map(summary.map((entry) => [entry.itemId, entry.rank]))
    const changedItems = {}

    summary.forEach((entry) => {
      const previousRank = previousRanksRef.current.get(entry.itemId)

      if (typeof previousRank === 'number' && previousRank !== entry.rank) {
        changedItems[entry.itemId] = {
          direction: previousRank > entry.rank ? 'up' : 'down',
          delta: Math.abs(previousRank - entry.rank),
        }
      }
    })

    previousRanksRef.current = nextRanks

    if (!Object.keys(changedItems).length) {
      return
    }

    setRankEffects((current) => ({
      ...current,
      ...changedItems,
    }))

    const timeoutId = window.setTimeout(() => {
      setRankEffects((current) => {
        const next = { ...current }
        Object.keys(changedItems).forEach((itemId) => {
          delete next[itemId]
        })
        return next
      })
    }, 1800)

    return () => window.clearTimeout(timeoutId)
  }, [summary])

  useLayoutEffect(() => {
    const nextTops = new Map()

    summaryWithItems.forEach((entry) => {
      const node = cardRefs.current.get(entry.itemId)
      if (!node) return

      const top = node.getBoundingClientRect().top
      const previousTop = previousTopsRef.current.get(entry.itemId)

      if (typeof previousTop === 'number') {
        const delta = previousTop - top

        if (Math.abs(delta) > 1) {
          node.animate(
            [
              { transform: `translateY(${delta}px) scale(0.985)` },
              { transform: 'translateY(0) scale(1)' },
            ],
            {
              duration: 900,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            },
          )
        }
      }

      nextTops.set(entry.itemId, top)
    })

    previousTopsRef.current = nextTops
  }, [summaryWithItems])

  useEffect(() => {
    let cancelled = false

    async function generateQRCode() {
      if (!joinUrl) {
        setQrCodeImage('')
        return
      }

      try {
        const image = await QRCode.toDataURL(joinUrl, {
          margin: 1,
          width: 240,
          color: {
            dark: '#111827',
            light: '#f8fbff',
          },
        })

        if (!cancelled) {
          setQrCodeImage(image)
        }
      } catch {
        if (!cancelled) {
          setQrCodeImage('')
        }
      }
    }

    void generateQRCode()

    return () => {
      cancelled = true
    }
  }, [joinUrl])

  return (
    <div className="monitor-shell">
      <div className="monitor-backdrop monitor-backdrop-one" aria-hidden="true" />
      <div className="monitor-backdrop monitor-backdrop-two" aria-hidden="true" />

      <header className="monitor-hero">
        <div className="monitor-copy">
          <p className="eyebrow">Live Monitor</p>
          <h1>{eventConfig.title}</h1>
          <p className="monitor-description">{eventConfig.description}</p>
          <div className="monitor-chip-row">
            <span className="monitor-chip">{activityOption.label}</span>
            <span className="monitor-chip">{items.length} entries</span>
            <span className="monitor-chip">{ratings.length} ballots</span>
            <span className="monitor-chip">Updated {formatTime(lastUpdatedAt)}</span>
          </div>

          {leader && (
            <div className="monitor-simple-leader">
              <span className="monitor-simple-leader-label">{activityOption.winnerLabel}</span>
              <strong>{leader.item.name}</strong>
              <span>
                #{leader.rank} · {formatScore(leader.averageScore)} avg · {leader.voteCount} votes
              </span>
            </div>
          )}
        </div>

        <div className="monitor-status-panel monitor-status-panel-simple">
          <div className={`monitor-status-badge monitor-status-${connectionStatus}`}>
            {connectionStatus === 'connecting'
              ? 'Connecting'
              : connectionStatus === 'disconnected'
                ? 'Disconnected'
                : connectionStatus === 'reconnected'
                  ? 'Reconnected'
                  : 'Live'}
          </div>

          <div className="monitor-metric-grid">
            <article className="monitor-metric-card">
              <span>Leader Score</span>
              <strong>{leader ? formatScore(leader.averageScore) : '--'}</strong>
            </article>
            <article className="monitor-metric-card">
              <span>Votes Cast</span>
              <strong>{ratings.length}</strong>
            </article>
          </div>

          <div className="monitor-join-card">
            <div className="qr-visual-shell">
              {qrCodeImage ? (
                <img src={qrCodeImage} alt={`QR code for ${joinUrl}`} className="qr-image" />
              ) : (
                <div className="qr-placeholder">Generating QR...</div>
              )}
            </div>
            <p className="eyebrow">Scan To Rate</p>
            <h3>Join Scoring Page</h3>
            {joinUrl ? (
              <>
                <p className="monitor-access-url">{joinUrl}</p>
                <a className="inline-link monitor-inline-link" href={joinUrl}>
                  Open Rating Page
                </a>
              </>
            ) : (
              <p className="muted">Waiting for LAN access details.</p>
            )}
          </div>
        </div>
      </header>

      {error && (
        <section className="panel">
          <p className="error-text">{error}</p>
        </section>
      )}

      {loading && items.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <h3>Loading live room</h3>
            <p>The monitor is connecting to the shared scoreboard.</p>
          </div>
        </section>
      ) : items.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <h3>No {itemLabels.plural.toLowerCase()} yet</h3>
            <p>Once the host adds entries, the monitor will start tracking their rank instantly.</p>
          </div>
        </section>
      ) : summaryWithItems.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <h3>Waiting for the first ballots</h3>
            <p>
              {itemLabels.plural} are ready. Rankings will animate into place as soon as scoring begins.
            </p>
          </div>
          <div className="monitor-preview-grid">
            {items.map((item) => (
              <article key={item.id} className="monitor-preview-card">
                <img src={item.image} alt={item.name} className="monitor-preview-image" />
                <div>
                  <p className="eyebrow">{itemLabels.singular}</p>
                  <h3>{item.name}</h3>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel monitor-results-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Real-Time Ranking</p>
              <h2>{itemLabels.plural} Leaderboard</h2>
            </div>
            <p className="muted">Simple list mode with live reordering and score updates.</p>
          </div>

          <div className="monitor-results-list">
            {summaryWithItems.map((entry) => {
              const rankEffect = rankEffects[entry.itemId]

              return (
                <article
                  key={entry.itemId}
                  ref={(node) => {
                    if (node) {
                      cardRefs.current.set(entry.itemId, node)
                    } else {
                      cardRefs.current.delete(entry.itemId)
                    }
                  }}
                  className={`monitor-card ${entry.rank === 1 ? 'monitor-card-leader' : ''} ${
                    rankEffect ? `is-rank-${rankEffect.direction}` : ''
                  }`.trim()}
                >
                  <div className="monitor-card-burst" aria-hidden="true" />
                  <div className="monitor-rank-column">
                    <span className="monitor-rank-chip">#{entry.rank}</span>
                    {rankEffect && (
                      <span className="monitor-rank-shift">
                        {rankEffect.direction === 'up' ? '▲' : '▼'} {rankEffect.delta}
                      </span>
                    )}
                  </div>

                  <div className="monitor-item-media">
                    <img src={entry.item.image} alt={entry.item.name} className="monitor-item-image" />
                  </div>

                  <div className="monitor-item-content">
                    <div className="monitor-item-header">
                      <div>
                        <p className="eyebrow">
                          {entry.rank === 1 ? activityOption.winnerLabel : `${itemLabels.singular} Rank`}
                        </p>
                        <h3>{entry.item.name}</h3>
                      </div>
                      <div className="monitor-score-pill">{formatScore(entry.averageScore)}</div>
                    </div>

                    <div className="monitor-stat-grid">
                      <div className="monitor-stat">
                        <span>Average</span>
                        <strong>{formatScore(entry.averageScore)}</strong>
                      </div>
                      <div className="monitor-stat">
                        <span>Total</span>
                        <strong>{formatScore(entry.totalScore)}</strong>
                      </div>
                      <div className="monitor-stat">
                        <span>Votes</span>
                        <strong>{entry.voteCount}</strong>
                      </div>
                      <div className="monitor-stat">
                        <span>Uploaded By</span>
                        <strong>{entry.item.uploadedBy}</strong>
                      </div>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

export default MonitorPage
