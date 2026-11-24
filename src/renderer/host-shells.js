// Local terminal choices for the Hosts menu:
// - macOS: zsh
// - Windows: PowerShell (Windows PowerShell / PowerShell 7), Command Prompt, and available WSL distributions
// - Linux / other: the user's login shell
export function hostLocalShells(platform, localShells) {
  const list = Array.isArray(localShells) ? localShells : [];
  if (platform === 'darwin') {
    const zsh = list.find((x) => x && typeof x.id === 'string' && x.id.split('/').pop() === 'zsh');
    return [{ id: zsh ? zsh.id : '/bin/zsh', label: 'zsh', menuLabel: 'Local terminal (zsh)' }];
  }
  if (platform === 'win32') {
    const win = list.filter((x) => x && (x.id === 'powershell' || x.id === 'pwsh' || x.id === 'cmd' || x.id === 'wsl' || String(x.id).startsWith('wsl:')));
    const items = win.length ? win : [
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'cmd', label: 'Command Prompt' },
    ];
    return items.map((x) => ({ id: x.id, label: x.label || x.id, menuLabel: `Local: ${x.label || x.id}` }));
  }
  const sh = list.find((x) => x && x.menu) || list[0] || { id: '/bin/sh', label: 'sh' };
  const label = sh.label || sh.id.split('/').pop() || 'sh';
  return [{ id: sh.id, label, menuLabel: `Local terminal (${label})` }];
}
