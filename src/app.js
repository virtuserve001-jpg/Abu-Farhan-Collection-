/**
 * app.js — entry point. Wires the CRDT store, the peer-to-peer network and the
 * DOM together. Read this file last: it shows how the pieces fit.
 */
import { createStore, savedRooms } from './store.js'
import { createNetwork, colorFor, DEFAULT_RELAYS, APP_ID } from './net.js'
import {
  $,
  renderCatalog,
  renderChat,
  renderDiagnostics,
  renderPresence,
  renderStatus,
  toast
} from './ui.js'

/* ---------------------------- room + identity ---------------------------- */

const ROOM_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
const randomRoom = () =>
  Array.from({ length: 6 }, () => ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)]).join('')

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''))
  return {
    room: (params.get('room') || '').trim(),
    name: (params.get('name') || '').trim(),
    relays: (params.get('relays') || '').trim()
  }
}

function writeHash({ room, name, relays }) {
  const params = new URLSearchParams()
  params.set('room', room)
  if (name) params.set('name', name)
  if (relays) params.set('relays', relays)
  location.hash = params.toString()
}

const fromHash = readHash()
const roomId = (fromHash.room || randomRoom()).toLowerCase()
const myName = fromHash.name || localStorage.getItem('afc:name') || `Guest ${Math.floor(1000 + Math.random() * 8999)}`
const relayUrls = (fromHash.relays ? fromHash.relays.split(',') : DEFAULT_RELAYS)
  .map((url) => url.trim())
  .filter(Boolean)

writeHash({ room: roomId, name: myName, relays: fromHash.relays })
localStorage.setItem('afc:name', myName)

const me = { name: myName, color: colorFor(myName + roomId) }

/* -------------------------------- the state ------------------------------- */

const store = createStore(roomId)
const chatMessages = []
const typingPeers = new Map()
let everConnected = false

/* ------------------------------ render helpers ---------------------------- */

const refresh = () => {
  renderCatalog({
    listEl: $('#catalog-list'),
    emptyEl: $('#catalog-empty'),
    datalistEl: $('#categories'),
    items: store.listItems(),
    categories: store.categories()
  })
  renderPresence({ listEl: $('#presence-list'), countEl: $('#presence-count'), peers: network.peers, self: me })
  renderDiagnostics({
    selfId: network.readStatus().selfId,
    status: network.readStatus(),
    storageRooms: savedRooms(),
    relayUrls
  })
}

/* ------------------------------ the network ------------------------------ */

const network = createNetwork({
  doc: store.doc,
  roomId,
  relays: relayUrls,
  profile: me,

  onPresence: () => {
    if (network.peers.size > 0) everConnected = true
    renderPresence({
      listEl: $('#presence-list'),
      countEl: $('#presence-count'),
      peers: network.peers,
      self: me
    })
  },

  onEvent: ({ kind, name }) => {
    if (kind === 'join') chatMessages.push({ kind: 'system', text: 'A peer connected.' })
    if (kind === 'leave') chatMessages.push({ kind: 'system', text: `${name ?? 'A peer'} left.` })
    renderChat($('#chat-log'), chatMessages)
  },

  onChat: (message) => {
    chatMessages.push({ ...message, color: network.peers.get(message.peerId)?.color })
    renderChat($('#chat-log'), chatMessages)
  },

  onTyping: (peerId, isWriting) => {
    if (isWriting) typingPeers.set(peerId, Date.now())
    else typingPeers.delete(peerId)
    renderTyping()
  },

  onStatus: (status) => {
    if (status.peers > 0) everConnected = true
    renderStatus({
      badgeEl: $('#status-badge'),
      relayEl: $('#relay-badge'),
      peerEl: $('#peer-badge'),
      status,
      everConnected
    })
    renderDiagnostics({
      selfId: status.selfId,
      status,
      storageRooms: savedRooms(),
      relayUrls
    })
  }
})

/* ------------------------------ notes editor ----------------------------- */

const notesEl = $('#notes')
notesEl.value = store.getNotes()

const pullNotes = () => {
  const text = store.getNotes()
  if (notesEl.value === text) return

  const previous = notesEl.value
  const focused = document.activeElement === notesEl
  const caret = notesEl.selectionStart

  notesEl.value = text

  if (focused) {
    // Remote edits shift the text under the caret. If the part before the caret
    // is untouched, keep the caret relative to it; otherwise fall back to the end.
    let common = 0
    const limit = Math.min(previous.length, text.length)
    while (common < limit && previous[common] === text[common]) common += 1

    let offset = caret > common ? caret + (text.length - previous.length) : caret
    offset = Math.max(0, Math.min(offset, text.length))
    notesEl.setSelectionRange(offset, offset)
  }
}

let typingSentAt = 0
notesEl.addEventListener('input', () => {
  store.setNotes(notesEl.value)
  const now = Date.now()
  if (now - typingSentAt > 900) {
    typingSentAt = now
    network.sendTyping(true)
  }
})

const renderTyping = () => {
  const names = [...typingPeers.keys()]
    .map((peerId) => network.peers.get(peerId)?.name)
    .filter(Boolean)
  $('#typing').textContent = names.length
    ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…`
    : ''
}

let refreshQueued = false
const scheduleRefresh = () => {
  if (refreshQueued) return
  refreshQueued = true
  queueMicrotask(() => {
    refreshQueued = false
    refresh()
    pullNotes()
  })
}

/* --------------------------------- catalog -------------------------------- */

$('#item-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const title = $('#item-title').value.trim()
  if (!title) return
  store.addItem({ title, category: $('#item-category').value, addedBy: me.name })
  $('#item-title').value = ''
  $('#item-title').focus()
})

$('#catalog-list').addEventListener('click', (event) => {
  const id = event.target.closest('.remove')?.dataset.id
  if (id) store.removeItem(id)
})

// Registered after the network exists, because refresh() reads peer state.
store.onChange(scheduleRefresh)

/* ---------------------------------- chat ---------------------------------- */

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  const payload = network.sendChat(text)
  chatMessages.push({ ...payload, name: me.name, color: me.color, self: true })
  input.value = ''
  renderChat($('#chat-log'), chatMessages)
})

/* --------------------------------- chrome --------------------------------- */

$('#room-input').value = roomId
$('#name-input').value = myName
$('#self-dot').style.background = me.color

$('#join-btn').addEventListener('click', () => {
  const next = $('#room-input').value.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '') || randomRoom()
  writeHash({ room: next, name: $('#name-input').value.trim(), relays: fromHash.relays })
  location.reload()
})

$('#share-btn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#room=${encodeURIComponent(roomId)}`
  try {
    await navigator.clipboard.writeText(url)
    toast('Invite link copied — send it to anyone.')
  } catch {
    toast(url, 6000)
  }
})

$('#name-input').addEventListener('change', () => {
  const next = $('#name-input').value.trim().slice(0, 24) || me.name
  me.name = next
  me.color = colorFor(next + roomId)
  $('#self-dot').style.background = me.color
  localStorage.setItem('afc:name', next)
  network.setProfile({ name: next, color: me.color })
  network.refreshIdentity()
  writeHash({ room: roomId, name: next, relays: fromHash.relays })
  refresh()
})

$('#leave-btn').addEventListener('click', async () => {
  await network.leave()
  $('#status-badge').textContent = 'disconnected — reload to rejoin'
  $('#status-badge').className = 'badge bad'
  toast('Left the room. Your copy of the data stays in this browser.')
})

$('#relay-input')?.addEventListener('change', () => {
  const relays = $('#relay-input').value.split(',').map((url) => url.trim()).filter(Boolean)
  if (!relays.length) return
  writeHash({ room: roomId, name: me.name, relays: relays.join(',') })
  location.reload()
})

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('active', other === tab))
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `panel-${tab.dataset.tab}`)
    })
  })
})

window.addEventListener('beforeunload', () => {
  network.leave()
})

/* --------------------------------- first run ------------------------------- */

refresh()
renderChat($('#chat-log'), chatMessages)
console.info(`[${APP_ID}] joined room "${roomId}" as ${me.name}`)

if (network.peers.size === 0) {
  setTimeout(() => {
    if (!everConnected) toast('Tip: open this URL in a second tab, or send the invite link to a friend.', 5200)
  }, 2500)
}
