// Personal build published as a claude.ai artifact (VITE_LOCAL=1).
//
// The artifact viewer gives the page two things a plain static host cannot:
// - `db`: a store on the server where each signed-in viewer has a private subtree
//   (data/users/<id>/…). The profile is mirrored there, so it survives cleared browser data and
//   follows the owner to another device. Two devices that both changed it are merged with the
//   app's own field-by-field merge (lib/sync-merge.js), the same one the server sync uses.
// - `downloads`: the viewer refuses <a download>, so the app's backup and plan exports are handed
//   to the host's save prompt instead.
// Outside that viewer (no window.claude, or every capability null) all of this stays idle and
// the app is a plain browser-only copy.
import { mergeStates } from './sync-merge.js'

const CHUNK = 60000                 // characters per document; a document caps at 256 KiB
const GEN_KEY = 'og_cloud_gen'      // the stored generation this browser last held
const PUSH_DELAY = 4000

const capability = name => {
  const c = typeof window !== 'undefined' ? window.claude : null
  if (!c || typeof c.use !== 'function') return Promise.resolve(null)
  return c.use(name).catch(() => null)
}

const toast = msg => import('../store/useUI.js').then(({ useUI }) => useUI.getState().toast(msg)).catch(() => {})

/* ------------------------------------------------------------------ saves */

// Blobs handed to URL.createObjectURL, kept until the save prompt has them: every export in the
// app revokes its URL right after click().
const blobs = new Map()

export function installSaves() {
  if (typeof window === 'undefined' || !window.claude) return
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  URL.createObjectURL = obj => {
    const u = create(obj)
    if (obj instanceof Blob) blobs.set(u, obj)
    return u
  }
  URL.revokeObjectURL = u => { setTimeout(() => blobs.delete(u), 120000); return revoke(u) }
  const click = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !blobs.has(this.href)) return click.call(this)
    const data = blobs.get(this.href), filename = this.download
    capability('downloads').then(async dl => {
      if (!dl) { toast('Saving files is not available here'); return }
      try { await dl.save({ filename, data }) }
      catch (e) {
        if (e?.code === 'declined') return
        if (e?.code === 'rate_limited') { toast('A save is already waiting for you'); return }
        toast('The file could not be saved here')
      }
    })
  }
}

/* ------------------------------------------------------------------ profile mirror */

let col = null          // data/users/<id>
let lastGen = (() => { try { return localStorage.getItem(GEN_KEY) || '' } catch { return '' } })()
let lastJson = null     // the copy the store holds at lastGen
let started = false
let pushing = false
let again = false
let timer = null
let failures = 0
let toldFail = false

const keepGen = g => { lastGen = g; try { localStorage.setItem(GEN_KEY, g) } catch { /* memory still has it */ } }

const hasData = st => !!((st?.workouts || []).length || (st?.routines || []).length || (st?.bodyweight || []).length || (st?.customEx || []).length)

// Cut a string into pieces no longer than CHUNK, never between the two halves of a surrogate pair.
function split(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(i + CHUNK, s.length)
    if (end < s.length) {
      const c = s.charCodeAt(end)
      if (c >= 0xDC00 && c <= 0xDFFF) end--
    }
    out.push(s.slice(i, end))
    i = end
  }
  return out.length ? out : ['']
}

const readMeta = async () => {
  const snap = await col.doc('meta').get()
  return snap.exists ? snap.data() : null
}

async function readCopy(meta) {
  const parts = await Promise.all(Array.from({ length: meta.n }, (_, i) => col.doc(`c-${meta.gen}-${i}`).get()))
  if (parts.some(p => !p.exists || typeof p.data().s !== 'string')) return null
  return parts.map(p => p.data().s).join('')
}

// Take what the store holds, merged with this browser's copy.
async function pull(store) {
  const meta = await readMeta()
  if (!meta || !meta.gen || meta.gen === lastGen) return false
  const json = await readCopy(meta)
  if (json == null) return false
  let remote
  try { remote = JSON.parse(json) } catch { return false }
  const local = store.getState().S
  const next = hasData(local) ? mergeStates(local, remote) : remote
  if (local.active) next.active = local.active   // the session in progress belongs to this device
  keepGen(meta.gen)
  lastJson = json
  if (JSON.stringify(next) !== JSON.stringify(local)) store.getState().cloudApply(next)
  return true
}

async function push(store) {
  if (!started) return
  if (pushing) { again = true; return }
  const S = store.getState().S
  const json = JSON.stringify(S)
  if (json === lastJson) return
  pushing = true
  try {
    const meta = await readMeta()
    if (meta && meta.gen && meta.gen !== lastGen) {
      // Another device saved since this one last looked: merge first, then save the merged copy
      // on the next round. A copy that cannot be read is replaced by this one.
      if (await pull(store)) { again = true; return }
    }
    const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    const parts = split(json)
    for (let i = 0; i < parts.length; i++) await col.doc(`c-${gen}-${i}`).set({ s: parts[i] })
    await col.doc('meta').set({
      gen, n: parts.length, ts: Number(S._ts) || 0, at: Date.now(),
      prevGen: meta?.gen || null, prevN: meta?.n || 0
    })
    keepGen(gen)
    lastJson = json
    // Keep the previous copy as a fallback; drop the one before it.
    if (meta?.prevGen) for (let i = 0; i < (meta.prevN || 0); i++) col.doc(`c-${meta.prevGen}-${i}`).delete().catch(() => {})
    failures = 0
    toldFail = false
  } catch (e) {
    failures++
    if (!toldFail) {
      toldFail = true
      toast(e?.code === 'quota_exceeded'
        ? 'Your account storage for openGym is full. Export a backup in Settings.'
        : 'Could not save to your account. It is kept in this browser and will retry.')
    }
    if (['revoked', 'not_granted', 'capability_disabled', 'capability_removed', 'invalid_argument'].includes(e?.code)) started = false
    else schedule(store, Math.min(60000, PUSH_DELAY * 2 ** failures))
  } finally {
    pushing = false
    if (again) { again = false; schedule(store) }
  }
}

function schedule(store, delay = PUSH_DELAY) {
  clearTimeout(timer)
  timer = setTimeout(() => push(store), delay)
}

export async function startCloud(store) {
  if (started || typeof window === 'undefined' || !window.claude) return
  const [db, user] = await Promise.all([capability('db'), capability('user')])
  if (!db || !user) return
  const uid = await user.id().catch(() => null)
  if (!uid) return
  col = db.collection('data/users/' + uid)
  try { await pull(store) }
  catch { /* unreachable for now: this browser's copy stands, and the first push tries again */ }
  started = true
  store.subscribe((st, prev) => { if (st.S !== prev.S) schedule(store) })
  schedule(store, 1000)
  document.addEventListener('visibilitychange', () => {
    if (!started) return
    if (document.visibilityState === 'hidden') { clearTimeout(timer); push(store) }
    else if (!pushing) pull(store).catch(() => {})
  })
}
