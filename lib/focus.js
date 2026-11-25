// Panel zaten aciksa mevcut pencereyi one getirir (macOS, AppleScript). Safari desteklenmez.
const { execFile } = require('child_process');

const BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc'];

// Saf fonksiyon: verilen tarayici icin AppleScript metni uretir. Eslesirse "ok" dondurur.
function focusScript(app, port) {
  const p = Number(port);
  if (!BROWSERS.includes(app) || !Number.isInteger(p) || p < 1 || p > 65535) throw new Error('gecersiz arguman');
  const bases = [`http://localhost:${p}`, `http://127.0.0.1:${p}`];
  const sel = app === 'Arc' ? 'tell t to select' : 'set active tab index of w to ti';
  return `on isPanel(u)
  repeat with b in {${bases.map((b) => `"${b}"`).join(', ')}}
    if u is (b as text) then return true
    repeat with c in {"/", "?", "#"}
      if u starts with ((b as text) & (c as text)) then return true
    end repeat
  end repeat
  return false
end isPanel
tell application "${app}"
  repeat with wi from 1 to count of windows
    set w to window wi
    repeat with ti from 1 to count of tabs of w
      set t to tab ti of w
      if my isPanel(URL of t) then
        ${sel}
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "none"`;
}

const osa = (script, ms, cb) => execFile('osascript', ['-e', script], { timeout: ms }, (err, out) => cb(err, String(out || '').trim()));

// Calisan tarayicilari bulur, ilk eslesen pencereyi one getirir. cb(true) bulunduysa. Hata olursa cb(false).
function focusExisting(port, cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  const cap = setTimeout(() => finish(false), 4000); // ust sinir
  const end = (v) => { clearTimeout(cap); finish(v); };
  // Calismayan tarayiciyi baslatmamak icin once calisan islemleri oku
  osa('tell application "System Events" to get name of every process whose background only is false', 1500, (err, out) => {
    if (err) return end(false);
    const running = out.split(', ').map((s) => s.trim());
    const list = BROWSERS.filter((b) => running.includes(b));
    const next = (i) => {
      if (done) return;
      if (i >= list.length) return end(false);
      let script; try { script = focusScript(list[i], port); } catch { return end(false); }
      osa(script, 1500, (e, o) => (!e && o === 'ok') ? end(true) : next(i + 1));
    };
    next(0);
  });
}

module.exports = { BROWSERS, focusScript, focusExisting };
