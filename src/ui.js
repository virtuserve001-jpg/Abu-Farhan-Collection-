/**
 * ui.js — all DOM rendering. Kept apart from src/net.js and src/store.js so the
 * data layer stays testable without a browser.
 */

export const $ = (selector) => document.querySelector(selector)

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])
  )

let toastTimer = null
export function toast(message, ms = 2400) {
  const el = $('#toast')
  if (!el) return
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), ms)
}

/* ------------------------------- presence ------------------------------- */

export function renderPresence({ listEl, countEl, peers, self }) {
  const rows = [
    `<li class="self">
       <i class="dot" style="background:${escapeHtml(self.color)}"></i>
       <span class="who">${escapeHtml(self.name)} (you)</span>
       <span class="latency">local</span>
     </li>`
  ]

  for (const peer of peers.values()) {
    rows.push(`<li>
      <i class="dot" style="background:${escapeHtml(peer.color)}"></i>
      <span class="who">${escapeHtml(peer.name)}</span>
      <span class="latency">${peer.latency == null ? '—' : `${Math.round(peer.latency)} ms`}</span>
    </li>`)
  }

  listEl.innerHTML = rows.join('')
  countEl.textContent = String(peers.size + 1)
}

/* -------------------------------- catalog -------------------------------- */

export function renderCatalog({ listEl, emptyEl, datalistEl, items, categories }) {
  emptyEl.hidden = items.length > 0

  listEl.innerHTML = items
    .map(
      (item) => `<li>
        <span class="grow">
          <span class="title">${escapeHtml(item.title)}</span>
          ${item.category ? `<span class="chip">${escapeHtml(item.category)}</span>` : ''}
          <div class="meta">added by ${escapeHtml(item.addedBy)}</div>
        </span>
        <button class="remove" data-id="${escapeHtml(item.id)}" title="Remove">&times;</button>
      </li>`
    )
    .join('')

  datalistEl.innerHTML = categories
    .map((category) => `<option value="${escapeHtml(category)}"></option>`)
    .join('')
}

/* ---------------------------------- chat --------------------------------- */

export function renderChat(logEl, messages) {
  logEl.innerHTML = messages
    .slice(-200)
    .map((message) => {
      if (message.kind === 'system') return `<li class="system">${escapeHtml(message.text)}</li>`
      const name = escapeHtml(message.name ?? 'Guest')
      const time = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return `<li class="${message.self ? 'self' : ''}">
        <div class="author" style="color:${escapeHtml(message.color ?? 'inherit')}">${name}</div>
        <div>${escapeHtml(message.text)}</div>
        <div class="meta">${time}</div>
      </li>`
    })
    .join('')
  logEl.scrollTop = logEl.scrollHeight
}

/* --------------------------------- status -------------------------------- */

export function renderStatus({ badgeEl, relayEl, peerEl, status, everConnected }) {
  const { relaysOpen, relaysTotal, peers } = status

  peerEl.textContent = `peers ${peers}`
  relayEl.textContent = `relays ${relaysOpen}/${relaysTotal || 0}`

  let label = 'connecting…'
  let tone = 'warn'

  if (peers > 0) {
    label = `connected · ${peers} peer${peers === 1 ? '' : 's'}`
    tone = 'ok'
  } else if (relaysOpen > 0) {
    label = everConnected ? 'alone right now' : 'online — open a second tab or share the link'
    tone = everConnected ? 'ok' : 'warn'
  } else if (relaysTotal > 0) {
    label = 'relays unreachable — try different relay URLs'
    tone = 'bad'
  }

  badgeEl.textContent = label
  badgeEl.className = `badge ${tone}`
}

export function renderDiagnostics({ selfId, status, storageRooms, relayUrls }) {
  $('#diag-self').textContent = selfId ?? '–'
  $('#diag-relays').textContent = `${status.relaysOpen} open / ${status.relaysTotal} configured`
  $('#diag-peers').textContent = String(status.peers)
  $('#diag-storage').textContent = storageRooms.length ? storageRooms.join(', ') : 'none yet'
  const relayInput = $('#relay-input')
  if (relayInput && document.activeElement !== relayInput) relayInput.value = relayUrls.join(', ')
}
