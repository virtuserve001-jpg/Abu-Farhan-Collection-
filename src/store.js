/**
 * store.js — the shared data layer.
 *
 * Everything the users share lives in a single Yjs document. Yjs is a CRDT
 * (conflict-free replicated data type): every browser keeps a full copy and
 * applies every edit locally. Because the merge rules are deterministic, two
 * peers that saw the same set of edits — in *any* order — end up byte-identical.
 * Nothing has to be resolved by a server, so there is no server.
 *
 * This module is deliberately DOM-free so it can be unit-tested in plain Node.
 */
import * as Y from 'yjs'

export const STORAGE_PREFIX = 'afc:v1'

/** Create a stable-ish id without any server round-trip. */
export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/* ------------------------------------------------------------------ *
 * Binary <-> base64 helpers so a Yjs update can be kept in localStorage.
 * ------------------------------------------------------------------ */

export const bytesToBase64 = (bytes) => {
  if (typeof btoa === 'function') {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString('base64')
}

export const base64ToBytes = (text) => {
  if (typeof atob === 'function') {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/**
 * @param {string} roomId       which room's data we are editing
 * @param {object} [options]
 * @param {Storage|null} [options.storage] localStorage-alike (optional)
 * @param {number} [options.saveDebounceMs] how long to wait before persisting
 */
export function createStore(roomId, { storage = globalThis.localStorage, saveDebounceMs = 400 } = {}) {
  const doc = new Y.Doc()

  /** catalog: id -> Y.Map({ title, category, addedBy, createdAt }) */
  const catalog = doc.getMap('catalog')
  /** notes: one collaborative text document */
  const notes = doc.getText('notes')

  const storageKey = `${STORAGE_PREFIX}:doc:${roomId}`
  const listeners = new Set()
  let saveTimer = null

  const emit = () => listeners.forEach((fn) => fn())
  const storageAvailable = Boolean(storage)

  // 1. Restore whatever this browser already knows about the room.
  if (storageAvailable) {
    try {
      const saved = storage.getItem(storageKey)
      if (saved) Y.applyUpdate(doc, base64ToBytes(saved), 'storage')
    } catch (error) {
      console.warn('could not restore saved room state', error)
    }
  }

  // 2. Persist on every change (debounced). Local edits *and* edits that
  //    arrive from peers both land here, which is how a late joiner inherits
  //    history even when the peer who typed it has already left.
  const scheduleSave = () => {
    if (!storageAvailable) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        storage.setItem(storageKey, bytesToBase64(Y.encodeStateAsUpdate(doc)))
      } catch (error) {
        console.warn('could not persist room state', error)
      }
    }, saveDebounceMs)
  }

  doc.on('update', () => {
    scheduleSave()
    emit()
  })

  // Also surface remote-only structural changes (cheap, keeps observers simple).
  catalog.observeDeep(emit)
  notes.observe(emit)

  /* --------------------------- catalog API --------------------------- */

  const addItem = ({ title, category = '', addedBy = 'anon' }) => {
    const item = new Y.Map()
    doc.transact(() => {
      item.set('title', String(title).trim().slice(0, 120))
      item.set('category', String(category).trim().slice(0, 32))
      item.set('addedBy', addedBy)
      item.set('createdAt', Date.now())
      catalog.set(newId(), item)
    })
    return true
  }

  const removeItem = (id) => catalog.delete(id)

  /** Catalog as a plain, sorted array for rendering. */
  const listItems = () =>
    [...catalog.entries()]
      .map(([id, item]) => ({
        id,
        title: item.get('title') ?? '',
        category: item.get('category') ?? '',
        addedBy: item.get('addedBy') ?? 'anon',
        createdAt: item.get('createdAt') ?? 0
      }))
      .sort((a, b) => a.createdAt - b.createdAt)

  const categories = () =>
    [...new Set(listItems().map((item) => item.category).filter(Boolean))].sort()

  /* ---------------------------- notes API ---------------------------- */

  const getNotes = () => notes.toString()

  /** Replace the whole note body but only touch the characters that differ. */
  const setNotes = (text) => {
    const current = notes.toString()
    if (current === text) return
    let start = 0
    while (start < current.length && current[start] === text[start]) start += 1
    let endCurrent = current.length
    let endNext = text.length
    while (endCurrent > start && endNext > start && current[endCurrent - 1] === text[endNext - 1]) {
      endCurrent -= 1
      endNext -= 1
    }
    doc.transact(() => {
      if (endCurrent > start) notes.delete(start, endCurrent - start)
      if (endNext > start) notes.insert(start, text.slice(start, endNext))
    })
  }

  /* ------------------------- sync helpers --------------------------- */

  /** Full document state, to hand to a peer that just joined. */
  const encodeState = () => Y.encodeStateAsUpdate(doc)

  /** Merge a remote update. Origin is tagged so we don't echo it back out. */
  const applyRemoteUpdate = (update, origin) => Y.applyUpdate(doc, update, origin)

  const onChange = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  const clearStorage = () => {
    try {
      storage?.removeItem(storageKey)
    } catch {
      /* ignore */
    }
  }

  const stats = () => ({
    storageKey,
    items: catalog.size,
    noteLength: notes.length,
    bytes: Y.encodeStateAsUpdate(doc).byteLength
  })

  return {
    doc,
    roomId,
    storageKey,
    addItem,
    removeItem,
    listItems,
    categories,
    getNotes,
    setNotes,
    encodeState,
    applyRemoteUpdate,
    onChange,
    clearStorage,
    stats
  }
}

/** Which rooms this device has cached data for (used in the diagnostics panel). */
export function savedRooms(storage = globalThis.localStorage) {
  if (!storage) return []
  const rooms = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key?.startsWith(`${STORAGE_PREFIX}:doc:`)) rooms.push(key.split(':doc:')[1])
  }
  return rooms.sort()
}
