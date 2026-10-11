/*
 * Kairos se usa como una app: sin zoom con los dedos ni con doble toque.
 * - La etiqueta viewport lo pide a los navegadores que la respetan (Android, Chrome…).
 * - Safari de iPhone ignora esa etiqueta, así que se bloquean aquí sus gestos de pellizco.
 * - El doble toque se desactiva con «touch-action: manipulation» en los estilos.
 * - En el ordenador, se bloquea el zoom con pellizco del panel táctil (Ctrl + rueda).
 */
(() => {
  const stop = (e) => e.preventDefault();
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, stop, { passive: false });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 || (typeof e.scale === 'number' && e.scale !== 1)) e.preventDefault();
  }, { passive: false });
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
})();
