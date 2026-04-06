import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.join(__dirname, 'data')
const STORE_PATH = path.join(DATA_DIR, 'store.json')
const DIST_DIR = path.join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 3001)

const app = express()

app.use(express.json({ limit: '10mb' }))

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true })

  try {
    await fs.access(STORE_PATH)
  } catch {
    const initialState = { pizzas: [], ratings: [] }
    await fs.writeFile(STORE_PATH, JSON.stringify(initialState, null, 2))
  }
}

async function readStore() {
  await ensureStore()
  const raw = await fs.readFile(STORE_PATH, 'utf8')
  const parsed = JSON.parse(raw)

  return {
    pizzas: Array.isArray(parsed.pizzas) ? parsed.pizzas : [],
    ratings: Array.isArray(parsed.ratings) ? dedupeRatings(parsed.ratings) : [],
  }
}

async function writeStore(nextState) {
  await ensureStore()
  const normalizedState = {
    pizzas: Array.isArray(nextState.pizzas) ? nextState.pizzas : [],
    ratings: Array.isArray(nextState.ratings) ? dedupeRatings(nextState.ratings) : [],
  }
  await fs.writeFile(STORE_PATH, JSON.stringify(normalizedState, null, 2))
}

function removePizzaScores(ratings, pizzaId) {
  return ratings.map((rating) => {
    if (!rating.scores || !(pizzaId in rating.scores)) {
      return rating
    }

    const nextScores = { ...rating.scores }
    delete nextScores[pizzaId]

    return {
      ...rating,
      scores: nextScores,
    }
  })
}

function isValidScore(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10
}

function normalizeUserName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
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

app.get('/api/state', async (_req, res) => {
  const state = await readStore()
  res.json(state)
})

app.post('/api/pizzas', async (req, res) => {
  const { name, image, uploadedBy } = req.body ?? {}

  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ message: 'A base64 pizza image is required.' })
  }

  if (normalizeUserName(uploadedBy) !== 'adam') {
    return res.status(403).json({ message: 'Only admin can upload pizzas.' })
  }

  const state = await readStore()
  const nextPizza = {
    id: `pizza_${Date.now()}`,
    name: typeof name === 'string' && name.trim() ? name.trim() : `Pizza ${state.pizzas.length + 1}`,
    image,
    uploadedBy: uploadedBy.trim(),
    createdAt: Date.now(),
  }

  const nextState = {
    ...state,
    pizzas: [nextPizza, ...state.pizzas],
  }

  await writeStore(nextState)
  res.status(201).json(nextState)
})

app.delete('/api/pizzas/:pizzaId', async (req, res) => {
  const { pizzaId } = req.params
  const { requestedBy } = req.query

  if (normalizeUserName(requestedBy) !== 'adam') {
    return res.status(403).json({ message: 'Only admin can delete pizzas.' })
  }

  const state = await readStore()
  const nextPizzas = state.pizzas.filter((pizza) => pizza.id !== pizzaId)

  if (nextPizzas.length === state.pizzas.length) {
    return res.status(404).json({ message: 'Pizza not found.' })
  }

  const nextState = {
    pizzas: nextPizzas,
    ratings: removePizzaScores(state.ratings, pizzaId),
  }

  await writeStore(nextState)
  res.json(nextState)
})

app.post('/api/ratings', async (req, res) => {
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

  const pizzaIds = new Set(state.pizzas.map((pizza) => pizza.id))
  const allPizzasRated =
    state.pizzas.length > 0 &&
    state.pizzas.every((pizza) => {
      const score = scores[pizza.id]
      return isValidScore(score)
    })

  if (!allPizzasRated) {
    return res.status(400).json({ message: 'Every pizza must be rated from 1.0 to 10.0.' })
  }

  const sanitizedScores = Object.fromEntries(
    Object.entries(scores).filter(([pizzaId, value]) => pizzaIds.has(pizzaId) && isValidScore(value)),
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

  await writeStore(nextState)
  res.status(201).json(nextState)
})

app.delete('/api/ratings', async (req, res) => {
  const { userId, userName } = req.query

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

  await writeStore(nextState)
  res.json(nextState)
})

app.delete('/api/ratings/all', async (req, res) => {
  const { requestedBy } = req.query

  if (normalizeUserName(requestedBy) !== 'adam') {
    return res.status(403).json({ message: 'Only admin can reset all ratings.' })
  }

  const state = await readStore()
  const nextState = {
    ...state,
    ratings: [],
  }

  await writeStore(nextState)
  res.json(nextState)
})

app.delete('/api/state/all', async (req, res) => {
  const { requestedBy } = req.query

  if (normalizeUserName(requestedBy) !== 'adam') {
    return res.status(403).json({ message: 'Only admin can clear all shared data.' })
  }

  const nextState = {
    pizzas: [],
    ratings: [],
  }

  await writeStore(nextState)
  res.json(nextState)
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RateRoom server listening on http://0.0.0.0:${PORT}`)
})
