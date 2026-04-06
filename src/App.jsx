import { useEffect, useMemo, useState } from 'react'
import {
  clearAllData,
  createPizza,
  deletePizza,
  fetchSharedState,
  resetAllRatings,
  submitRatings,
  withdrawRatings,
} from './api'
import { getStoredUser, setStoredUser, storageKeys } from './storage'

const ADMIN_NAME = 'adam'
const MAX_IMAGE_SIZE = 2 * 1024 * 1024
const POLL_INTERVAL_MS = 4000
const SUBMITTING_OVERLAY_MS = 2000

function normalizeUserName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function createUser(name) {
  const normalizedName = name.trim()
  return {
    id: `${normalizedName}_${Date.now()}`,
    name: normalizedName,
    role: normalizeUserName(normalizedName) === ADMIN_NAME ? 'admin' : 'participant',
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

function computeSummary(pizzas, ratings) {
  const summary = pizzas.map((pizza) => {
    let totalScore = 0
    let voteCount = 0

    ratings.forEach((rating) => {
      const score = rating.scores[pizza.id]
      if (typeof score === 'number') {
        totalScore += score
        voteCount += 1
      }
    })

    return {
      pizzaId: pizza.id,
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

function App() {
  const [user, setUser] = useState(() => getStoredUser())
  const [pizzas, setPizzas] = useState([])
  const [ratings, setRatings] = useState([])
  const [pendingName, setPendingName] = useState('')
  const [draftScores, setDraftScores] = useState({})
  const [pizzaName, setPizzaName] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const existingRating = useMemo(() => {
    if (!user) return null
    return ratings.find((item) => normalizeUserName(item.userName) === normalizeUserName(user.name)) ?? null
  }, [ratings, user])

  const hasSubmitted =
    Boolean(existingRating) &&
    pizzas.length > 0 &&
    pizzas.every((pizza) => {
      const score = existingRating?.scores?.[pizza.id]
      return isValidScore(score)
    })
  const summary = useMemo(() => computeSummary(pizzas, ratings), [pizzas, ratings])
  const ratedCount = pizzas.filter((pizza) => isValidScore(draftScores[pizza.id])).length
  const remainingToSubmit = Math.max(pizzas.length - ratedCount, 0)
  const canSubmit =
    pizzas.length > 0 &&
    pizzas.every((pizza) => isValidScore(draftScores[pizza.id])) &&
    !hasSubmitted

  async function refreshSharedState({ silent = false } = {}) {
    if (!silent) {
      setLoading(true)
    }

    try {
      const nextState = await fetchSharedState()
      setPizzas(nextState.pizzas)
      setRatings(nextState.ratings)
      if (!silent) {
        setError('')
      }
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    refreshSharedState()
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      refreshSharedState({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (existingRating) {
      setDraftScores(existingRating.scores)
      return
    }

    setDraftScores((current) => {
      const next = {}
      pizzas.forEach((pizza) => {
        next[pizza.id] = isValidScore(current[pizza.id]) ? current[pizza.id] : 5
      })
      return next
    })
  }, [existingRating, pizzas])

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

  async function handleUpload(event) {
    event.preventDefault()
    if (!selectedFile || !user) {
      setError('Please choose a pizza image.')
      return
    }

    if (selectedFile.size > MAX_IMAGE_SIZE) {
      setError('Image size must be 2MB or smaller.')
      return
    }

    if (!selectedFile.type.startsWith('image/')) {
      setError('Only image files are supported.')
      return
    }

    setUploading(true)
    setError('')

    try {
      const image = await fileToBase64(selectedFile)
      const nextState = await createPizza({
        name: pizzaName.trim(),
        image,
        uploadedBy: user.name,
      })

      setPizzas(nextState.pizzas)
      setRatings(nextState.ratings)
      setPizzaName('')
      setSelectedFile(null)
      event.target.reset()
    } catch (uploadError) {
      setError(uploadError.message)
    } finally {
      setUploading(false)
    }
  }

  function handleScoreChange(pizzaId, value) {
    setDraftScores((current) => ({
      ...current,
      [pizzaId]: Number(value),
    }))
  }

  async function handleSubmitScores() {
    if (!user || !canSubmit) {
      setError('Please score every pizza before submitting.')
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

      setRatings(nextState.ratings)
      setPizzas(nextState.pizzas)
      setError('')
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeletePizza(pizzaId) {
    const pizzaToDelete = pizzas.find((pizza) => pizza.id === pizzaId)
    if (!pizzaToDelete || !user) return

    const confirmed = window.confirm(`Delete "${pizzaToDelete.name}"? This will also remove its scores.`)
    if (!confirmed) return

    try {
      const nextState = await deletePizza(pizzaId, user.name)
      setPizzas(nextState.pizzas)
      setRatings(nextState.ratings)
      setDraftScores((current) => {
        const nextDraftScores = { ...current }
        delete nextDraftScores[pizzaId]
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
      setRatings(nextState.ratings)
      setPizzas(nextState.pizzas)
      setDraftScores((current) => {
        const nextDraftScores = {}
        pizzas.forEach((pizza) => {
          nextDraftScores[pizza.id] = isValidScore(current[pizza.id]) ? current[pizza.id] : 5
        })
        return nextDraftScores
      })
      setError('')
    } catch (withdrawError) {
      setError(withdrawError.message)
    }
  }

  async function handleResetAllRatings() {
    if (!user) return

    const confirmed = window.confirm('Reset all submitted ratings for every user? Pizza images will be kept.')
    if (!confirmed) return

    try {
      const nextState = await resetAllRatings(user.name)
      setRatings(nextState.ratings)
      setPizzas(nextState.pizzas)
      setDraftScores((current) => {
        const nextDraftScores = {}
        nextState.pizzas.forEach((pizza) => {
          nextDraftScores[pizza.id] = isValidScore(current[pizza.id]) ? current[pizza.id] : 5
        })
        return nextDraftScores
      })
      setError('')
    } catch (resetError) {
      setError(resetError.message)
    }
  }

  async function handleClearAllData() {
    if (!user) return

    const confirmed = window.confirm(
      'Clear all shared data? This will permanently remove every pizza and every submitted rating.',
    )
    if (!confirmed) return

    try {
      const nextState = await clearAllData(user.name)
      setPizzas(nextState.pizzas)
      setRatings(nextState.ratings)
      setDraftScores({})
      setPizzaName('')
      setSelectedFile(null)
      setError('')
    } catch (clearError) {
      setError(clearError.message)
    }
  }

  function handleResetIdentity() {
    window.localStorage.removeItem(storageKeys.user)
    window.localStorage.removeItem(storageKeys.legacyUser)
    setUser(null)
    setPendingName('')
  }

  const showResults = pizzas.length > 0 && ratings.length > 0

  return (
    <div className="app-shell">
      {!user && (
        <div className="modal-backdrop">
          <form className="name-modal" onSubmit={handleEnterApp}>
            <div className="modal-orb" aria-hidden="true" />
            <p className="eyebrow">RateRoom</p>
            <h1>Enter Your Name</h1>
            <p className="muted">Type adam to enter as admin. Any other name joins as a participant.</p>
            <input
              autoFocus
              value={pendingName}
              onChange={(event) => setPendingName(event.target.value)}
              placeholder="For example: adam / tom"
            />
            <button type="submit" disabled={!pendingName.trim()}>
              Enter App
            </button>
            {error && <p className="error-text">{error}</p>}
          </form>
        </div>
      )}

      <header className="hero">
        <div className="hero-copy-block">
          <p className="eyebrow">RateRoom</p>
          <h1>Shared Pizza Rating Hub</h1>
          <p className="hero-copy">
            RateRoom lets everyone on the local network join the same pizza tasting round, submit scores, and watch the shared leaderboard update together.
          </p>
          <div className="hero-badges">
            <span className="hero-badge">{pizzas.length} pizzas</span>
            <span className="hero-badge">{ratings.length} submitted ballots</span>
            <span className="hero-badge">Live LAN sync</span>
          </div>
        </div>
        {user && (
          <div className="user-panel">
            <div>
              <p className="panel-label">Current User</p>
              <strong>{user.name}</strong>
            </div>
            <div>
              <p className="panel-label">Role</p>
              <strong>{user.role}</strong>
            </div>
            <button type="button" className="ghost-button" onClick={handleResetIdentity}>
              Switch User
            </button>
          </div>
        )}
      </header>

      {user?.role === 'admin' && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Admin Only</p>
              <h2>Upload Pizza Images</h2>
            </div>
            <p className="muted">Supports jpg / png / jpeg / webp, up to 2MB per image.</p>
          </div>
          <div className="upload-shell">
            <form className="upload-form" onSubmit={handleUpload}>
              <input
                value={pizzaName}
                onChange={(event) => setPizzaName(event.target.value)}
                placeholder="Pizza name, for example Pepperoni"
              />
              <input
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <button type="submit" disabled={uploading || !selectedFile}>
                {uploading ? 'Uploading...' : 'Upload Pizza'}
              </button>
            </form>
            <div className="upload-accent-card">
              <p className="eyebrow">Art Direction</p>
              <h3>Make each pizza irresistible</h3>
              <p>
                Use bright lighting, close crops, and one strong hero angle so the leaderboard feels like a real food battle.
              </p>
            </div>
          </div>
          <div className="panel-footnote">
            <span>Tip</span>
            Bright, close-up images tend to perform better in voting because the cards stay readable on mobile.
          </div>
          <div className="admin-actions">
            <button type="button" className="danger-button" onClick={handleResetAllRatings}>
              Reset All Ratings
            </button>
            <button type="button" className="danger-button strong-danger-button" onClick={handleClearAllData}>
              Clear All Data
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
            <p>Your pizza is being sliced and plated while we save the shared results.</p>
          </div>
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>Rate the Pizzas</h2>
          </div>
          {hasSubmitted ? (
            <p className="success-text">You have already submitted your ratings. You can withdraw them and resubmit at any time.</p>
          ) : existingRating ? (
            <p className="muted">New pizzas were added after your last submission. Please rate the new items and submit again.</p>
          ) : loading ? (
            <p className="muted">Loading shared pizzas and ratings...</p>
          ) : (
            <p className="muted">Rate every pizza from 1 to 10 before submitting.</p>
          )}
        </div>
            <div className="status-strip">
          <span className="status-chip">{user?.role === 'admin' ? 'Admin mode' : 'Participant mode'}</span>
          <span className="status-chip">{pizzas.length} pizzas in the round</span>
          <span className="status-chip">{ratings.length} shared submissions</span>
        </div>

        {loading && pizzas.length === 0 ? (
          <div className="empty-state">
            <h3>Loading shared data</h3>
            <p>Please wait while the app connects to the host device.</p>
          </div>
        ) : pizzas.length === 0 ? (
          <div className="empty-state">
            <h3>No pizza images yet</h3>
            <p>Please wait for the admin to upload pizzas before rating.</p>
          </div>
        ) : (
          <>
            <div className="pizza-grid">
              {pizzas.map((pizza) => {
                const currentScore = draftScores[pizza.id] ?? 5
                return (
                  <article key={pizza.id} className="pizza-card">
                    <div className="pizza-visual">
                      <img src={pizza.image} alt={pizza.name} className="pizza-image" />
                      <div className="pizza-overlay">
                        <div>
                          <p className="pizza-kicker">Community Pick</p>
                          <h3>{pizza.name}</h3>
                          <p>Uploaded by: {pizza.uploadedBy}</p>
                        </div>
                        <span className="score-pill">{currentScore.toFixed(1)} pts</span>
                      </div>
                    </div>
                    <div className="pizza-meta">
                      <p className="meter-caption">Your current rating: {currentScore.toFixed(1)} / 10</p>
                    </div>
                    {user?.role === 'admin' && (
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => handleDeletePizza(pizza.id)}
                      >
                        Delete Pizza
                      </button>
                    )}
                    <label className="slider-label" htmlFor={pizza.id}>
                      Slide to rate
                    </label>
                    <input
                      id={pizza.id}
                      className="rating-slider"
                      type="range"
                      min="1"
                      max="10"
                      step="0.1"
                      value={currentScore}
                      disabled={hasSubmitted}
                      onChange={(event) => handleScoreChange(pizza.id, event.target.value)}
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
                {pizzas.length > 0
                  ? `Completed ${ratedCount} / ${pizzas.length} ratings`
                  : 'There are no pizzas available to rate right now.'}
              </p>
            </div>
          </>
        )}
      </section>

      {showResults && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>Score Summary</h2>
            </div>
            <p className="muted">Ranking rule: average score first, then vote count, then total score.</p>
          </div>

          {summary.length === 0 ? (
            <div className="empty-state">
              <h3>No summary available yet</h3>
              <p>At least one pizza and one submitted rating are required.</p>
            </div>
          ) : (
            <div className="results-list">
              {summary.map((item) => {
                const pizza = pizzas.find((entry) => entry.id === item.pizzaId)
                if (!pizza) return null

                return (
                  <article
                    key={item.pizzaId}
                    className={`result-card ${item.rank === 1 ? 'winner-card' : ''} ${item.rank <= 3 ? `podium-card podium-${item.rank}` : ''}`}
                  >
                    <img src={pizza.image} alt={pizza.name} className="result-image" />
                    <div className="result-content">
                      <div className="result-topline">
                        <span className="rank-badge">#{item.rank}</span>
                        {item.rank === 1 && <span className="winner-badge">Most Popular Pizza</span>}
                      </div>
                      <h3>{pizza.name}</h3>
                      <div className="result-stat-grid">
                        <div className="result-stat">
                          <span>Average</span>
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
