async function request(path, options = {}) {
  let response

  try {
    response = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      ...options,
    })
  } catch {
    throw new Error(
      'API server is unavailable. Make sure the backend is running. In development, start `npm run dev:api` or `npm run dev:all`.',
    )
  }

  const text = await response.text()
  let data = null

  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }

  if (!response.ok) {
    throw new Error(data?.message || 'Request failed.')
  }

  return data
}

export function fetchSharedState() {
  return request('/api/state')
}

export function fetchAccessInfo() {
  return request('/api/access')
}

export function fetchPresence() {
  return request('/api/presence')
}

export function sendPresenceHeartbeat(payload) {
  return request('/api/presence/heartbeat', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateEvent(payload) {
  return request('/api/event', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createItem(payload) {
  return request('/api/items', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function submitRatings(payload) {
  return request('/api/ratings', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function withdrawRatings(userId, userName) {
  return request(
    `/api/ratings?userId=${encodeURIComponent(userId)}&userName=${encodeURIComponent(userName)}`,
    {
      method: 'DELETE',
    },
  )
}

export function resetAllRatings(requestedBy) {
  return request(`/api/ratings/all?requestedBy=${encodeURIComponent(requestedBy)}`, {
    method: 'DELETE',
  })
}

export function clearAllData(requestedBy) {
  return request(`/api/state/all?requestedBy=${encodeURIComponent(requestedBy)}`, {
    method: 'DELETE',
  })
}

export function deleteItem(itemId, requestedBy) {
  return request(`/api/items/${itemId}?requestedBy=${encodeURIComponent(requestedBy)}`, {
    method: 'DELETE',
  })
}
