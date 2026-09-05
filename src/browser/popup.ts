// The popup: what is this, is it working, and what is it holding.
//
// It exists because an extension with no visible surface is indistinguishable
// from a broken one. Yoke does nothing until a client connects, so a fresh
// install has nothing to show and no way to explain itself, which reads as
// "requests six sensitive permissions, does nothing".
//
// So this answers four questions in the order someone asks them: is the local
// half installed, which profile is this, which tabs are currently being driven,
// and how do I stop it.
import type { PopupReply, PopupRequest } from './messages.js';

const ask = (request: PopupRequest): Promise<PopupReply> =>
  chrome.runtime.sendMessage(request) as Promise<PopupReply>;

const el = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) { throw new Error(`missing element #${id}`); }
  return found;
};

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

async function render(): Promise<void> {
  const status = await ask({ kind: 'status' });
  if (status.kind !== 'status') { return; }

  el('version').textContent = `v${status.version}`;

  const connected = status.connected;
  el('state').className = connected ? 'state on' : 'state off';
  el('state-text').textContent = connected ? 'Connected' : 'Not connected';
  el('state-detail').textContent = connected
    ? 'The local server is running. A client can drive this browser.'
    : 'The local half is not answering, so nothing can drive this browser yet.';

  // Shown only when disconnected, because that is the only time it is the
  // reader's problem. Someone whose setup works does not need instructions.
  el('setup').hidden = connected;

  const held = status.attached.length;
  el('driving').hidden = held === 0;
  if (held > 0) {
    el('driving-text').textContent = `Driving ${plural(held, 'tab', 'tabs')}`;
    el('driving-detail').textContent = held === 1
      ? 'That tab shows Chrome\'s debugging bar and cannot open DevTools.'
      : 'Those tabs show Chrome\'s debugging bar and cannot open DevTools.';
  }

  el('idle').hidden = held > 0;

  // The id is how the server tells this profile from another one, and the label
  // is how a person does. Shown so what list_browsers prints can be matched to
  // the window it came from.
  el('profile-id').textContent = status.id;
  const input = el('label') as HTMLInputElement;
  if (document.activeElement !== input && input.value !== status.label) { input.value = status.label; }
}

el('label-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el('label') as HTMLInputElement;
  const button = el('save') as HTMLButtonElement;
  button.disabled = true;
  void ask({ kind: 'setLabel', label: input.value }).then((reply) => {
    button.disabled = false;
    if (reply.kind === 'labelled') { input.value = reply.label; }
    return render();
  });
});

el('release').addEventListener('click', () => {
  const button = el('release') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Releasing';
  void ask({ kind: 'releaseAll' }).then(() => {
    button.disabled = false;
    button.textContent = 'Release all tabs';
    return render();
  });
});

void render();

// Kept current while the popup is open: a tab can be released or driven from
// elsewhere, and a stale count here would be worse than no count.
setInterval(() => { void render(); }, 2_000);
