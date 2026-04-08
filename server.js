import express from 'express'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const STORE_PATH = path.join(DATA_DIR, 'store.json')
const STORE_TEMP_PATH_PREFIX = path.join(DATA_DIR, 'store.json.tmp')
const DIST_DIR = path.join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 3001)
const DEFAULT_HOST_NAME = 'adam'
const DEFAULT_ACTIVITY_TYPE = 'food'
const DEFAULT_RESULTS_VISIBILITY = 'live'
const PRESENCE_TTL_MS = 15000
const PRESENCE_SWEEP_INTERVAL_MS = 5000
const REQUEST_BODY_LIMIT = '100mb'
const EVENT_TEMPLATES = {
  food: {
    title: 'Neighborhood Tasting Board',
    description: 'Run a simple LAN tasting round for dishes, desserts, snacks, or coffee.',
    itemLabelSingular: 'Dish',
    itemLabelPlural: 'Dishes',
  },
  cocktail: {
    title: 'Cocktail Flight Scoreboard',
    description: 'Set up a shared LAN board for cocktails, mocktails, bottles, or tasting flights.',
    itemLabelSingular: 'Cocktail',
    itemLabelPlural: 'Cocktails',
  },
  custom: {
    title: 'LAN Rating Session',
    description: 'Create a shared local-network rating board for any in-person event.',
    itemLabelSingular: 'Entry',
    itemLabelPlural: 'Entries',
  },
}

const app = express()
const onlineUsers = new Map()
const sseClients = new Set()
let storeWriteChain = Promise.resolve()

app.use(express.json({ limit: REQUEST_BODY_LIMIT }))

function normalizeUser(user) {
  return {
    sessionId: typeof user?.sessionId === 'string' ? user.sessionId.trim() : '',
    userId: typeof user?.userId === 'string' ? user.userId.trim() : '',
    userName: normalizeText(user?.userName),
    lastSeenAt: Number(user?.lastSeenAt) || Date.now(),
  }
}

function listOnlineUsers() {
  return Array.from(onlineUsers.values())
    .map((user) => normalizeUser(user))
    .filter((user) => user.sessionId && user.userName)
    .sort((a, b) => a.userName.localeCompare(b.userName))
}

function sendSSE(client, event, payload) {
  client.write(`event: ${event}\n`)
  client.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function broadcast(event, payload) {
  sseClients.forEach((client) => {
    sendSSE(client, event, payload)
  })
}

function broadcastPresenceSnapshot() {
  broadcast('presence', {
    onlineUsers: listOnlineUsers(),
    count: onlineUsers.size,
    sentAt: Date.now(),
  })
}

function broadcastStateChanged() {
  broadcast('state-changed', {
    sentAt: Date.now(),
  })
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

function removeStaleOnlineUsers() {
  const now = Date.now()
  let removed = false

  onlineUsers.forEach((user, sessionId) => {
    if (now - Number(user.lastSeenAt || 0) > PRESENCE_TTL_MS) {
      onlineUsers.delete(sessionId)
      removed = true
    }
  })

  if (removed) {
    broadcastPresenceSnapshot()
  }
}

function getEventTemplate(activityType) {
  return EVENT_TEMPLATES[activityType] ?? EVENT_TEMPLATES[DEFAULT_ACTIVITY_TYPE]
}

function normalizeUserName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function normalizeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeResultsVisibility(value) {
  return ['live', 'hidden', 'manual'].includes(value) ? value : DEFAULT_RESULTS_VISIBILITY
}

function getDefaultEvent(activityType = DEFAULT_ACTIVITY_TYPE) {
  const template = getEventTemplate(activityType)

  return {
    title: template.title,
    description: template.description,
    activityType,
    hostName: DEFAULT_HOST_NAME,
    customItemLabelSingular: '',
    customItemLabelPlural: '',
    resultsVisibility: DEFAULT_RESULTS_VISIBILITY,
    resultsPublished: true,
    updatedAt: Date.now(),
  }
}

function getItemLabelSingular(event) {
  if (event.activityType === 'custom') {
    return normalizeText(event.customItemLabelSingular, getEventTemplate('custom').itemLabelSingular)
  }

  return getEventTemplate(event.activityType).itemLabelSingular
}

function getItemLabelPlural(event) {
  if (event.activityType === 'custom') {
    return normalizeText(event.customItemLabelPlural, getEventTemplate('custom').itemLabelPlural)
  }

  return getEventTemplate(event.activityType).itemLabelPlural
}

function normalizeEvent(value = {}) {
  const activityType = Object.hasOwn(EVENT_TEMPLATES, value.activityType)
    ? value.activityType
    : DEFAULT_ACTIVITY_TYPE
  const template = getEventTemplate(activityType)
  const resultsVisibility = normalizeResultsVisibility(value.resultsVisibility)

  return {
    title: normalizeText(value.title, template.title),
    description: normalizeText(value.description, template.description),
    activityType,
    hostName: normalizeText(value.hostName, DEFAULT_HOST_NAME),
    customItemLabelSingular:
      activityType === 'custom'
        ? normalizeText(value.customItemLabelSingular, template.itemLabelSingular)
        : '',
    customItemLabelPlural:
      activityType === 'custom'
        ? normalizeText(value.customItemLabelPlural, template.itemLabelPlural)
        : '',
    resultsVisibility,
    resultsPublished:
      resultsVisibility === 'live'
        ? true
        : resultsVisibility === 'hidden'
          ? false
          : Boolean(value.resultsPublished),
    updatedAt: Number(value.updatedAt) || Date.now(),
  }
}

function normalizeItem(item, index, event) {
  return {
    id: normalizeText(item?.id, `item_${Date.now()}_${index}`),
    name: normalizeText(item?.name, `${getItemLabelSingular(event)} ${index + 1}`),
    image: typeof item?.image === 'string' ? item.image : '',
    uploadedBy: normalizeText(item?.uploadedBy, event.hostName),
    createdAt: Number(item?.createdAt) || Date.now(),
  }
}

function normalizeItems(items, event) {
  if (!Array.isArray(items)) {
    return []
  }

  return items.map((item, index) => normalizeItem(item, index, event))
}

function createEmptyState(activityType = DEFAULT_ACTIVITY_TYPE) {
  const event = getDefaultEvent(activityType)

  return {
    event,
    items: [],
    ratings: [],
  }
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })

  try {
    await fs.access(STORE_PATH)
  } catch {
    await fs.writeFile(STORE_PATH, JSON.stringify(createEmptyState(), null, 2))
  }
}

function dedupeRatings(ratings) {
  const latestByUserName = new Map()

  ratings.forEach((rating) => {
    const key = normalizeUserName(rating.userName)
    if (!key) return

    const current = latestByUserName.get(key)
    if (!current || Number(rating.submittedAt || 0) >= Number(current.submittedAt || 0)) {
      latestByUserName.set(key, rating)
    }
  })

  return Array.from(latestByUserName.values()).sort(
    (a, b) => Number(a.submittedAt || 0) - Number(b.submittedAt || 0),
  )
}

async function readStore() {
  await ensureStore()
  const raw = await fs.readFile(STORE_PATH, 'utf8')
  let parsed

  try {
    parsed = JSON.parse(raw)
  } catch {
    try {
      const fallbackEntries = await fs.readdir(DATA_DIR)
      const fallbackPath = fallbackEntries
        .filter((entry) => entry.startsWith(path.basename(STORE_TEMP_PATH_PREFIX)))
        .sort()
        .map((entry) => path.join(DATA_DIR, entry))
        .at(-1)

      if (!fallbackPath) {
        throw new Error('No fallback store snapshot found.')
      }

      const fallbackRaw = await fs.readFile(fallbackPath, 'utf8')
      parsed = JSON.parse(fallbackRaw)
    } catch {
      throw new Error('Shared state file is temporarily unavailable. Please retry.')
    }
  }
  const event = normalizeEvent(parsed.event)
  const rawItems = Array.isArray(parsed.items)
    ? parsed.items
    : Array.isArray(parsed.pizzas)
      ? parsed.pizzas
      : []

  return {
    event,
    items: normalizeItems(rawItems, event),
    ratings: Array.isArray(parsed.ratings) ? dedupeRatings(parsed.ratings) : [],
  }
}

async function writeStore(nextState) {
  const runWrite = async () => {
    await ensureStore()
    const event = normalizeEvent(nextState.event)
    const normalizedState = {
      event,
      items: normalizeItems(nextState.items, event),
      ratings: Array.isArray(nextState.ratings) ? dedupeRatings(nextState.ratings) : [],
    }
    const serializedState = JSON.stringify(normalizedState, null, 2)
    const tempPath = `${STORE_TEMP_PATH_PREFIX}.${process.pid}.${Date.now()}_${Math.random().toString(16).slice(2)}`

    await fs.writeFile(tempPath, serializedState)
    await fs.rename(tempPath, STORE_PATH)
    broadcastStateChanged()
    return normalizedState
  }

  const pendingWrite = storeWriteChain.then(runWrite, runWrite)
  storeWriteChain = pendingWrite.catch(() => {})
  return pendingWrite
}

function removeItemScores(ratings, itemId) {
  return ratings.map((rating) => {
    if (!rating.scores || !(itemId in rating.scores)) {
      return rating
    }

    const nextScores = { ...rating.scores }
    delete nextScores[itemId]

    return {
      ...rating,
      scores: nextScores,
    }
  })
}

function isValidScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10
}

function isHostName(requestedBy, hostName) {
  return normalizeUserName(requestedBy) === normalizeUserName(hostName || DEFAULT_HOST_NAME)
}

function getAccessInfo(req) {
  const forwardedProtocol = req.get('x-forwarded-proto')
  const protocol = forwardedProtocol ? forwardedProtocol.split(',')[0].trim() : req.protocol || 'http'
  const hostHeader = req.get('host') || `localhost:${PORT}`
  const currentOrigin = `${protocol}://${hostHeader}`
  const portMatch = hostHeader.match(/:(\d+)$/)
  const portSuffix = portMatch ? `:${portMatch[1]}` : ''

  const lanOrigins = Array.from(
    new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((network) => network && network.family === 'IPv4' && !network.internal)
        .map((network) => `${protocol}://${network.address}${portSuffix}`),
    ),
  ).filter((origin) => origin !== currentOrigin)

  return {
    currentOrigin,
    lanOrigins,
  }
}

app.get('/api/state', asyncHandler(async (_req, res) => {
  const state = await readStore()
  res.json(state)
}))

app.get('/api/access', (req, res) => {
  res.json(getAccessInfo(req))
})

app.get('/api/presence', (_req, res) => {
  removeStaleOnlineUsers()
  res.json({
    onlineUsers: listOnlineUsers(),
    count: onlineUsers.size,
  })
})

app.post('/api/presence/heartbeat', (req, res) => {
  const { sessionId, userId, userName } = req.body ?? {}
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  const normalizedUserName = normalizeText(userName)

  if (!normalizedSessionId) {
    return res.status(400).json({ message: 'Session ID is required for presence updates.' })
  }

  if (!normalizedUserName) {
    return res.status(400).json({ message: 'User name is required for presence updates.' })
  }

  removeStaleOnlineUsers()

  const now = Date.now()
  const existingUser = onlineUsers.get(normalizedSessionId)
  const isNewJoin = !existingUser

  onlineUsers.set(normalizedSessionId, {
    sessionId: normalizedSessionId,
    userId: normalizedUserId,
    userName: normalizedUserName,
    lastSeenAt: now,
  })

  if (isNewJoin) {
    broadcast('user-joined', {
      sessionId: normalizedSessionId,
      userId: normalizedUserId,
      userName: normalizedUserName,
      joinedAt: now,
      count: onlineUsers.size,
    })
  }

  broadcastPresenceSnapshot()

  res.json({
    ok: true,
    onlineUsers: listOnlineUsers(),
    count: onlineUsers.size,
  })
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  sseClients.add(res)
  sendSSE(res, 'presence', {
    onlineUsers: listOnlineUsers(),
    count: onlineUsers.size,
    sentAt: Date.now(),
  })

  const keepAliveId = setInterval(() => {
    sendSSE(res, 'ping', { sentAt: Date.now() })
  }, 20000)

  req.on('close', () => {
    clearInterval(keepAliveId)
    sseClients.delete(res)
  })
})

app.post('/api/event', asyncHandler(async (req, res) => {
  const {
    title,
    description,
    activityType,
    hostName,
    customItemLabelSingular,
    customItemLabelPlural,
    resultsVisibility,
    resultsPublished,
    requestedBy,
  } = req.body ?? {}
  const state = await readStore()

  if (!isHostName(requestedBy, state.event.hostName)) {
    return res.status(403).json({ message: 'Only the current host can update session settings.' })
  }

  if (activityType === 'custom') {
    if (!normalizeText(customItemLabelSingular)) {
      return res.status(400).json({ message: 'Custom item singular label is required.' })
    }

    if (!normalizeText(customItemLabelPlural)) {
      return res.status(400).json({ message: 'Custom item plural label is required.' })
    }
  }

  if (!normalizeText(hostName)) {
    return res.status(400).json({ message: 'Host name is required.' })
  }

  const nextEvent = normalizeEvent({
    ...state.event,
    title,
    description,
    activityType,
    hostName,
    customItemLabelSingular,
    customItemLabelPlural,
    resultsVisibility,
    resultsPublished,
    updatedAt: Date.now(),
  })
  const nextState = {
    ...state,
    event: nextEvent,
    items: normalizeItems(state.items, nextEvent),
  }

  const savedState = await writeStore(nextState)
  res.json(savedState)
}))

async function createItemHandler(req, res) {
  const { name, image, uploadedBy } = req.body ?? {}
  const state = await readStore()

  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ message: 'A base64 item image is required.' })
  }

  if (!isHostName(uploadedBy, state.event.hostName)) {
    return res.status(403).json({ message: 'Only the host can add items.' })
  }

  const nextItem = {
    id: `item_${Date.now()}`,
    name:
      typeof name === 'string' && name.trim()
        ? name.trim()
        : `${getItemLabelSingular(state.event)} ${state.items.length + 1}`,
    image,
    uploadedBy: uploadedBy.trim(),
    createdAt: Date.now(),
  }
  const nextState = {
    ...state,
    items: [nextItem, ...state.items],
  }

  const savedState = await writeStore(nextState)
  res.status(201).json(savedState)
}

async function deleteItemHandler(req, res) {
  const { itemId } = req.params
  const { requestedBy } = req.query
  const state = await readStore()

  if (!isHostName(requestedBy, state.event.hostName)) {
    return res.status(403).json({ message: 'Only the host can delete items.' })
  }

  const nextItems = state.items.filter((item) => item.id !== itemId)

  if (nextItems.length === state.items.length) {
    return res.status(404).json({ message: 'Item not found.' })
  }

  const nextState = {
    ...state,
    items: nextItems,
    ratings: removeItemScores(state.ratings, itemId),
  }

  const savedState = await writeStore(nextState)
  res.json(savedState)
}

app.post('/api/items', asyncHandler(createItemHandler))
app.post('/api/pizzas', asyncHandler(createItemHandler))

app.delete('/api/items/:itemId', asyncHandler(deleteItemHandler))
app.delete('/api/pizzas/:itemId', asyncHandler(deleteItemHandler))

app.post('/api/ratings', asyncHandler(async (req, res) => {
  const { userName, userId, scores } = req.body ?? {}

  if (typeof userName !== 'string' || !userName.trim()) {
    return res.status(400).json({ message: 'User name is required.' })
  }

  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ message: 'User ID is required.' })
  }

  if (!scores || typeof scores !== 'object') {
    return res.status(400).json({ message: 'Scores are required.' })
  }

  const state = await readStore()
  const normalizedUserName = normalizeUserName(userName)
  const existingRatingIndex = state.ratings.findIndex(
    (rating) => normalizeUserName(rating.userName) === normalizedUserName,
  )

  const itemIds = new Set(state.items.map((item) => item.id))
  const allItemsRated =
    state.items.length > 0 &&
    state.items.every((item) => {
      const score = scores[item.id]
      return isValidScore(score)
    })

  if (!allItemsRated) {
    return res.status(400).json({ message: 'Every item must be rated from 1.0 to 10.0.' })
  }

  const sanitizedScores = Object.fromEntries(
    Object.entries(scores).filter(([itemId, value]) => itemIds.has(itemId) && isValidScore(value)),
  )

  const nextRating = {
    userName: userName.trim(),
    userId: userId.trim(),
    scores: sanitizedScores,
    submittedAt: Date.now(),
  }
  const nextRatings = [...state.ratings]

  if (existingRatingIndex >= 0) {
    nextRatings[existingRatingIndex] = nextRating
  } else {
    nextRatings.push(nextRating)
  }

  const nextState = {
    ...state,
    ratings: nextRatings,
  }

  const savedState = await writeStore(nextState)
  res.status(201).json(savedState)
}))

app.delete('/api/ratings', asyncHandler(async (req, res) => {
  const { userName } = req.query

  if (typeof userName !== 'string' || !userName.trim()) {
    return res.status(400).json({ message: 'User name is required to withdraw ratings.' })
  }

  const state = await readStore()
  const normalizedUserName = normalizeUserName(userName)
  const nextRatings = state.ratings.filter(
    (rating) => normalizeUserName(rating.userName) !== normalizedUserName,
  )

  if (nextRatings.length === state.ratings.length) {
    return res.status(404).json({ message: 'No submitted rating was found for this user.' })
  }

  const nextState = {
    ...state,
    ratings: nextRatings,
  }

  const savedState = await writeStore(nextState)
  res.json(savedState)
}))

app.delete('/api/ratings/all', asyncHandler(async (req, res) => {
  const { requestedBy } = req.query
  const state = await readStore()

  if (!isHostName(requestedBy, state.event.hostName)) {
    return res.status(403).json({ message: 'Only the host can reset all ratings.' })
  }

  const nextState = {
    ...state,
    ratings: [],
  }

  const savedState = await writeStore(nextState)
  res.json(savedState)
}))

app.delete('/api/state/all', asyncHandler(async (req, res) => {
  const { requestedBy } = req.query
  const state = await readStore()

  if (!isHostName(requestedBy, state.event.hostName)) {
    return res.status(403).json({ message: 'Only the host can reset the session.' })
  }

  const nextState = {
    ...state,
    items: [],
    ratings: [],
  }

  const savedState = await writeStore(nextState)
  res.json(savedState)
}))

app.get('/api/health', asyncHandler(async (_req, res) => {
  const state = await readStore()
  res.json({
    ok: true,
    activityType: state.event.activityType,
    itemCount: state.items.length,
    ratingCount: state.ratings.length,
  })
}))

try {
  await fs.access(DIST_DIR)
  app.use(express.static(DIST_DIR))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next()
      return
    }

    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
} catch {
  // Dist is optional during development.
}

await ensureStore()
setInterval(removeStaleOnlineUsers, PRESENCE_SWEEP_INTERVAL_MS)

app.use((error, _req, res, _next) => {
  const message = error instanceof Error ? error.message : 'Internal server error.'
  console.error(error)
  res.status(500).json({ message })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RateRoom server listening on http://0.0.0.0:${PORT}`)
})
