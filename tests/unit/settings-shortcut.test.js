// settings-shortcut.test.js — Quick Access -> Settings wiring checks
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Quick Access Settings shortcut', () => {
  it('uses the internal settings action instead of running the refresh script', () => {
    const defaults = read('default-settings/DefaultSettings.ahk');
    assert.match(defaults, /menuText: "&5 - Settings"\s*,\s*command: "settings:"/);
    assert.doesNotMatch(defaults, /menuText: "&5 - Refresh Models"/);
  });

  it('keeps the Settings action wired through Main, ChatWindow, and WebView', () => {
    const requestProcessor = read('app/RequestProcessor.ahk');
    const launcher = read('app/viewers/SettingsPanel.ahk');
    const messages = read('ipc/CustomMessages.ahk');
    const chatWindow = read('chat/ChatWindow.ahk');
    const router = read('webui/js/shared/web-message-router.js');
    const contract = read('webui/js/shared/ipc-contract.js');

    assert.match(requestProcessor, /command = "settings:"[\s\S]*?ShowSettingsPanel\(\)/);
    assert.match(launcher, /CustomMessages\.notifyShowSettings\(hwnd\)/);
    assert.match(messages, /WM_SHOW_SETTINGS\s*:=\s*0x500 \+ 14/);
    assert.match(messages, /notifyShowSettings\(chatWindowhWnd\)/);
    assert.match(chatWindow, /WM_SHOW_SETTINGS[\s\S]*?postWebMessage\("showSettings"\)/);
    assert.match(router, /case 'showSettings':[\s\S]*?AppShell\.showSettings\(\)/);
    assert.match(contract, /'showSettings':\s*\{\s*dir: 'ahk->web'/);
  });
});

describe('Default command accelerators', () => {
  it('puts Custom Prompt -> Paste, Refine, Summarize, and Send Screenshot in the main command menu', () => {
    const defaults = read('default-settings/DefaultSettings.ahk');
    const commandBlock = (name) => {
      const start = defaults.indexOf(`commandName: "${name}"`);
      assert.notStrictEqual(start, -1, `${name} command is missing`);
      const next = defaults.indexOf('commandName:', start + 1);
      return defaults.slice(start, next === -1 ? defaults.length : next);
    };

    assert.doesNotMatch(commandBlock('Rephrase in Context'), /directAccelerator:/);
    assert.match(commandBlock('Custom Prompt → Paste'), /directAccelerator:\s*"&5"/);
    assert.match(commandBlock('Refine'), /directAccelerator:\s*"&8"/);
    assert.match(commandBlock('Summarize'), /directAccelerator:\s*"&6"/);
    assert.match(commandBlock('Screenshot'), /directAccelerator:\s*"&7"/);
  });
});
