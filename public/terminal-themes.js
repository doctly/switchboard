// --- Terminal themes ---
const TERMINAL_THEMES = {
  switchboard: {
    label: 'Switchboard',
    background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560', selectionBackground: '#3a3a5e',
    black: '#1a1a2e', red: '#e94560', green: '#0dff00', yellow: '#f5a623', blue: '#7b68ee', magenta: '#c678dd', cyan: '#56b6c2', white: '#c5c8c6',
    brightBlack: '#555568', brightRed: '#ff6b81', brightGreen: '#69ff69', brightYellow: '#ffd93d', brightBlue: '#8fa8ff', brightMagenta: '#d19afc', brightCyan: '#7ee8e8', brightWhite: '#eaeaea',
  },
  ghostty: {
    label: 'Ghostty',
    background: '#292c33', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#363a43', selectionBackground: '#ffffff', selectionForeground: '#292c33',
    black: '#1d1f21', red: '#bf6b69', green: '#b7bd73', yellow: '#e9c880', blue: '#88a1bb', magenta: '#ad95b8', cyan: '#95bdb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#c55757', brightGreen: '#bcc95f', brightYellow: '#e1c65e', brightBlue: '#83a5d6', brightMagenta: '#bc99d4', brightCyan: '#83beb1', brightWhite: '#eaeaea',
  },
  tokyoNight: {
    label: 'Tokyo Night',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    label: 'Catppuccin Mocha',
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  dracula: {
    label: 'Dracula',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  nord: {
    label: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  solarizedDark: {
    label: 'Solarized Dark',
    background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

let currentThemeName = 'switchboard';
function getTerminalTheme() {
  return TERMINAL_THEMES[currentThemeName] || TERMINAL_THEMES.switchboard;
}
let TERMINAL_THEME = getTerminalTheme();
