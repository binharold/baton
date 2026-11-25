// Varsayilan tema: Nova. Ayarlar > Gorunum'den degistirilen secim (aip.theme) bu bilgisayarda saklanir ve korunur.
(function () { let t = 'nova'; try { t = JSON.parse(localStorage.getItem('aip.theme')) || 'nova'; } catch {} if (t !== 'classic') document.documentElement.dataset.theme = t; })();
