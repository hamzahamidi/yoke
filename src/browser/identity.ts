// Which profile this is, remembered across service worker restarts.
//
// Chrome starts a native host per profile and tells it nothing about which, and
// an extension cannot read its own profile directory either. So the only stable
// per-profile fact available is one this code makes up once and keeps: a random
// id, minted the first time the extension runs in a profile. It lives in
// IndexedDB rather than chrome.storage because that would cost a permission,
// and the manifest asks for nothing it does not have to.
//
// The label is the human half: whatever the person types in the popup, so
// "work" and "personal" can be told apart without memorising hex.

const DATABASE = 'yoke';
const STORE = 'identity';
const LABEL_MAX = 40;

export interface Identity {
  /** Eight lowercase hex characters. Also the name of this profile's endpoint. */
  id: string;
  /** Empty until the person sets one. */
  label: string;
}

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
  });
}

function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error ?? new Error(`could not read ${key}`));
  });
}

function write(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(`could not write ${key}`));
  });
}

/** Eight hex characters: short enough to read aloud, and 4 billion profiles apart. */
function mint(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let cached: Identity | undefined;

/** This profile's identity, minting the id on first use. */
export async function identity(): Promise<Identity> {
  if (cached) { return cached; }
  const db = await openStore();
  try {
    let id = await read<string>(db, 'id');
    if (id === undefined || !/^[a-f0-9]{8}$/.test(id)) {
      id = mint();
      await write(db, 'id', id);
    }
    const label = (await read<string>(db, 'label')) ?? '';
    cached = { id, label };
    return cached;
  } finally {
    db.close();
  }
}

/** Renames this profile. Trimmed and capped, so a label fits in a tab listing. */
export async function setLabel(raw: string): Promise<Identity> {
  const label = raw.trim().slice(0, LABEL_MAX);
  const current = await identity();
  const db = await openStore();
  try {
    await write(db, 'label', label);
  } finally {
    db.close();
  }
  cached = { id: current.id, label };
  return cached;
}
