/**
 * net.js — the "serverless" networking layer.
 *
 * There is no backend of ours in this file. Two things replace it:
 *
 *  1. Peer discovery (matchmaking). Trystero announces the room over public
 *     Nostr relays — free, unauthenticated WebSocket servers that anyone can
 *     read/write. Relays only carry the WebRTC handshake (SDP blobs), never
 *     your content.
 *  2. Transport. Once two peers have swapped handshakes they open a direct
 *     encrypted RTCDataChannel and send data straight to each other.
 *
 * The room is a full mesh: every peer is connected to every other peer, so
 * data does not need to be relayed between peers by any one peer.
 */
import { getRelaySockets, joinRoom, selfId } from 'trystero'
import * as Y from 'yjs'

/** Uniqueness matters: peers only meet others using the same appId. */
export const APP_ID = 'abu-farhan-collection-v1'

/**
 * Nostr relays are community infrastructure, not a contract. We pass an
 * explicit list (full wss:// URLs) so the app degrades predictably, and the
 * diagnostics panel lets users swap in their own.
 */
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social'
]

export const SYNC_ORIGIN = 'remote-yjs-update'
export const PEER_STALE_MS = 30_000

export const PALETTE = [
  '#4cc2a0', '#6ea8fe', '#f2a65a', '#e5798a', '#b78ef2',
  '#5ad1d6', '#d8c256', '#8fd36a', '#ef8fd0', '#7f8ff4'
]

/** Same string -> same colour, everywhere, with no coordination. */
export function colorFor(seed = '') {
  let hash = 0
  for (const char of String(seed)) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003
  return PALETTE[hash % PALETTE.length]
}

/**
 * @param {object} options
 * @param {Y.Doc} options.doc            the document to keep in sync
 * @param {string} options.roomId
 * @param {string} [options.appId]
 * @param {string[]} [options.relays]
 * @param {{name: string, color: string}} options.profile  this user's identity
 * @param {(peers: Map) => void} [options.onPresence]      presence changed
 * @param {(event: object) => void} [options.onEvent]      join/leave/system log
 * @param {(message: object) => void} [options.onChat]
 * @param {(peerId: string, isTyping: boolean) => void} [options.onTyping]
 * @param {(status: object) => void} [options.onStatus]
 */
export function createNetwork({
  doc,
  roomId,
  appId = APP_ID,
  relays = DEFAULT_RELAYS,
  profile,
  onPresence = () => {},
  onEvent = () => {},
  onChat = () => {},
  onTyping = () => {},
  onStatus = () => {}
}) {
  const room = joinRoom(
    {
      appId,
      // Symmetric encryption of everything that travels between peers, keyed by
      // the room code — so a public relay operator can't read the room traffic
      // even if it sees the handshake.
      password: `afc:${roomId}`,
      relayConfig: { urls: relays }
    },
    roomId
  )

  /** peerId -> { name, color, latency, lastSeen } */
  const peers = new Map()

  const setPeer = (peerId, patch) => {
    const existing = peers.get(peerId) ?? {
      id: peerId,
      name: 'Guest',
      color: colorFor(peerId),
      latency: null,
      lastSeen: Date.now()
    }
    peers.set(peerId, { ...existing, ...patch, lastSeen: Date.now() })
    onPresence(peers)
  }

  /* ------------------------------------------------------------------ *
   * 1. CRDT sync: ship Yjs updates to peers as they happen
   * ------------------------------------------------------------------ */

  const updateAction = room.makeAction('yjs-update')
  const profileAction = room.makeAction('profile')
  const chatAction = room.makeAction('chat')
  const typingAction = room.makeAction('typing')

  updateAction.onMessage = (data) => {
    // Incoming binary data arrives as an ArrayBuffer (or a view of one).
    Y.applyUpdate(doc, new Uint8Array(data), SYNC_ORIGIN)
  }

  // Local edits are broadcast to everyone; remote ones are not echoed back,
  // because the mesh already delivered them to every peer directly.
  doc.on('update', (update, origin) => {
    if (origin === SYNC_ORIGIN) return
    updateAction.send(update)
  })

  /* ------------------------------------------------------------------ *
   * 2. Presence, chat and typing — ordinary peer-to-peer actions
   * ------------------------------------------------------------------ */

  profileAction.onMessage = (data, { peerId }) =>
    setPeer(peerId, { name: data?.name ?? 'Guest', color: data?.color ?? colorFor(peerId) })

  chatAction.onMessage = (data, { peerId }) =>
    onChat({ peerId, name: peers.get(peerId)?.name ?? 'Guest', text: data?.text ?? '', at: data?.at ?? Date.now() })

  typingAction.onMessage = (data, { peerId }) => onTyping(peerId, Boolean(data?.writing))

  // On join we do two things: hand the newcomer our full document (so they
  // inherit the history) and introduce ourselves. Their side does the same for
  // us, and because CRDT merges are idempotent the overlap is harmless.
  room.onPeerJoin = (peerId) => {
    profileAction.send({ name: profile.name, color: profile.color }, { target: peerId })
    updateAction.send(Y.encodeStateAsUpdate(doc), { target: peerId })
    setPeer(peerId, {})
    onEvent({ kind: 'join', peerId })
    measureLatency(peerId)
  }

  room.onPeerLeave = (peerId) => {
    const name = peers.get(peerId)?.name ?? 'A peer'
    peers.delete(peerId)
    onPresence(peers)
    onEvent({ kind: 'leave', peerId, name })
  }

  /** Trystero can measure round-trip time on the data channel for us. */
  const measureLatency = async (peerId) => {
    try {
      const ms = await room.ping(peerId)
      if (peers.has(peerId)) setPeer(peerId, { latency: ms })
    } catch {
      /* peer vanished mid-ping */
    }
  }

  const pingTimer = setInterval(() => {
    for (const peerId of peers.keys()) measureLatency(peerId)
  }, 6000)

  /* ------------------------------------------------------------------ *
   * 3. Connection status (for the UI, not for correctness)
   * ------------------------------------------------------------------ */

  const readStatus = () => {
    let open = 0
    let total = 0
    try {
      const sockets = getRelaySockets() ?? {}
      for (const socket of Object.values(sockets)) {
        total += 1
        if (socket?.readyState === 1) open += 1
      }
    } catch {
      /* relays not initialized yet */
    }
    const connected = Object.keys(room.getPeers() ?? {}).length
    return { relaysOpen: open, relaysTotal: total, peers: connected, selfId }
  }

  const statusTimer = setInterval(() => onStatus(readStatus()), 1500)
  // Deferred so the caller can finish wiring its callbacks before the first event.
  setTimeout(() => onStatus(readStatus()), 0)

  /* ------------------------------------------------------------------ *
   * 4. Public API
   * ------------------------------------------------------------------ */

  const sendChat = (text) => {
    const payload = { text, at: Date.now() }
    chatAction.send(payload)
    return payload
  }

  let typingTimer = null
  const sendTyping = (writing) => {
    typingAction.send({ writing })
    if (writing) {
      clearTimeout(typingTimer)
      typingTimer = setTimeout(() => typingAction.send({ writing: false }), 2500)
    }
  }

  const setProfile = (patch) => Object.assign(profile, patch)

  const refreshIdentity = () => profileAction.send({ name: profile.name, color: profile.color })

  const leave = async () => {
    clearInterval(pingTimer)
    clearInterval(statusTimer)
    clearTimeout(typingTimer)
    await room.leave()
  }

  return { room, peers, sendChat, sendTyping, setProfile, refreshIdentity, leave, readStatus }
}
