import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import {
  clearAllData,
  createItem,
  deleteItem,
  fetchAccessInfo,
  fetchPresence,
  fetchSharedState,
  resetAllRatings,
  sendPresenceHeartbeat,
  submitRatings,
  updateEvent,
  withdrawRatings,
} from './api'
import { getClientSessionId, getStoredUser, setStoredUser, storageKeys } from './storage'

const HEARTBEAT_INTERVAL_MS = 5000
const POLL_INTERVAL_MS = 4000
const RECONNECTED_NOTICE_MS = 3000
const SUBMITTING_OVERLAY_MS = 2000
const TOAST_LIFETIME_MS = 4000
const DEFAULT_HOST_NAME = 'adam'
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
    itemExample: 'Black truffle fries',
    cardKicker: 'Tasting Round',
    winnerLabel: 'Top Rated Dish',
    uploadTip: 'Use one strong cover image per dish so the board stays readable on every phone.',
  },
  {
    value: 'cocktail',
    label: 'Cocktail flight',
    title: 'Cocktail Flight Scoreboard',
    description: 'Score cocktails, mocktails, bottles, or tasting flights together on the same LAN.',
    itemSingular: 'Cocktail',
    itemPlural: 'Cocktails',
    itemExample: 'Smoked Negroni',
    cardKicker: 'Flight Entry',
    winnerLabel: 'Top Rated Cocktail',
    uploadTip: 'Bright hero shots and glass-level framing make cocktail rounds much easier to judge.',
  },
  {
    value: 'custom',
    label: 'Custom session',
    title: 'LAN Rating Session',
    description: 'Create a shared local-network scoreboard for any in-person event.',
    itemSingular: 'Entry',
    itemPlural: 'Entries',
    itemExample: 'Entry 01',
    cardKicker: 'LAN Entry',
    winnerLabel: 'Top Rated Entry',
    uploadTip: 'Choose a clear cover image for each entry so people can rate fast without confusion.',
  },
]

const DEFAULT_EVENT = {
  title: 'Neighborhood Tasting Board',
  description: 'Run a shared LAN tasting round for dishes, desserts, snacks, or coffee.',
  activityType: DEFAULT_ACTIVITY_TYPE,
  hostName: DEFAULT_HOST_NAME,
  customItemLabelSingular: '',
  customItemLabelPlural: '',
  resultsVisibility: DEFAULT_RESULTS_VISIBILITY,
  resultsPublished: true,
}

const RESULTS_VISIBILITY_OPTIONS = [
  {
    value: 'live',
    label: 'Live leaderboard',
    description: 'Everyone can see rankings update in real time.',
  },
  {
    value: 'hidden',
    label: 'Hide interim results',
    description: 'Participants cannot see rankings while scoring is in progress.',
  },
  {
    value: 'manual',
    label: 'Reveal only after finish',
    description: 'Participants see results only after the host publishes them.',
  },
]

function getActivityOption(activityType) {
  return ACTIVITY_OPTIONS.find((option) => option.value === activityType) ?? ACTIVITY_OPTIONS[0]
}

function normalizeUserName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeResultsVisibility(value) {
  return RESULTS_VISIBILITY_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_RESULTS_VISIBILITY
}

function normalizeEventConfig(event = {}) {
  const activityType = ACTIVITY_OPTIONS.some((option) => option.value === event.activityType)
    ? event.activityType
    : DEFAULT_ACTIVITY_TYPE
  const option = getActivityOption(activityType)
  const resultsVisibility = normalizeResultsVisibility(event.resultsVisibility)

  return {
    title: typeof event.title === 'string' && event.title.trim() ? event.title.trim() : option.title,
    description:
      typeof event.description === 'string' && event.description.trim()
        ? event.description.trim()
        : option.description,
    activityType,
    hostName:
      typeof event.hostName === 'string' && event.hostName.trim()
        ? event.hostName.trim()
        : DEFAULT_HOST_NAME,
    customItemLabelSingular:
      activityType === 'custom'
        ? typeof event.customItemLabelSingular === 'string' && event.customItemLabelSingular.trim()
          ? event.customItemLabelSingular.trim()
          : option.itemSingular
        : '',
    customItemLabelPlural:
      activityType === 'custom'
        ? typeof event.customItemLabelPlural === 'string' && event.customItemLabelPlural.trim()
          ? event.customItemLabelPlural.trim()
          : option.itemPlural
        : '',
    resultsVisibility,
    resultsPublished:
      resultsVisibility === 'live'
        ? true
        : resultsVisibility === 'hidden'
          ? false
          : Boolean(event.resultsPublished),
  }
}

function getItemLabels(eventConfig) {
  const option = getActivityOption(eventConfig.activityType)

  if (eventConfig.activityType === 'custom') {
    return {
      singular:
        typeof eventConfig.customItemLabelSingular === 'string' && eventConfig.customItemLabelSingular.trim()
          ? eventConfig.customItemLabelSingular.trim()
          : option.itemSingular,
      plural:
        typeof eventConfig.customItemLabelPlural === 'string' && eventConfig.customItemLabelPlural.trim()
          ? eventConfig.customItemLabelPlural.trim()
          : option.itemPlural,
    }
  }

  return {
    singular: option.itemSingular,
    plural: option.itemPlural,
  }
}

function createUser(name) {
  const normalizedName = name.trim()

  return {
    id: `${normalizedName}_${Date.now()}`,
    name: normalizedName,
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Failed to read the image. Please try again.'))
    reader.readAsDataURL(file)
  })
}

function getItemNameFromFile(file, fallbackLabel, index) {
  const fileName =
    typeof file?.name === 'string'
      ? file.name.replace(/\.[^.]+$/, '').trim()
      : ''

  return fileName || `${fallbackLabel} ${index + 1}`
}

function computeSummary(items, ratings) {
  const summary = items.map((item) => {
    let totalScore = 0
    let voteCount = 0

    ratings.forEach((rating) => {
      const score = rating.scores[item.id]
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
      return b.totalScore - a.totalScore
    })
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

function isValidScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10
}

function formatScore(value) {
  return Number(value).toFixed(2)
}

function isJoinableHostName(hostname) {
  return hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
}

function computeRatersByItem(items, ratings) {
  const raters = Object.fromEntries(items.map((item) => [item.id, []]))

  ratings.forEach((rating) => {
    items.forEach((item) => {
      const score = rating?.scores?.[item.id]

      if (isValidScore(score)) {
        raters[item.id].push({
          userName: rating.userName,
          score,
        })
      }
    })
  })

  return raters
}

function getSubmissionProgress(onlineUsers, ratings) {
  const submittedNames = new Set(ratings.map((rating) => normalizeUserName(rating.userName)))
  const submittedUsers = []
  const pendingUsers = []

  onlineUsers.forEach((onlineUser) => {
    if (submittedNames.has(normalizeUserName(onlineUser.userName))) {
      submittedUsers.push(onlineUser.userName)
      return
    }

    pendingUsers.push(onlineUser.userName)
  })

  return {
    submittedUsers,
    pendingUsers,
    submissionRate: onlineUsers.length
      ? Math.round((submittedUsers.length / onlineUsers.length) * 100)
      : 0,
  }
}

function App() {
  const [user, setUser] = useState(() => getStoredUser())
  const [eventConfig, setEventConfig] = useState(DEFAULT_EVENT)
  const [eventDraft, setEventDraft] = useState(DEFAULT_EVENT)
  const [accessInfo, setAccessInfo] = useState({ currentOrigin: '', lanOrigins: [] })
  const [items, setItems] = useState([])
  const [ratings, setRatings] = useState([])
  const [onlineUsers, setOnlineUsers] = useState([])
  const [pendingName, setPendingName] = useState('')
  const [draftScores, setDraftScores] = useState({})
  const [eventDraftDirty, setEventDraftDirty] = useState(false)
  const [joinToasts, setJoinToasts] = useState([])
  const [qrCodeImage, setQrCodeImage] = useState('')
  const [itemName, setItemName] = useState('')
  const [selectedFiles, setSelectedFiles] = useState([])
  const [copiedUrl, setCopiedUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [savingEvent, setSavingEvent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState('connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const clientSessionId = useMemo(() => getClientSessionId(), [])

  const role = user
    ? normalizeUserName(user.name) === normalizeUserName(eventConfig.hostName)
      ? 'host'
      : 'participant'
    : null
  const activityOption = useMemo(
    () => getActivityOption(eventConfig.activityType),
    [eventConfig.activityType],
  )
  const itemLabels = useMemo(() => getItemLabels(eventConfig), [eventConfig])
  const existingRating = useMemo(() => {
    if (!user) return null

    return ratings.find((item) => normalizeUserName(item.userName) === normalizeUserName(user.name)) ?? null
  }, [ratings, user])
  const hasSubmitted =
    Boolean(existingRating) &&
    items.length > 0 &&
    items.every((item) => {
      const score = existingRating?.scores?.[item.id]
      return isValidScore(score)
    })
  const summary = useMemo(() => computeSummary(items, ratings), [items, ratings])
  const ratedCount = items.filter((item) => isValidScore(draftScores[item.id])).length
  const ratersByItem = useMemo(() => computeRatersByItem(items, ratings), [items, ratings])
  const submissionProgress = useMemo(
    () => getSubmissionProgress(onlineUsers, ratings),
    [onlineUsers, ratings],
  )
  const canSubmit =
    items.length > 0 &&
    items.every((item) => isValidScore(draftScores[item.id])) &&
    !hasSubmitted
  const showResults = items.length > 0 && ratings.length > 0
  const resultsVisibleToParticipants =
    eventConfig.resultsVisibility === 'live' ||
    (eventConfig.resultsVisibility === 'manual' && eventConfig.resultsPublished)
  const canCurrentUserSeeResults = role === 'host' ? showResults : showResults && resultsVisibleToParticipants
  const resultVisibilityOption =
    RESULTS_VISIBILITY_OPTIONS.find((option) => option.value === eventDraft.resultsVisibility) ??
    RESULTS_VISIBILITY_OPTIONS[0]
  const joinUrl = useMemo(() => {
    const candidates = [...accessInfo.lanOrigins, accessInfo.currentOrigin].filter(Boolean)

    const joinableCandidates = candidates.filter((url) => {
      try {
        const parsedUrl = new URL(url)
        return isJoinableHostName(parsedUrl.hostname)
      } catch {
        return false
      }
    })

    return joinableCandidates[0] ?? ''
  }, [accessInfo])

  function applyState(nextState) {
    setEventConfig(normalizeEventConfig(nextState.event))
    setItems(Array.isArray(nextState.items) ? nextState.items : [])
    setRatings(Array.isArray(nextState.ratings) ? nextState.ratings : [])
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
      // Access hints are optional. The app itself can still work without them.
    }
  }

  useEffect(() => {
    void refreshSharedState()
    void refreshAccessState()
  }, [])

  useEffect(() => {
    if (!user) {
      setOnlineUsers([])
      return
    }

    async function loadPresence() {
      try {
        const nextPresence = await fetchPresence()
        setOnlineUsers(Array.isArray(nextPresence.onlineUsers) ? nextPresence.onlineUsers : [])
      } catch {
        // Presence should not block the core flow.
      }
    }

    void loadPresence()
  }, [user])

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
    const intervalId = window.setInterval(() => {
      refreshSharedState({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!eventDraftDirty) {
      setEventDraft(normalizeEventConfig(eventConfig))
    }
  }, [eventConfig, eventDraftDirty])

  useEffect(() => {
    if (!user) {
      setJoinToasts([])
      return
    }

    function pushJoinToast(joinedUser) {
      if (!joinedUser?.sessionId || joinedUser.sessionId === clientSessionId || !joinedUser.userName) {
        return
      }

      const toastId = `${joinedUser.sessionId}_${joinedUser.joinedAt || Date.now()}`
      setJoinToasts((current) => [
        {
          id: toastId,
          message: `${joinedUser.userName} joined the room`,
        },
        ...current,
      ].slice(0, 4))

      window.setTimeout(() => {
        setJoinToasts((current) => current.filter((toast) => toast.id !== toastId))
      }, TOAST_LIFETIME_MS)
    }

    const eventSource = new EventSource('/api/events')
    eventSource.addEventListener('presence', (event) => {
      try {
        const payload = JSON.parse(event.data)
        setOnlineUsers(Array.isArray(payload.onlineUsers) ? payload.onlineUsers : [])
      } catch {
        // Ignore malformed presence payloads.
      }
    })
    eventSource.addEventListener('user-joined', (event) => {
      try {
        pushJoinToast(JSON.parse(event.data))
      } catch {
        // Ignore malformed join notifications.
      }
    })
    eventSource.addEventListener('state-changed', () => {
      void refreshSharedState({ silent: true })
    })

    return () => {
      eventSource.close()
    }
  }, [clientSessionId, user])

  useEffect(() => {
    if (!user) {
      return
    }

    let cancelled = false

    async function heartbeat() {
      try {
        const nextPresence = await sendPresenceHeartbeat({
          sessionId: clientSessionId,
          userId: user.id,
          userName: user.name,
        })

        if (!cancelled) {
          setOnlineUsers(Array.isArray(nextPresence.onlineUsers) ? nextPresence.onlineUsers : [])
        }
      } catch {
        // Ignore heartbeat issues; the core room can continue to function.
      }
    }

    void heartbeat()
    const intervalId = window.setInterval(() => {
      void heartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [clientSessionId, user])

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
            dark: '#1f140d',
            light: '#fffaf4',
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

  useEffect(() => {
    if (existingRating) {
      setDraftScores((current) => {
        const next = {}

        items.forEach((item) => {
          const existingScore = existingRating?.scores?.[item.id]
          next[item.id] = isValidScore(existingScore)
            ? existingScore
            : isValidScore(current[item.id])
              ? current[item.id]
              : 5
        })

        return next
      })
      return
    }

    setDraftScores((current) => {
      const next = {}

      items.forEach((item) => {
        next[item.id] = isValidScore(current[item.id]) ? current[item.id] : 5
      })

      return next
    })
  }, [existingRating, items])

  function handleEnterApp(event) {
    event.preventDefault()
    const name = pendingName.trim()

    if (!name) {
      setError('Please enter your name before continuing.')
      return
    }

    const nextUser = createUser(name)
    setStoredUser(nextUser)
    setUser(nextUser)
    setError('')
  }

  function handleEventDraftChange(field, value) {
    setEventDraftDirty(true)
    setEventDraft((current) => {
      const next = {
        ...current,
        [field]: value,
      }

      if (field === 'activityType') {
        const previousOption = getActivityOption(current.activityType)
        const nextOption = getActivityOption(value)

        if (!current.title.trim() || current.title === previousOption.title) {
          next.title = nextOption.title
        }

        if (!current.description.trim() || current.description === previousOption.description) {
          next.description = nextOption.description
        }

        if (value === 'custom') {
          next.customItemLabelSingular = current.customItemLabelSingular || nextOption.itemSingular
          next.customItemLabelPlural = current.customItemLabelPlural || nextOption.itemPlural
        } else {
          next.customItemLabelSingular = ''
          next.customItemLabelPlural = ''
        }
      }

      if (field === 'resultsVisibility') {
        next.resultsPublished =
          value === 'live' ? true : value === 'hidden' ? false : current.resultsPublished
      }

      return next
    })
  }

  async function handleSaveEvent(event) {
    event.preventDefault()

    if (!user) return

    const nextDraft = normalizeEventConfig(eventDraft)

    if (!nextDraft.hostName.trim()) {
      setError('Please enter a host name for this room.')
      return
    }

    if (
      nextDraft.activityType === 'custom' &&
      (!eventDraft.customItemLabelSingular.trim() || !eventDraft.customItemLabelPlural.trim())
    ) {
      setError('Custom sessions need both singular and plural labels.')
      return
    }

    try {
      setSavingEvent(true)
      const nextState = await updateEvent({
        ...nextDraft,
        requestedBy: user.name,
      })

      setEventDraftDirty(false)
      applyState(nextState)
      setError('')
    } catch (updateError) {
      setError(updateError.message)
    } finally {
      setSavingEvent(false)
    }
  }

  async function handleToggleResultsPublished() {
    if (!user) return

    try {
      setSavingEvent(true)
      const nextState = await updateEvent({
        ...eventConfig,
        resultsVisibility: 'manual',
        resultsPublished: !eventConfig.resultsPublished,
        requestedBy: user.name,
      })

      applyState(nextState)
      setError('')
    } catch (updateError) {
      setError(updateError.message)
    } finally {
      setSavingEvent(false)
    }
  }

  async function handleUpload(event) {
    event.preventDefault()

    if (!selectedFiles.length || !user) {
      setError(`Please choose at least one image for the ${itemLabels.plural.toLowerCase()}.`)
      return
    }

    if (selectedFiles.some((file) => !file.type.startsWith('image/'))) {
      setError('Only image files are supported.')
      return
    }

    setUploading(true)
    setError('')

    try {
      let nextState = null

      for (const [index, file] of selectedFiles.entries()) {
        const image = await fileToBase64(file)
        const nextName =
          selectedFiles.length === 1 && itemName.trim()
            ? itemName.trim()
            : getItemNameFromFile(file, itemLabels.singular, index)

        nextState = await createItem({
          name: nextName,
          image,
          uploadedBy: user.name,
        })
      }

      if (nextState) {
        applyState(nextState)
      }
      setItemName('')
      setSelectedFiles([])
      event.target.reset()
    } catch (uploadError) {
      setError(uploadError.message)
    } finally {
      setUploading(false)
    }
  }

  function handleScoreChange(itemId, value) {
    setDraftScores((current) => ({
      ...current,
      [itemId]: Number(value),
    }))
  }

  async function handleSubmitScores() {
    if (!user || !canSubmit) {
      setError(`Please score every ${itemLabels.singular.toLowerCase()} before submitting.`)
      return
    }

    try {
      setSubmitting(true)
      const [nextState] = await Promise.all([
        submitRatings({
          userName: user.name,
          userId: user.id,
          scores: draftScores,
        }),
        new Promise((resolve) => window.setTimeout(resolve, SUBMITTING_OVERLAY_MS)),
      ])

      applyState(nextState)
      setError('')
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteItem(itemId) {
    const itemToDelete = items.find((item) => item.id === itemId)
    if (!itemToDelete || !user) return

    const confirmed = window.confirm(
      `Delete "${itemToDelete.name}"? This will also remove its submitted scores.`,
    )
    if (!confirmed) return

    try {
      const nextState = await deleteItem(itemId, user.name)
      applyState(nextState)
      setDraftScores((current) => {
        const nextDraftScores = { ...current }
        delete nextDraftScores[itemId]
        return nextDraftScores
      })
      setError('')
    } catch (deleteError) {
      setError(deleteError.message)
    }
  }

  async function handleWithdrawRatings() {
    if (!user || !existingRating) return

    const confirmed = window.confirm('Withdraw your submitted ratings and start over?')
    if (!confirmed) return

    try {
      const nextState = await withdrawRatings(user.id, user.name)
      applyState(nextState)
      setError('')
    } catch (withdrawError) {
      setError(withdrawError.message)
    }
  }

  async function handleResetAllRatings() {
    if (!user) return

    const confirmed = window.confirm(
      `Reset all submitted ratings for every participant? The ${itemLabels.plural.toLowerCase()} will stay in the room.`,
    )
    if (!confirmed) return

    try {
      const nextState = await resetAllRatings(user.name)
      applyState(nextState)
      setError('')
    } catch (resetError) {
      setError(resetError.message)
    }
  }

  async function handleClearAllData() {
    if (!user) return

    const confirmed = window.confirm(
      `Reset this session? This will permanently remove every ${itemLabels.singular.toLowerCase()} and every submitted rating, but keep the room settings.`,
    )
    if (!confirmed) return

    try {
      const nextState = await clearAllData(user.name)
      applyState(nextState)
      setDraftScores({})
      setItemName('')
      setSelectedFiles([])
      setError('')
    } catch (clearError) {
      setError(clearError.message)
    }
  }

  async function handleCopyUrl(url) {
    try {
      if (!navigator.clipboard) {
        throw new Error('Clipboard access is unavailable in this browser.')
      }

      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      setError('')
      window.setTimeout(() => {
        setCopiedUrl((current) => (current === url ? '' : current))
      }, 1800)
    } catch (copyError) {
      setError(copyError.message)
    }
  }

  function handleResetIdentity() {
    window.localStorage.removeItem(storageKeys.user)
    window.localStorage.removeItem(storageKeys.legacyUser)
    setUser(null)
    setPendingName('')
  }

  return (
    <div className="app-shell">
      {user && onlineUsers.length > 0 && (
        <div className="online-strip" aria-live="polite">
          <span className="online-strip-label">Online users ({onlineUsers.length})</span>
          <div className="online-strip-users">
            {onlineUsers.map((onlineUser) => (
              <span key={onlineUser.sessionId} className="online-user-chip">
                {onlineUser.userName}
              </span>
            ))}
          </div>
        </div>
      )}

      {connectionStatus !== 'connected' && (
        <div className={`connection-banner connection-${connectionStatus}`} aria-live="polite">
          <strong>
            {connectionStatus === 'connecting'
              ? 'Connecting'
              : connectionStatus === 'disconnected'
                ? 'Disconnected'
                : 'Reconnected'}
          </strong>
          <span>
            {connectionStatus === 'connecting'
              ? 'Trying to reach the host device.'
              : connectionStatus === 'disconnected'
                ? 'Lost connection to the host device. Retrying now.'
                : 'Connection restored. Live room data is syncing again.'}
          </span>
        </div>
      )}

      {joinToasts.length > 0 && (
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          {joinToasts.map((toast) => (
            <div key={toast.id} className="toast-card">
              <p className="eyebrow">Live Join</p>
              <strong>{toast.message}</strong>
            </div>
          ))}
        </div>
      )}

      {!user && (
        <div className="modal-backdrop">
          <form className="name-modal" onSubmit={handleEnterApp}>
            <div className="modal-orb" aria-hidden="true" />
            <p className="eyebrow">RateRoom LAN</p>
            <h1>Enter Your Name</h1>
            <p className="muted">
              Use {eventConfig.hostName} to enter as the host. Any other name joins as a
              participant.
            </p>
            <input
              autoFocus
              value={pendingName}
              onChange={(event) => setPendingName(event.target.value)}
              placeholder={`For example: ${eventConfig.hostName} / jamie`}
            />
            <button type="submit" disabled={!pendingName.trim()}>
              Enter Room
            </button>
            {error && <p className="error-text">{error}</p>}
          </form>
        </div>
      )}

      <header className="hero">
        <div className="hero-copy-block">
          <p className="eyebrow">RateRoom LAN</p>
          <h1>{eventConfig.title}</h1>
          <p className="hero-copy">{eventConfig.description}</p>
          <div className="hero-badges">
            <span className="hero-badge">
              {items.length} {items.length === 1 ? itemLabels.singular.toLowerCase() : itemLabels.plural.toLowerCase()}
            </span>
            <span className="hero-badge">{ratings.length} submitted ballots</span>
            <span className="hero-badge">{activityOption.label}</span>
            <span className="hero-badge">LAN live sync</span>
          </div>
        </div>
        {user && (
          <div className="user-panel">
            <div>
              <p className="panel-label">Current User</p>
              <strong>{user.name}</strong>
            </div>
            <div>
              <p className="panel-label">Room Role</p>
              <strong>{role}</strong>
            </div>
            <div>
              <p className="panel-label">Host Name</p>
              <strong>{eventConfig.hostName}</strong>
            </div>
            <button type="button" className="ghost-button" onClick={handleResetIdentity}>
              Switch User
            </button>
          </div>
        )}
      </header>

      {role === 'host' && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Host QR</p>
              <h2>Scan To Join</h2>
            </div>
            <p className="muted">Participants can scan a QR code from the same Wi-Fi or hotspot.</p>
          </div>

          {!joinUrl ? (
            <div className="empty-state">
              <h3>Waiting for access details</h3>
              <p>Refresh the page once this device has a reachable LAN address for other people.</p>
            </div>
          ) : (
            <div className="access-grid">
              <article className="access-card qr-card">
                <div className="qr-visual-shell">
                  {qrCodeImage ? (
                    <img
                      src={qrCodeImage}
                      alt={`QR code for ${joinUrl}`}
                      className="qr-image"
                    />
                  ) : (
                    <div className="qr-placeholder">Generating QR...</div>
                  )}
                </div>
                <p className="eyebrow">Primary Join Code</p>
                <h3>Main room QR</h3>
                <p className="access-url">{joinUrl}</p>
                <div className="action-row">
                  <button type="button" className="ghost-button" onClick={() => handleCopyUrl(joinUrl)}>
                    {copiedUrl === joinUrl ? 'Copied' : 'Copy Link'}
                  </button>
                  <a className="inline-link" href={joinUrl}>
                    Open
                  </a>
                </div>
              </article>
            </div>
          )}
        </section>
      )}

      {role === 'host' && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Host Controls</p>
              <h2>Configure the Session</h2>
            </div>
            <p className="muted">Keep the room lightweight: one host, one LAN, one live scoreboard.</p>
          </div>

          <div className="host-dashboard">
            <article className="host-card">
              <div className="host-card-topline">
                <span>Submission Progress</span>
                <strong>{submissionProgress.submissionRate}%</strong>
              </div>
              <p className="host-card-copy">
                {submissionProgress.submittedUsers.length} of {onlineUsers.length} online users have
                submitted a ballot.
              </p>
              <div className="host-progress-bar" aria-hidden="true">
                <div
                  className="host-progress-fill"
                  style={{ width: `${submissionProgress.submissionRate}%` }}
                />
              </div>
            </article>

            <article className="host-card">
              <div className="host-card-topline">
                <span>Submitted</span>
                <strong>{submissionProgress.submittedUsers.length}</strong>
              </div>
              {submissionProgress.submittedUsers.length > 0 ? (
                <div className="host-chip-row">
                  {submissionProgress.submittedUsers.map((userName) => (
                    <span key={`submitted_${userName}`} className="host-chip success-chip">
                      {userName}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="host-card-copy">No online users have submitted yet.</p>
              )}
            </article>

            <article className="host-card">
              <div className="host-card-topline">
                <span>Not Submitted</span>
                <strong>{submissionProgress.pendingUsers.length}</strong>
              </div>
              {submissionProgress.pendingUsers.length > 0 ? (
                <div className="host-chip-row">
                  {submissionProgress.pendingUsers.map((userName) => (
                    <span key={`pending_${userName}`} className="host-chip pending-chip">
                      {userName}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="host-card-copy">Everyone currently online has submitted.</p>
              )}
            </article>
          </div>

          <form className="settings-form" onSubmit={handleSaveEvent}>
            <div className="settings-grid">
              <label className="field-stack">
                <span>Session title</span>
                <input
                  value={eventDraft.title}
                  onChange={(event) => handleEventDraftChange('title', event.target.value)}
                  placeholder="For example: Friday Blind Tasting"
                />
              </label>

              <label className="field-stack">
                <span>Activity type</span>
                <select
                  value={eventDraft.activityType}
                  onChange={(event) => handleEventDraftChange('activityType', event.target.value)}
                >
                  {ACTIVITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-stack">
                <span>Host name</span>
                <input
                  value={eventDraft.hostName}
                  onChange={(event) => handleEventDraftChange('hostName', event.target.value)}
                  placeholder="Host identity on this LAN"
                />
              </label>

              <label className="field-stack">
                <span>Results mode</span>
                <select
                  value={eventDraft.resultsVisibility}
                  onChange={(event) => handleEventDraftChange('resultsVisibility', event.target.value)}
                >
                  {RESULTS_VISIBILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-stack field-span-full">
                <span>Session description</span>
                <textarea
                  value={eventDraft.description}
                  onChange={(event) => handleEventDraftChange('description', event.target.value)}
                  placeholder="Tell participants what this round is for."
                  rows="3"
                />
              </label>

              <div className="field-stack field-span-full field-help">
                <span>Results behavior</span>
                <p>{resultVisibilityOption.description}</p>
              </div>

              {eventDraft.activityType === 'custom' && (
                <>
                  <label className="field-stack">
                    <span>Custom singular label</span>
                    <input
                      value={eventDraft.customItemLabelSingular}
                      onChange={(event) =>
                        handleEventDraftChange('customItemLabelSingular', event.target.value)
                      }
                      placeholder="For example: Bottle"
                    />
                  </label>

                  <label className="field-stack">
                    <span>Custom plural label</span>
                    <input
                      value={eventDraft.customItemLabelPlural}
                      onChange={(event) =>
                        handleEventDraftChange('customItemLabelPlural', event.target.value)
                      }
                      placeholder="For example: Bottles"
                    />
                  </label>
                </>
              )}
            </div>

            <div className="submit-bar">
              <div className="action-row">
                <button type="submit" disabled={savingEvent}>
                  {savingEvent ? 'Saving...' : 'Save Session Settings'}
                </button>
              </div>
              <p className="muted">
                Anyone entering the host name joins with host controls, so keep that name deliberate.
              </p>
            </div>
          </form>

          <div className="results-control-panel">
            <div>
              <p className="eyebrow">Result Control</p>
              <h3>Participant leaderboard access</h3>
              <p className="muted">
                {eventConfig.resultsVisibility === 'live'
                  ? 'Participants can see the leaderboard in real time.'
                  : eventConfig.resultsVisibility === 'hidden'
                    ? 'Participants cannot see the leaderboard while this mode is active.'
                    : eventConfig.resultsPublished
                      ? 'Results are published to participants now.'
                      : 'Results are hidden until you publish them.'}
              </p>
            </div>
            {eventConfig.resultsVisibility === 'manual' && (
              <button type="button" className="ghost-button" onClick={handleToggleResultsPublished}>
                {eventConfig.resultsPublished ? 'Hide Results Again' : 'Publish Results Now'}
              </button>
            )}
          </div>

          <div className="upload-shell">
            <form className="upload-form" onSubmit={handleUpload}>
              <input
                value={itemName}
                onChange={(event) => setItemName(event.target.value)}
                placeholder={
                  selectedFiles.length > 1
                    ? `Optional for single upload only. Multi-upload uses each file name.`
                    : `${itemLabels.singular} name, for example ${activityOption.itemExample}`
                }
              />
              <input
                type="file"
                multiple
                accept="image/png,image/jpeg,image/jpg,image/webp"
                onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? []))}
              />
              <button type="submit" disabled={uploading || selectedFiles.length === 0}>
                {uploading
                  ? 'Uploading...'
                  : selectedFiles.length > 1
                    ? `Add ${selectedFiles.length} ${itemLabels.plural}`
                    : `Add ${itemLabels.singular}`}
              </button>
            </form>
            {selectedFiles.length > 1 && (
              <p className="muted">
                Multi-upload mode is active. Each selected image will become its own {itemLabels.singular.toLowerCase()}.
              </p>
            )}
          </div>

          <div className="admin-actions">
            <button type="button" className="danger-button" onClick={handleResetAllRatings}>
              Reset All Ratings
            </button>
            <button type="button" className="danger-button strong-danger-button" onClick={handleClearAllData}>
              Reset Session
            </button>
          </div>
        </section>
      )}

      {error && user && <p className="banner error-text">{error}</p>}

      {submitting && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="pizza-loader" aria-hidden="true">
              <div className="pizza-loader-whole">
                <div className="pizza-loader-center" />
                <div className="pizza-loader-slice slice-1" />
                <div className="pizza-loader-slice slice-2" />
                <div className="pizza-loader-slice slice-3" />
                <div className="pizza-loader-slice slice-4" />
                <div className="pizza-loader-slice slice-5" />
                <div className="pizza-loader-slice slice-6" />
              </div>
            </div>
            <h3>Submitting Ratings</h3>
            <p>Your ballot is being saved to the shared LAN scoreboard.</p>
          </div>
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Rate the {itemLabels.plural}</h2>
          </div>
          {hasSubmitted ? (
            <p className="success-text">
              You have already submitted your ratings. You can withdraw them and resubmit at any
              time.
            </p>
          ) : existingRating ? (
            <p className="muted">
              New {itemLabels.plural.toLowerCase()} were added after your last submission. Please
              rate the new ones and submit again.
            </p>
          ) : loading ? (
            <p className="muted">Loading the shared room and submitted ballots...</p>
          ) : (
            <p className="muted">
              Rate every {itemLabels.singular.toLowerCase()} from 1 to 10 before submitting.
            </p>
          )}
        </div>

        <div className="status-strip">
          <span className="status-chip">{role === 'host' ? 'Host mode' : 'Participant mode'}</span>
          <span className="status-chip">{items.length} live entries</span>
          <span className="status-chip">{ratings.length} shared submissions</span>
          <span className="status-chip">1.0 to 10.0 scoring</span>
        </div>

        {loading && items.length === 0 ? (
          <div className="empty-state">
            <h3>Loading shared data</h3>
            <p>Please wait while the app connects to the host device.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <h3>No {itemLabels.plural.toLowerCase()} yet</h3>
            <p>Wait for the host to add items before rating starts.</p>
          </div>
        ) : (
          <>
            <div className="pizza-grid">
              {items.map((item) => {
                const currentScore = draftScores[item.id] ?? 5

                return (
                  <article
                    key={item.id}
                    className={`pizza-card ${role !== 'host' ? 'participant-pizza-card' : ''}`}
                  >
                    <div className="pizza-visual">
                      <img src={item.image} alt={item.name} className="pizza-image" />
                      <div className="pizza-overlay">
                        <div>
                          <p className="pizza-kicker">{activityOption.cardKicker}</p>
                          <h3>{item.name}</h3>
                          <p>Added by: {item.uploadedBy}</p>
                        </div>
                        <span className="score-pill">{currentScore.toFixed(1)} pts</span>
                      </div>
                    </div>

                    <div className="pizza-meta">
                      <p className="meter-caption">Your current rating: {currentScore.toFixed(1)} / 10</p>
                    </div>

                    {role === 'host' && (
                      <div className="card-host-actions">
                        <button
                          type="button"
                          className="danger-button"
                          onClick={() => handleDeleteItem(item.id)}
                        >
                          Delete {itemLabels.singular}
                        </button>
                      </div>
                    )}

                    <label className="slider-label" htmlFor={item.id}>
                      Slide to rate
                    </label>
                    <input
                      id={item.id}
                      className="rating-slider"
                      type="range"
                      min="1"
                      max="10"
                      step="0.1"
                      value={currentScore}
                      disabled={hasSubmitted}
                      onChange={(event) => handleScoreChange(item.id, event.target.value)}
                    />
                    <div className="slider-scale">
                      <span>1.0</span>
                      <span>10.0</span>
                    </div>
                  </article>
                )
              })}
            </div>

            <div className="submit-bar">
              <div className="action-row">
                <button type="button" onClick={handleSubmitScores} disabled={!canSubmit}>
                  {existingRating ? 'Update Ratings' : 'Submit Ratings'}
                </button>
                {existingRating && (
                  <button type="button" className="ghost-button" onClick={handleWithdrawRatings}>
                    Withdraw Ratings
                  </button>
                )}
              </div>
              <p className="muted">
                {items.length > 0
                  ? `Completed ${ratedCount} / ${items.length} ratings`
                  : `There are no ${itemLabels.plural.toLowerCase()} available right now.`}
              </p>
            </div>
          </>
        )}
      </section>

      {showResults && !canCurrentUserSeeResults && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Score Summary</h2>
            </div>
            <p className="muted">The host is currently hiding the leaderboard.</p>
          </div>

          <div className="empty-state">
            <h3>Results are not visible yet</h3>
            <p>
              The host will reveal the final ranking when the scoring round is ready to close.
            </p>
          </div>
        </section>
      )}

      {showResults && canCurrentUserSeeResults && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Score Summary</h2>
            </div>
            <p className="muted">
              {role === 'host' && !resultsVisibleToParticipants
                ? 'Host preview: participants cannot see this leaderboard yet.'
                : 'Ranking rule: average score first, then vote count, then total score.'}
            </p>
          </div>

          {summary.length === 0 ? (
            <div className="empty-state">
              <h3>No summary available yet</h3>
              <p>
                At least one {itemLabels.singular.toLowerCase()} and one submitted rating are
                required.
              </p>
            </div>
          ) : (
            <div className="results-list">
              {summary.map((item) => {
                const ratedItem = items.find((entry) => entry.id === item.itemId)
                if (!ratedItem) return null

                return (
                  <article
                    key={item.itemId}
                    className={`result-card ${item.rank === 1 ? 'winner-card' : ''} ${item.rank <= 3 ? `podium-card podium-${item.rank}` : ''}`}
                  >
                    <img src={ratedItem.image} alt={ratedItem.name} className="result-image" />
                    <div className="result-content">
                      <div className="result-topline">
                        <span className="rank-badge">#{item.rank}</span>
                        {item.rank === 1 && (
                          <span className="winner-badge">
                            {eventConfig.activityType === 'custom'
                              ? `Top Rated ${itemLabels.singular}`
                              : activityOption.winnerLabel}
                          </span>
                        )}
                      </div>
                      <h3>{ratedItem.name}</h3>
                      <div className="result-stat-grid">
                        <div className="result-stat primary-result-stat">
                          <span>Score</span>
                          <strong>{formatScore(item.averageScore)}</strong>
                        </div>
                        <div className="result-stat">
                          <span>Total</span>
                          <strong>{formatScore(item.totalScore)}</strong>
                        </div>
                        <div className="result-stat">
                          <span>Votes</span>
                          <strong>{item.voteCount}</strong>
                        </div>
                      </div>
                      {role === 'host' && (
                        <div className="rater-panel result-rater-panel">
                          <div className="rater-panel-header">
                            <span>Rated By</span>
                            <strong>{ratersByItem[ratedItem.id]?.length ?? 0}</strong>
                          </div>
                          {ratersByItem[ratedItem.id]?.length ? (
                            <div className="rater-chip-row">
                              {ratersByItem[ratedItem.id].map((entry) => (
                                <span key={`${ratedItem.id}_${entry.userName}`} className="rater-chip">
                                  <span>{entry.userName}</span>
                                  <strong>{entry.score.toFixed(1)}</strong>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="rater-empty">No submitted ratings for this item yet.</p>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

export default App
