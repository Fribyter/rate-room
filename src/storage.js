const USER_KEY = 'rateroom_user'
const LEGACY_USER_KEY = 'pizza_app_user'

function readJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

export const storageKeys = {
  user: USER_KEY,
  legacyUser: LEGACY_USER_KEY,
}

export function getStoredUser() {
  const storedUser = readJson(USER_KEY, null)
  if (storedUser) {
    return storedUser
  }

  const legacyStoredUser = readJson(LEGACY_USER_KEY, null)

  if (legacyStoredUser) {
    try {
      writeJson(USER_KEY, legacyStoredUser)
      window.localStorage.removeItem(LEGACY_USER_KEY)
    } catch {
      return legacyStoredUser
    }
  }

  return legacyStoredUser
}

export function setStoredUser(user) {
  writeJson(USER_KEY, user)
}
