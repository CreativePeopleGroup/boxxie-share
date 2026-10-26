// Run before the page is painted. Keep device sizing out of deferred app setup.
(() => {
  const root = document.documentElement;
  root.classList.add("booting");
  const tv = matchMedia("(pointer: none)").matches ||
    /\b(AFT[A-Z0-9]*|Android TV|BRAVIA|GoogleTV)\b/i.test(navigator.userAgent) ||
    /BoxxieShareTV/.test(navigator.userAgent);
  if (tv) {
    root.classList.add("tv");
    root.style.setProperty("--tvz", String(Math.floor(Math.min(1, innerWidth / 1280, innerHeight / 720) * 1000) / 1000));
  }
})();
