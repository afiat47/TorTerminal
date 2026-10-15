# TorTerminal

A web-based terminal for SSH, SFTP, Telnet, Raw TCP, serial consoles and local shells. You can open many terminals side by side in tabs and split panes. It also has a session manager, SecureCRT-style button bars and many PuTTY features.

## Quick start

```bash
npm install
npm start
```

Then open **http://127.0.0.1:7070**.

| Env var            | Default     | Purpose                                                       |
|--------------------|-------------|---------------------------------------------------------------|
| `PORT`             | `7070`      | HTTP port                                                     |
| `HOST`             | `127.0.0.1` | Bind address                                                  |
| `TORTERM_PASSWORD` | *(none)*    | Requires a login. You must set it to allow access from other machines |
| `TORTERM_DATA`     | `./data`    | Where sessions, settings, known hosts and logs are stored    |

Example for LAN access: `set HOST=0.0.0.0 && set TORTERM_PASSWORD=yourpass && npm start` (Windows), or
`HOST=0.0.0.0 TORTERM_PASSWORD=yourpass npm start` (Linux/macOS).

> Tip: in Chrome or Edge, use **Install app** from the address-bar menu to open TorTerminal in its own window. This also frees browser-reserved shortcuts.

## Features

### Protocols
- **SSH**: password, private key (OpenSSH/PEM/PuTTY .ppk), encrypted keys (passphrase prompt), SSH agent / Pageant, agent forwarding and keyboard-interactive (2FA/OTP prompts).
  - Host key verification with a known-hosts store, like PuTTY: it warns you about unknown or changed keys, and you can *Accept & save* or *Connect once*.
  - Jump host (ProxyJump through another saved session), keepalive, compression, a remote command instead of a shell, and environment variables.
  - *Legacy algorithms* mode for old routers and switches (ssh-rsa, dh-group1, CBC, 3DES).
  - **Port forwarding**: local `-L`, remote `-R` and dynamic SOCKS4/5 `-D`.
  - **SFTP browser**: browse, upload (button or drag & drop, with progress), download, rename, delete (recursive), chmod, a built-in text editor, *cd here in terminal*, and paste paths into the terminal.
- **Telnet**: full option negotiation (ECHO, SGA, BINARY, TTYPE, NAWS window size), passive mode, CR-LF/CR-NUL. Special commands: Break, AYT, IP, AO, EC, EL, GA, NOP, EOF, Susp, Abort.
- **Raw TCP**, with PuTTY-style local echo and local line editing.
- **Serial** (COM ports / ttyUSB): baud rate, data bits, parity, stop bits, RTS/CTS or XON/XOFF flow control, Break, DTR/RTS pulse.
- **Local shells**: PowerShell, cmd, WSL, Git Bash, bash, zsh and others through a real PTY (node-pty).
- **Character sets**: UTF-8, Latin-1, CP437, CP1252, KOI8-R, GBK, Big5, Shift_JIS and more.

### Workspace
- Tabs, each with **split panes** that you can split horizontally and vertically and resize. Double-click a divider to equalize.
- **Drag & drop docking**: drag a pane header onto another pane's edge to re-dock it, or onto its center to swap. Drop it on a tab to move it there.
- Drag a saved session from the sidebar onto a pane edge to open it in a split.
- **Tile** all panes into a grid, **maximize** one pane, and move focus with Alt+Arrows.
- **Broadcast input**: typing goes to every pane in the tab (SecureCRT "Send to all").
- Workspace restore: tabs, splits and sizes come back after a reload.
- Command palette (Ctrl+Shift+P) for actions, sessions, tabs and buttons.

### Claude assistant (Alt+Shift+A)
A side panel where you chat with Claude. Claude can see your open terminals and work in them.
- **Connecting** – two options:
  - **Claude Code login (default)**: works like the Claude Code extension for VS Code. TorTerminal runs Claude Code through the Claude Agent SDK, which bundles it, and uses the account you're signed in to in Claude Code. No API key is needed, and usage counts toward your Claude plan. Claude Code's own tools (Bash, file editing) are switched off, so Claude only gets TorTerminal's terminal tools. If you're not signed in, run `claude` and `/login` once.
  - **Anthropic API key**: paste a key into the panel; it is stored encrypted on the server and never sent back to the browser. Usage is billed per request to the key's account. Setting `ANTHROPIC_API_KEY` or using an `ant auth login` profile also works.
  - Switch between them under ⚙ → Connection in the panel.
  - The Claude Code login is meant for your own use on your own machine. If other people use your TorTerminal, have them use API keys.
- **Terminal IDs**: every pane shows an ID badge (T1, T2…). Claude also knows which pane is active, so "check disk space here" works.
- **What Claude can do**: list terminals, read a terminal's screen, run a command and read its output, send keys (Ctrl+C, `q`, answers to prompts), and open a saved session or local shell.
- **Approval**: by default every command, keystroke and new session waits for you to click **Run** (you can edit the command first) or **Skip**. *Auto-run* can be turned on from the panel; Claude is still told to ask in chat before anything destructive.
- **Settings**: choose the model (default Claude Opus 5.5) and effort from the panel header. The chat survives a page reload. Right-click a terminal and choose **Ask Claude about selection** to send output to the chat.

### SecureCRT-style
- **Button bars**: multiple named bars of one-click commands. Each button can send to the active pane, all panes in the tab, or all sessions.
  - Escapes: `\r \n \t \e \cC \xHH \p` (pause). `${username}` and `${password}` expand on the server, so secrets never reach the browser.
  - Multi-line scripts with a per-line delay, a confirmation prompt, colors, hotkeys and drag-to-reorder.
  - Default bars: Linux, Cisco, Docker.
- **Command window**: compose a command and send it to one pane, the whole tab or every session, with history.
- **Logon scripts**: expect/send steps that run automatically after connecting. Text or `/regex/` matching, with templates for Telnet login and Cisco enable.
- **Keyword highlighting**: color matching output with regex rules (errors, warnings, IPs and so on).
- **Anti-idle** string, **auto reconnect** with backoff, per-session button bar and tab color.
- Session folders (nested), filter, duplicate, move, *Connect all tiled*, import/export (optionally with secrets).

### PuTTY-style
- Session logging to files: printable output or raw, with optional timestamps. You can view, download and delete logs in the UI.
- Copy on select, right-click paste (configurable), middle-click paste, and confirmation before a multi-line paste.
- Backspace sends ^? or ^H, local echo and line editing (auto/on/off), terminal type, and Telnet special commands.
- *Press Enter to reconnect* after a disconnect.

### Terminal
- xterm.js 6 with WebGL rendering, Unicode 11 / emoji, true color, mouse support and bracketed paste.
- Search with regex, case-sensitive and whole-word options.
- 15 color schemes (Tor Dark, Tokyo Night, Dracula, One Dark, Monokai, Nord, Gruvbox, Solarized, GitHub Light, Catppuccin, PuTTY, SecureCRT, green and amber screens). You can change the font, size, line height and cursor style, and zoom per pane (Ctrl +/−/0).
- Ctrl+click opens URLs. You can save the scrollback to a file. The remote host can set the pane title, and the bell can be visual or audible.
- Status bar: connection state, target, size, traffic, uptime, encoding and logging.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Alt+Shift+T | New tab |
| Alt+Shift+D / E | Split right / down |
| Alt+Shift+W | Close pane |
| Alt+Shift+Enter | Maximize / restore pane |
| Alt+Shift+R | Reconnect |
| Alt+Shift+S | SFTP browser |
| Alt+Shift+A | Claude assistant |
| Alt+Arrows | Focus pane in direction |
| Alt+1…9, Alt+PgUp/PgDn | Switch tabs |
| Ctrl+Shift+P | Command palette |
| Ctrl+Shift+F | Find |
| Ctrl+Shift+C / V | Copy / paste |
| Ctrl+Shift+B | Toggle broadcast |
| Ctrl+Shift+K | Clear scrollback |
| Ctrl+Shift+L | Command window |
| Ctrl+= / − / 0 | Font size |

## Security notes

- By default the server only listens on `127.0.0.1`.
- Cross-origin WebSocket and API requests and DNS-rebinding requests are rejected, so other websites can't open a shell on your machine.
- Set `TORTERM_PASSWORD` before you expose the server on a network. Without it, non-local access is refused.
  - Use a reverse proxy with HTTPS for access over the internet.
- Saved passwords, keys and passphrases are encrypted at rest with AES-256-GCM, using a key in `data/secret.key`. They are never sent back to the browser.
- Port forwards listen on the TorTerminal server, not in the browser.

## Project layout

```
server/
  index.js          HTTP + WebSocket server, REST API, SFTP transfer endpoints
  store.js          JSON storage, secret encryption
  logger.js         session logging
  assistant.js      Claude connection, chat sockets and the API-key agent loop (tools run in the browser)
  claude-code.js    "Claude Code login" mode via the Claude Agent SDK
  protocols/        ssh.js, telnet.js (telnet + raw), serial.js, local.js
public/
  index.html, css/app.css
  js/app.js         controller, shortcuts, quick connect, palette, command window
  js/terminal-pane.js  xterm pane: connection, prompts, highlighting, logon scripts
  js/layout.js      tabs, split tree, drag-and-drop docking
  js/sessions.js    session manager and editor
  js/buttons.js     button bars
  js/sftp.js        SFTP browser
  js/assistant.js   Claude side panel, terminal tools and approvals
  js/settings.js, themes.js, util.js
```

`node-pty` and `serialport` are optional dependencies. If they fail to install, local shells fall back to a limited non-PTY mode and the serial protocol is disabled.
