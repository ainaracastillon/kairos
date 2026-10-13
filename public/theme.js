/*
 * Apariencia de Kairos: color de fondo de la app.
 * Cada fondo es claro u oscuro, y según eso la letra es negra o blanca para que siempre se lea bien.
 * Se aplica antes de pintar la página (guardado en este dispositivo) y se sincroniza con la cuenta.
 */
(function () {
  // [id, nombre, modo, fondo, tarjetas, tarjetas secundarias, bordes, bordes marcados]
  var LIST = [
    ['auto', 'Automático', null],
    ['crema', 'Crema', 'light', '#f6f4ef', '#ffffff', '#f2efe8', '#e4dfd4', '#d3ccbe'],
    ['blanco', 'Blanco', 'light', '#ffffff', '#ffffff', '#f3f4f6', '#e2e5e9', '#cdd2d8'],
    ['gris', 'Gris perla', 'light', '#eceff2', '#ffffff', '#e6e9ed', '#d9dee3', '#c5ccd3'],
    ['rosa', 'Rosa', 'light', '#fbeff2', '#ffffff', '#f7e5ea', '#eed4db', '#e1bdc7'],
    ['menta', 'Menta', 'light', '#ecf6f0', '#ffffff', '#e2f0e7', '#d0e5d8', '#b9d7c4'],
    ['cielo', 'Cielo', 'light', '#ebf2fa', '#ffffff', '#e1ebf6', '#cfdeee', '#b8cde3'],
    ['lavanda', 'Lavanda', 'light', '#f2effa', '#ffffff', '#eae5f6', '#dbd3ee', '#c8bce3'],
    ['arena', 'Arena', 'light', '#faf5e6', '#ffffff', '#f4ecd4', '#e9dfbf', '#dacda6'],
    ['oscuro', 'Oscuro', 'dark', '#121619', '#1a1f23', '#21272c', '#2d343a', '#3b444b'],
    ['negro', 'Negro', 'dark', '#000000', '#121212', '#1b1b1b', '#2a2a2a', '#3a3a3a'],
    ['noche', 'Azul noche', 'dark', '#0e1726', '#16213a', '#1d2a46', '#2a3a5c', '#384a70'],
    ['bosque', 'Bosque', 'dark', '#0e1a14', '#15251d', '#1c3026', '#284235', '#355444'],
    ['vino', 'Vino', 'dark', '#1c0f14', '#28161d', '#331d26', '#462a35', '#5a3745'],
  ];
  var VARS = ['--bg', '--surface', '--surface-2', '--border', '--border-strong'];
  var KEY = 'kairos-theme';

  /* ---- Color personalizado (elegido con la ruleta): «custom:#rrggbb» ---- */
  function hexToRgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
  function rgbToHex(c) { return '#' + c.map(function (v) { return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2); }).join(''); }
  function mix(a, b, w) { var x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map(function (v, i) { return v * (1 - w) + y[i] * w; })); }
  function lum(h) {
    var c = hexToRgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  /** Con un fondo cualquiera: ¿se lee mejor la letra oscura o la blanca? */
  function modeFor(bg) { return contrast(bg, '#1f2b30') >= contrast(bg, '#e8ecec') ? 'light' : 'dark'; }
  function rgbToHsl(hex) {
    var c = hexToRgb(hex).map(function (v) { return v / 255; });
    var max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]), l = (max + min) / 2, h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0) : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
      h *= 60;
    }
    return [h, s * 100, l * 100];
  }
  function hsl(h, s, l) {
    s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; };
    var a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  /*
   * El color elegido se ajusta para que todo se lea bien: se conserva su tono, pero el fondo
   * queda muy claro (letra negra) o muy oscuro (letra blanca). Así los colores de las asignaturas,
   * los exámenes y los botones siguen teniendo buen contraste.
   */
  function customTheme(hex) {
    var p = rgbToHsl(hex), h = p[0], s = p[1];
    var light = modeFor(hex) === 'light';
    if (light) {
      var sl = Math.min(s, 75);
      return ['custom:' + hex, 'Personalizado', 'light', hsl(h, sl, 94), hsl(h, Math.min(s, 60), 98.5), hsl(h, sl * 0.8, 90.5), hsl(h, sl * 0.6, 85), hsl(h, sl * 0.5, 77)];
    }
    var sd = Math.min(s, 42);
    return ['custom:' + hex, 'Personalizado', 'dark', hsl(h, sd, 8.5), hsl(h, sd, 12), hsl(h, sd, 15.5), hsl(h, sd * 0.85, 21), hsl(h, sd * 0.8, 27)];
  }

  function find(id) {
    var m = /^custom:(#[0-9a-f]{6})$/i.exec(id || '');
    if (m) return customTheme(m[1].toLowerCase());
    for (var i = 0; i < LIST.length; i++) if (LIST[i][0] === id) return LIST[i];
    return LIST[0];
  }
  function apply(id) {
    var t = find(id);
    var root = document.documentElement;
    for (var i = 0; i < VARS.length; i++) root.style.removeProperty(VARS[i]);
    if (!t[2]) {
      root.removeAttribute('data-mode');
    } else {
      root.setAttribute('data-mode', t[2]);
      for (var j = 0; j < VARS.length; j++) root.style.setProperty(VARS[j], t[3 + j]);
    }
    root.setAttribute('data-theme', t[0]);
    // Color de la barra del navegador / del móvil.
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var k = 0; k < metas.length; k++) {
      if (!metas[k].dataset.orig) { metas[k].dataset.orig = metas[k].getAttribute('content'); metas[k].dataset.media = metas[k].getAttribute('media') || ''; }
      if (t[2]) { metas[k].setAttribute('content', t[4]); metas[k].removeAttribute('media'); }
      else { metas[k].setAttribute('content', metas[k].dataset.orig); if (metas[k].dataset.media) metas[k].setAttribute('media', metas[k].dataset.media); }
    }
    try { localStorage.setItem(KEY, t[0]); } catch (e) { /* sin almacenamiento */ }
  }
  var saved = 'auto';
  try { saved = localStorage.getItem(KEY) || 'auto'; } catch (e) { /* sin almacenamiento */ }
  apply(saved);

  window.kairosTheme = {
    list: LIST.map(function (t) { return { id: t[0], name: t[1], mode: t[2], bg: t[3], surface: t[4], border: t[6] }; }),
    apply: apply,
    modeFor: modeFor,
    preview: function (hex) { var t = customTheme(hex); return { mode: t[2], bg: t[3], surface: t[4], border: t[6], text: t[2] === 'dark' ? '#e8ecec' : '#1f2b30' }; },
    /** Mismo tono, en su versión clara u oscura (lo que de verdad se usará de fondo). */
    tone: function (hex, mode) { var p = rgbToHsl(hex); return mode === 'dark' ? hsl(p[0], Math.min(p[1], 42), 8.5) : hsl(p[0], Math.min(p[1], 75), 94); },
    current: function () { return document.documentElement.getAttribute('data-theme') || 'auto'; },
  };
})();
