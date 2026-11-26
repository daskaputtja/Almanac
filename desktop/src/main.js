// Almanac for Windows: your Almanac in its own window, with a tray icon and
// Windows notifications for new flags, suspension requests and server trouble.
// It shows the Almanac website itself, so every feature is there straight away.

const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'io.github.daskaputtja.almanac';
const PARTITION = 'persist:almanac';
const POLL_MS = 30_000;
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

// Tests can keep their settings somewhere else.
if (process.env.ALMANAC_DESKTOP_DATA) app.setPath('userData', process.env.ALMANAC_DESKTOP_DATA);

// --- Settings --------------------------------------------------------------------

const DEFAULTS = {
  server: null,
  closeToTray: true,
  notify: { flags: 'medium', suspensions: true, server: true },
  bounds: null,
  lastEventId: null,
  shownTrayHint: false,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...saved, notify: { ...DEFAULTS.notify, ...(saved.notify ?? {}) } };
  } catch {
    return { ...DEFAULTS, notify: { ...DEFAULTS.notify } };
  }
}

let settings;
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

/** "almanac.example.com" → "https://almanac.example.com", without a trailing slash. */
function normaliseAddress(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// --- Windows ---------------------------------------------------------------------

let win = null;
let tray = null;
let quitting = false;

function icon(size) {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  return size ? image.resize({ width: size, height: size }) : image;
}

function createWindow() {
  const b = settings.bounds ?? { width: 1280, height: 860 };
  win = new BrowserWindow({
    ...b,
    minWidth: 420,
    minHeight: 500,
    title: 'Almanac',
    icon: icon(),
    backgroundColor: '#0f0f10',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });

  // Links to other sites open in the normal browser; Almanac stays in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameSite(url)) win.loadURL(url);
    else if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:') || sameSite(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: a navigation was replaced, not a failure
    void win.loadFile(path.join(__dirname, 'offline.html'), { query: { server: settings.server ?? '', reason: description } });
  });

  const remember = () => {
    if (!win.isMinimized() && !win.isMaximized()) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', (event) => {
    if (quitting || !settings.closeToTray) return;
    event.preventDefault();
    win.hide();
    if (!settings.shownTrayHint && Notification.isSupported()) {
      settings.shownTrayHint = true;
      saveSettings();
      new Notification({ title: 'Almanac is still running', body: 'It keeps checking for alerts. Find it by the clock, or quit from there.', icon: icon(64) }).show();
    }
  });

  openStart();
}

function openStart() {
  if (settings.server) void win.loadURL(settings.server);
  else void win.loadFile(path.join(__dirname, 'setup.html'));
}

function sameSite(url) {
  if (!settings.server) return false;
  try {
    return new URL(url).origin === new URL(settings.server).origin;
  } catch {
    return false;
  }
}

function show(pathInAlmanac) {
  if (!win) return;
  if (pathInAlmanac && settings.server) void win.loadURL(`${new URL(settings.server).origin}${pathInAlmanac}`);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- Tray ------------------------------------------------------------------------

function buildTrayMenu() {
  const n = settings.notify;
  const setNotify = (key, value) => {
    settings.notify[key] = value;
    saveSettings();
    buildTrayMenu();
  };
  const flagLevel = (value, label) => ({ label, type: 'radio', checked: n.flags === value, click: () => setNotify('flags', value) });
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Almanac', click: () => show() },
      { type: 'separator' },
      {
        label: 'Notifications',
        submenu: [
          { label: 'Account flags', enabled: false },
          flagLevel('high', '   Serious only'),
          flagLevel('medium', '   Worth a look and serious'),
          flagLevel('low', '   Every flag'),
          flagLevel('off', '   None'),
          { type: 'separator' },
          { label: 'Suspension requests', type: 'checkbox', checked: n.suspensions, click: (item) => setNotify('suspensions', item.checked) },
          { label: 'Server alerts', type: 'checkbox', checked: n.server, click: (item) => setNotify('server', item.checked) },
        ],
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: login.openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      {
        label: 'Keep running when closed',
        type: 'checkbox',
        checked: settings.closeToTray,
        click: (item) => {
          settings.closeToTray = item.checked;
          saveSettings();
        },
      },
      { label: 'Change Almanac address…', click: () => changeServer() },
      { type: 'separator' },
      { label: 'Quit Almanac', click: () => quit() },
    ]),
  );
}

function changeServer() {
  show();
  void win.loadFile(path.join(__dirname, 'setup.html'), { query: { current: settings.server ?? '' } });
}

function quit() {
  quitting = true;
  app.quit();
}

// --- Alerts ----------------------------------------------------------------------

let polling = false;
let signedOut = false;

/** Ask Almanac for alerts newer than the last ones seen, and show the ones wanted. */
async function poll() {
  if (polling || !settings.server) return;
  polling = true;
  try {
    const origin = new URL(settings.server).origin;
    const after = settings.lastEventId == null ? '' : String(settings.lastEventId);
    const res = await session.fromPartition(PARTITION).fetch(`${origin}/api/app/events?after=${after}`, { headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      signedOut = true;
      tray?.setToolTip('Almanac: signed out. Open it to sign in.');
      return;
    }
    if (!res.ok) return;
    signedOut = false;
    const { events, latest } = await res.json();
    for (const e of events) if (wanted(e)) notify(e);
    settings.lastEventId = latest;
    saveSettings();
    tray?.setToolTip('Almanac');
  } catch {
    tray?.setToolTip('Almanac: can’t reach the server right now.');
  } finally {
    polling = false;
  }
}

function wanted(e) {
  const n = settings.notify;
  if (e.kind === 'flag') return n.flags !== 'off' && SEVERITY_RANK[e.severity] >= SEVERITY_RANK[n.flags];
  if (e.kind === 'suspension_request' || e.kind === 'suspension_decided') return n.suspensions;
  if (e.kind === 'server') return n.server;
  return false;
}

function notify(e) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: e.title, body: e.body, icon: icon(64) });
  note.on('click', () => show(e.path ?? undefined));
  note.show();
}

// --- The address screen ---------------------------------------------------------------

ipcMain.handle('almanac:connect', async (_event, input) => {
  const server = normaliseAddress(input);
  if (!server) return { ok: false, error: 'That doesn’t look like a web address.' };
  try {
    const res = await session.fromPartition(PARTITION).fetch(`${new URL(server).origin}/api/app/info`, { headers: { Accept: 'application/json' } });
    const info = res.ok ? await res.json().catch(() => null) : null;
    if (info?.app !== 'almanac') return { ok: false, error: 'There’s no Almanac at that address (or it needs updating with sudo almanac-update).' };
    const changed = settings.server !== server;
    settings.server = server;
    if (changed) settings.lastEventId = null; // a different Almanac: start its alerts from now
    saveSettings();
    void win.loadURL(server);
    setTimeout(() => void poll(), 3000);
    return { ok: true, siloHost: info.siloHost ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.match(/net::(ERR_[A-Z_]+)/)?.[1];
    const plain = {
      ERR_NAME_NOT_RESOLVED: 'that address doesn’t exist. Check the spelling',
      ERR_CONNECTION_REFUSED: 'nothing answered at that address. Is Almanac running?',
      ERR_CONNECTION_TIMED_OUT: 'it took too long to answer',
      ERR_INTERNET_DISCONNECTED: 'this computer isn’t online',
      ERR_CERT_AUTHORITY_INVALID: 'its HTTPS certificate isn’t trusted',
      ERR_CERT_COMMON_NAME_INVALID: 'its HTTPS certificate is for a different address',
    }[code];
    return { ok: false, error: `Couldn’t reach it: ${plain ?? 'check the address and your connection'}${code ? ` (${code})` : ''}.` };
  }
});
ipcMain.handle('almanac:retry', () => openStart());
ipcMain.handle('almanac:change', () => changeServer());

// --- Start ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show());
  app.setAppUserModelId(APP_ID); // Windows needs this for notifications to show as "Almanac"
  app.whenReady().then(() => {
    settings = loadSettings();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'View',
          submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }],
        },
      ]),
    );
    createWindow();
    tray = new Tray(icon(32));
    tray.setToolTip('Almanac');
    tray.on('click', () => show());
    tray.on('double-click', () => show());
    buildTrayMenu();
    setTimeout(() => void poll(), 5000);
    setInterval(() => void poll(), POLL_MS);
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray; quitting is from the tray menu.
    if (!settings?.closeToTray) app.quit();
  });
}

