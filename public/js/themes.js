// Terminal color schemes (xterm.js ITheme).

const base = (bg, fg, cursor, sel, ansi) => ({
  background: bg,
  foreground: fg,
  cursor,
  cursorAccent: bg,
  selectionBackground: sel,
  black: ansi[0], red: ansi[1], green: ansi[2], yellow: ansi[3], blue: ansi[4], magenta: ansi[5], cyan: ansi[6], white: ansi[7],
  brightBlack: ansi[8], brightRed: ansi[9], brightGreen: ansi[10], brightYellow: ansi[11], brightBlue: ansi[12], brightMagenta: ansi[13], brightCyan: ansi[14], brightWhite: ansi[15],
});

export const THEMES = {
  'Tor Dark': base('#0b0e14', '#d5dbe6', '#3ddc97', '#2a3b5c', ['#1d2330', '#f7768e', '#3ddc97', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5', '#4b5468', '#ff8fa3', '#6ef0b5', '#f2c98a', '#9ab8ff', '#cdb2ff', '#a4e1ff', '#ffffff']),
  'Tokyo Night': base('#1a1b26', '#c0caf5', '#c0caf5', '#33467c', ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  Dracula: base('#282a36', '#f8f8f2', '#f8f8f2', '#44475a', ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  'One Dark': base('#282c34', '#abb2bf', '#528bff', '#3e4451', ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  Monokai: base('#272822', '#f8f8f2', '#f8f8f0', '#49483e', ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  Nord: base('#2e3440', '#d8dee9', '#d8dee9', '#434c5e', ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  'Gruvbox Dark': base('#282828', '#ebdbb2', '#ebdbb2', '#504945', ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  'Solarized Dark': base('#002b36', '#839496', '#93a1a1', '#073642', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  'Solarized Light': base('#fdf6e3', '#657b83', '#586e75', '#eee8d5', ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  'GitHub Light': base('#ffffff', '#24292f', '#0969da', '#cce1fb', ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
  'Catppuccin Mocha': base('#1e1e2e', '#cdd6f4', '#f5e0dc', '#45475a', ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  PuTTY: base('#000000', '#bbbbbb', '#00ff00', '#555555', ['#000000', '#bb0000', '#00bb00', '#bbbb00', '#0000bb', '#bb00bb', '#00bbbb', '#bbbbbb', '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff']),
  'SecureCRT': base('#ffffff', '#000000', '#000000', '#a6c8ff', ['#000000', '#c00000', '#00a000', '#a0a000', '#0000c0', '#a000a0', '#00a0a0', '#c0c0c0', '#606060', '#ff0000', '#00e000', '#e0e000', '#0000ff', '#ff00ff', '#00e0e0', '#ffffff']),
  'Green Screen': base('#001100', '#33ff66', '#33ff66', '#0b4d1d', ['#001100', '#22aa44', '#33ff66', '#66ff88', '#22aa44', '#33ff66', '#66ff88', '#88ffaa', '#116622', '#33ff66', '#66ff99', '#99ffbb', '#33ff66', '#66ff99', '#99ffbb', '#ccffdd']),
  'Amber Screen': base('#140c00', '#ffb000', '#ffb000', '#4d3500', ['#140c00', '#cc8800', '#ffb000', '#ffc640', '#cc8800', '#ffb000', '#ffc640', '#ffd780', '#664400', '#ffb000', '#ffc640', '#ffd780', '#ffb000', '#ffc640', '#ffd780', '#ffe8b0']),
};

export const FONTS = [
  "'Cascadia Code', monospace",
  "'Cascadia Mono', monospace",
  "'JetBrains Mono', monospace",
  "'Fira Code', monospace",
  "Consolas, monospace",
  "'Courier New', monospace",
  "'Lucida Console', monospace",
  "Menlo, monospace",
  "'DejaVu Sans Mono', monospace",
  "'Ubuntu Mono', monospace",
  "'Source Code Pro', monospace",
  'monospace',
];
