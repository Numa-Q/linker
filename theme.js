'use strict';
/* Applique la préférence de thème avant le premier rendu (évite le scintillement).
   Seule la préférence d'affichage ("light" | "dark") est dans localStorage : aucune donnée métier. */
(function () {
  try {
    var t = localStorage.getItem('pl-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* stockage indisponible : thème automatique */ }
})();
