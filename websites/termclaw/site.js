const tabs = [...document.querySelectorAll('[data-tool]')];
const panels = [...document.querySelectorAll('[data-panel]')];
const tabList = document.querySelector('.tool-tabs');
tabList.setAttribute('role', 'tablist');

function selectTool(selected) {
  for (const tab of tabs) {
    const current = tab === selected;
    tab.classList.toggle('selected', current);
    tab.setAttribute('aria-selected', String(current));
    tab.tabIndex = current ? 0 : -1;
  }
  for (const panel of panels) panel.hidden = panel.dataset.panel !== selected.dataset.tool;
}

tabs.forEach((tab, index) => {
  const panel = panels.find(item => item.dataset.panel === tab.dataset.tool);
  tab.id = 'tab-' + tab.dataset.tool;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panel.id);
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  tab.addEventListener('click', event => { event.preventDefault(); selectTool(tab); });
  tab.addEventListener('keydown', event => {
    const next = {ArrowRight:(index + 1) % tabs.length, ArrowLeft:(index + tabs.length - 1) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTool(tabs[next]);
    tabs[next].focus();
  });
});
selectTool(tabs.find(tab => tab.hash === location.hash) || tabs[0]);

const dialog = document.querySelector('#lightbox');
for (const button of document.querySelectorAll('.shot')) {
  button.addEventListener('click', () => {
    const source = button.querySelector('img');
    const target = document.querySelector('#large-shot');
    target.src = source.src;
    target.alt = source.alt;
    document.querySelector('#shot-name').textContent = button.closest('.panel').querySelector('.eyebrow').textContent;
    dialog.showModal();
    document.querySelector('#close-shot').focus();
  });
}
document.querySelector('#close-shot').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});

const player = document.querySelector('#player');
const chapters = [...document.querySelectorAll('[data-time]')];
let pendingChapter;
player.addEventListener('loadedmetadata', () => {
  if (pendingChapter !== undefined) {
    player.currentTime = pendingChapter;
    pendingChapter = undefined;
  }
});
for (const link of chapters) {
  link.addEventListener('click', event => {
    event.preventDefault();
    const seconds = Number(link.dataset.time);
    if (player.readyState === 0) pendingChapter = seconds;
    else player.currentTime = seconds;
    player.play().catch(() => player.focus());
  });
}
player.addEventListener('timeupdate', () => {
  const active = chapters.filter(link => Number(link.dataset.time) <= player.currentTime + .01).pop();
  for (const link of chapters) {
    link.classList.toggle('active', link === active);
    if (link === active) link.setAttribute('aria-current', 'time');
    else link.removeAttribute('aria-current');
  }
});
