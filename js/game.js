const STORAGE_KEY = 'meteor_dodge_best_v1';
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const tg = window.Telegram && window.Telegram.WebApp;

/** iOS / Telegram WKWebView often lacks ctx.ellipse — without this the loop throws after stars */
function fillEllipse(cx, cy, rx, ry, rotation){
  rotation = rotation || 0;
  if(typeof ctx.ellipse === 'function'){
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rotation, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.scale(rx, ry);
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Older WebViews lack roundRect — HUD uses this instead of ctx.roundRect */
function fillRoundRect(x, y, w, h, r){
  if(typeof ctx.roundRect === 'function'){
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    return;
  }
  r = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

const MAX_PARTICLES = 420;
const MAX_FLOAT_LABELS = 22;

function getSafeInsets(){
  if(tg && tg.safeAreaInset){
    const s = tg.safeAreaInset;
    return { top:+s.top||0, right:+s.right||0, bottom:+s.bottom||0, left:+s.left||0 };
  }
  return { top:0, right:0, bottom:0, left:0 };
}

function applySafeCss(insets){
  document.documentElement.style.setProperty('--sat', insets.top + 'px');
  document.documentElement.style.setProperty('--sar', insets.right + 'px');
  document.documentElement.style.setProperty('--sab', insets.bottom + 'px');
  document.documentElement.style.setProperty('--sal', insets.left + 'px');
}

let W, H;
let player, meteors, stars, particles;
let score, alive, frame;
let baseSpeed, slowTimer, doubleTimer;
let touchX;
let shield, shieldTimer;
let bestScore = 0;
let spawnCooldown = 0;
let phaseTag = '';
let phaseTagTimer = 0;
let waveMode = 'normal';
let waveTimer = 0;
let waveAnnounce = '';
let waveAnnounceTimer = 0;
let nextWaveRoll = 480;
let magnetTimer = 0;
let combo = 0;
let sessionMaxCombo = 0;
let lastGrazeFrame = 0;
let screenShake = 0;
let floatTexts = [];
let windX = 0;
let bot = null;
let botScore = 0;
let raceOver = false;
let raceResult = '';
let waveAnnounceSub = '';
let waveAnnounceSubTimer = 0;
let gamePaused = false;
let waveStartTimer = 0;

try{
  const saved = localStorage.getItem(STORAGE_KEY);
  if(saved != null) bestScore = Math.max(0, parseInt(saved, 10) || 0);
}catch(e){}

function resize(){
  const insets = getSafeInsets();
  applySafeCss(insets);
  const maxW = 430;
  let vw = Math.floor(document.body.clientWidth);
  let vh = Math.floor(document.body.clientHeight);
  if(tg && tg.viewportStableWidth && tg.viewportStableHeight){
    const sw = Math.floor(tg.viewportStableWidth) - insets.left - insets.right;
    const sh = Math.floor(tg.viewportStableHeight) - insets.top - insets.bottom;
    if(sw > 0) vw = Math.min(vw, sw);
    if(sh > 0) vh = Math.min(vh, sh);
  }
  W = canvas.width = Math.min(Math.max(vw, 1), maxW);
  H = canvas.height = Math.max(vh, 1);
  if(player){
    player.x = Math.min(Math.max(player.r, player.x), W - player.r);
    player.y = H * 0.76;
  }
  if(bot){
    bot.y = H * 0.86;
    bot.x = Math.min(Math.max(bot.r, bot.x), W - bot.r);
  }
  touchX = Math.min(Math.max(touchX, 0), W);
}

function initStars(){
  stars = [];
  for(let i = 0; i < 70; i++){
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.2 + 0.15,
      b: Math.random() * Math.PI * 2,
      spd: 0.003 + Math.random() * 0.008,
      layer: 0,
      vy: 0.12 + Math.random() * 0.25
    });
  }
  for(let i = 0; i < 95; i++){
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.8 + 0.2,
      b: Math.random() * Math.PI * 2,
      spd: 0.006 + Math.random() * 0.014,
      layer: 1,
      vy: 0
    });
  }
}

/** ~0..1 за ~2.5 мин, дальше плато — игра остаётся проходимой */
function diff01(){
  return Math.min(1, frame / (60 * 150));
}

function effectiveSpeedMul(){
  var d = diff01();
  var ramp = 1 + d * 0.55;
  if(slowTimer > 0) ramp *= 0.52;
  return ramp;
}

function hazardSpeed(){
  return baseSpeed * effectiveSpeedMul();
}

function maxHazardsOnScreen(){
  var d = diff01();
  var cap = Math.min(13, Math.floor(4 + d * 6 + (W / 430) * 2));
  if(waveMode === 'siege') cap += 4;
  if(waveMode === 'minefield') cap += 8;
  return cap;
}

function countPickups(){
  var n = 0;
  for(var i = 0; i < meteors.length; i++){
    if(meteors[i].pickup) n++;
  }
  return n;
}

function countActiveHazards(){
  var n = 0;
  for(var i = 0; i < meteors.length; i++){
    if(!meteors[i].pickup) n++;
  }
  return n;
}

function nextSpawnDelayFrames(){
  var d = diff01();
  var lo = 50 - d * 24;
  var hi = 68 - d * 28;
  lo = Math.max(22, lo);
  hi = Math.max(lo + 6, hi);
  var t = lo + Math.random() * (hi - lo);
  if(waveMode === 'burst') t *= 0.48;
  if(waveMode === 'siege') t *= 0.72;
  if(waveMode === 'minefield') t *= 0.55;
  return t;
}

function rollWave(){
  var d = diff01();
  if(d > 0.12 && Math.random() < 0.28){
    startWave('loot');
    return;
  }
  var r = Math.random();
  if(r < 0.08) startWave('seismic');
  else if(r < 0.32) startWave('burst');
  else if(r < 0.48) startWave('siege');
  else if(r < 0.62) startWave('minefield');
  else if(r < 0.76) startWave('wind');
  else startWave('normal');
}

function startWave(mode){
  waveMode = mode;
  waveTimer = 320 + Math.floor(Math.random() * 200);
  windX = (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.4);
  if(mode === 'wind') waveTimer = 420 + Math.floor(Math.random() * 120);
  if(mode === 'loot') waveTimer = 280;
  waveStartTimer = waveTimer;
  var names = {
    burst: '\u041d\u0410\u041b\u0401\u0422!',
    siege: '\u041e\u0411\u0421\u0410\u0414\u0410!',
    minefield: '\u041c\u0418\u041d\u041d\u041e\u0415 \u041f\u041e\u041b\u0415!',
    wind: '\u041c\u0415\u0422\u0415\u041e\u0417\u0410\u0412\u0420\u0418\u0425!',
    seismic: '\u0421\u0415\u0419\u0421\u041c!',
    loot: '\u0417\u041e\u041b\u041e\u0422\u0410\u042f \u0424\u041e\u0420\u0422\u0423\u041d\u0410!',
    normal: '\u0420\u041e\u0412\u041d\u042b\u0419 \u041f\u0420\u041e\u041c\u0415\u0416\u0423\u0422\u041e\u041a'
  };
  waveAnnounce = names[mode] || '';
  waveAnnounceTimer = 95;
  waveAnnounceSub = '';
  waveAnnounceSubTimer = 0;
  if(mode === 'minefield'){
    waveAnnounceSub = '\u0421\u0435\u0442\u043a\u0430 \u043e\u0441\u043a\u043e\u043b\u043a\u043e\u0432 \u2014 \u043f\u0440\u043e\u0441\u043a\u0430\u043b\u044c\u0437\u0438 \u043c\u0435\u0436\u0434\u0443 \u043d\u0438\u043c\u0438';
    waveAnnounceSubTimer = 130;
  }
  screenShake = mode === 'siege' || mode === 'seismic' ? 12 : (mode === 'burst' ? 8 : 5);
  hapticLight();
  if(mode === 'seismic'){
    for(var zi = meteors.length - 1; zi >= 0; zi--){
      if(!meteors[zi].pickup && meteors[zi].y > H * 0.4) meteors.splice(zi, 1);
    }
    addPfx(W / 2, H * 0.55, '#c4b5fd', 36);
    hapticMedium();
  }
  if(mode === 'minefield'){
    layMinefieldGrid();
    screenShake = Math.max(screenShake, 7);
    addFloatText(W / 2, H * 0.42, '\u041c\u0418\u041d\u042b!', '#f472b6', 70);
  }
}

function layMinefieldGrid(){
  var hs = hazardSpeed();
  var cols = Math.max(5, Math.min(9, Math.floor(W / 46)));
  var rows = 4;
  var cell = W / cols;
  for(var row = 0; row < rows; row++){
    for(var col = 0; col < cols; col++){
      if(countActiveHazards() >= maxHazardsOnScreen()) return;
      var jitterX = (Math.random() - 0.5) * (cell * 0.22);
      var jitterY = (Math.random() - 0.5) * 14;
      var x = col * cell + cell * 0.5 + jitterX;
      x = Math.max(8, Math.min(W - 8, x));
      var yBase = -35 - row * (H * 0.11) - jitterY;
      pushHazard({
        kind: 'shard',
        mineSeed: true,
        pickup: false,
        x: x,
        y: yBase,
        r: 4.5 + Math.random() * 4,
        vy: hs * (0.95 + Math.random() * 0.45),
        vx: (Math.random() - 0.5) * 1.6,
        rot: 0,
        rotV: (Math.random() - 0.5) * 0.22
      });
    }
  }
}

function weightedPick(weights){
  var t = 0;
  for(var k in weights) t += weights[k];
  var r = Math.random() * t;
  for(var key in weights){
    r -= weights[key];
    if(r <= 0) return key;
  }
  return 'rock';
}

function addFloatText(x, y, text, color, life){
  life = life || 55;
  while(floatTexts.length >= MAX_FLOAT_LABELS) floatTexts.shift();
  floatTexts.push({ x: x, y: y, text: text, life: life, maxLife: life, vy: -0.9 - Math.random() * 0.4, color: color || '#fff' });
}

function hazardExtras(m){
  if(!m.pickup){
    m.grazeDone = false;
    m.grazeActive = false;
  }
  return m;
}

function pushHazard(obj){
  meteors.push(hazardExtras(obj));
}

function spawnHazard(){
  if(countActiveHazards() >= maxHazardsOnScreen()) return;

  var d = diff01();
  var hs = hazardSpeed();
  var wm = waveMode;

  if(wm === 'loot'){
    if(countPickups() >= 4) return;
    var lootKind = weightedPick({ shield: 2.5, slow: 2, double: 2, magnet: 2.2 });
    var lx = 22 + Math.random() * (W - 44);
    pushHazard({
      kind: lootKind,
      pickup: true,
      x: lx,
      y: -38,
      r: lootKind === 'magnet' ? 15 : 14,
      vy: hs * (0.78 + Math.random() * 0.2),
      vx: (Math.random() - 0.5) * 1.2,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.12
    });
    return;
  }

  var pickupRoll = Math.random();
  var pickupChance = wm === 'burst' ? 0.11 : (0.065 + d * 0.045);
  if(wm === 'loot') pickupChance = 1;
  if(pickupRoll < pickupChance){
    var pu = weightedPick({ shield: 2.8, slow: 2, double: 2, magnet: 2.2 });
    var px = 18 + Math.random() * (W - 36);
    pushHazard({
      kind: pu,
      pickup: true,
      x: px,
      y: -35,
      r: pu === 'magnet' ? 15 : 14,
      vy: hs * (0.85 + Math.random() * 0.25),
      vx: (Math.random() - 0.5) * 1.1,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.1
    });
    return;
  }

  var w = {
    rock: 5 + (1 - d) * 2.5,
    shard: 2.8 + d * 2.2,
    swoop: d * 3.2,
    hunter: d * 2.6,
    bolt: d * d * 2,
    comet: d > 0.18 ? 1.6 + d * 1.4 : 0
  };
  if(wm === 'burst'){
    w.shard += 4; w.bolt += 1.5; w.rock += 1;
  }
  if(wm === 'siege'){
    w.rock += 5; w.hunter += 2; w.swoop += 1.5;
  }
  if(wm === 'wind'){
    w.swoop += 3; w.shard += 2;
  }
  if(wm === 'minefield'){
    w.shard += 6; w.bolt += 0.8;
  }

  var kind = weightedPick(w);

  if(kind === 'comet' && d > 0.12){
    var cx = 40 + Math.random() * (W - 80);
    pushHazard({
      kind: 'comet',
      pickup: false,
      x: cx,
      y: -55,
      r: 9 + Math.random() * 5,
      vy: hs * (0.55 + Math.random() * 0.25),
      vx: (Math.random() - 0.5) * 0.5,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.15,
      tail: 0
    });
    return;
  }

  if(kind === 'bolt'){
    pushHazard({
      kind: 'bolt',
      pickup: false,
      x: 30 + Math.random() * (W - 60),
      y: -30,
      r: 7 + Math.random() * 3,
      vy: hs * (1.45 + Math.random() * 0.35),
      vx: (Math.random() - 0.5) * 0.35,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.2
    });
    return;
  }

  if(kind === 'shard'){
    pushHazard({
      kind: 'shard',
      pickup: false,
      x: Math.random() * W,
      y: -28,
      r: 5 + Math.random() * 5,
      vy: hs * (1.05 + Math.random() * 0.35),
      vx: (Math.random() - 0.5) * 2.2,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.18
    });
    return;
  }

  if(kind === 'swoop'){
    var fromLeft = Math.random() < 0.5;
    pushHazard({
      kind: 'swoop',
      pickup: false,
      x: fromLeft ? -40 : W + 40,
      y: -20 - Math.random() * (H * 0.35),
      r: 12 + Math.random() * 10,
      vy: hs * (0.75 + Math.random() * 0.45),
      vx: fromLeft ? (1.4 + Math.random() * 1.8) : -(1.4 + Math.random() * 1.8),
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.14
    });
    return;
  }

  if(kind === 'hunter'){
    pushHazard({
      kind: 'hunter',
      pickup: false,
      x: Math.random() * W,
      y: -45,
      r: 13 + Math.random() * 11,
      vy: hs * (0.82 + Math.random() * 0.28),
      vx: (Math.random() - 0.5) * 0.8,
      rot: 0,
      rotV: (Math.random() - 0.5) * 0.1
    });
    return;
  }

  pushHazard({
    kind: 'rock',
    pickup: false,
    x: Math.random() * W,
    y: -40,
    r: 12 + Math.random() * 16,
    vy: hs * (0.92 + Math.random() * 0.55),
    vx: (Math.random() - 0.5) * 1.85,
    rot: 0,
    rotV: (Math.random() - 0.5) * 0.12
  });
}

function addPfx(x, y, col, n){
  n = n || 12;
  for(let k = 0; k < n; k++){
    const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 2 + Math.random() * 4, alpha: 1, color: col, decay: 0.025 + Math.random() * 0.025 });
  }
  while(particles.length > MAX_PARTICLES) particles.shift();
}

function hapticLight(){
  if(tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
}
function hapticMedium(){
  if(tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
}
function hapticHeavy(){
  if(tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('heavy');
}

function persistBest(){
  try{ localStorage.setItem(STORAGE_KEY, String(bestScore)); }catch(e){}
}

function restart(){
  player = { x: W / 2, y: H * 0.76, r: 20 };
  bot = { x: W * 0.5, y: H * 0.86, r: 16, alive: true };
  meteors = []; particles = []; floatTexts = [];
  score = 0; alive = true; frame = 0;
  botScore = 0;
  raceOver = false;
  raceResult = '';
  baseSpeed = 2.05;
  slowTimer = 0; doubleTimer = 0; magnetTimer = 0;
  shield = false; shieldTimer = 0; touchX = W / 2;
  spawnCooldown = 28;
  phaseTag = ''; phaseTagTimer = 0;
  waveMode = 'normal'; waveTimer = 0;
  waveAnnounce = ''; waveAnnounceTimer = 0;
  waveAnnounceSub = ''; waveAnnounceSubTimer = 0;
  nextWaveRoll = 400 + Math.floor(Math.random() * 120);
  combo = 0; sessionMaxCombo = 0; lastGrazeFrame = 0;
  screenShake = 0; windX = 0;
  gamePaused = false;
  hapticLight();
}

function updateBotAI(){
  if(!bot || !bot.alive || raceOver || !alive) return;
  var desired = touchX * 0.42 + W * 0.29;
  var flee = 0;
  for(var bi = 0; bi < meteors.length; bi++){
    var hm = meteors[bi];
    if(hm.pickup) continue;
    var dy = bot.y - hm.y;
    if(dy < -50 || dy > 220) continue;
    var dx = hm.x - bot.x;
    var d = Math.sqrt(dx * dx + dy * dy) + 0.001;
    var threat = (hm.r + 36) * (1.15 - Math.min(1, d / 130));
    if(threat > 0 && d < 130){
      flee += -(dx / d) * threat * 0.85;
    }
  }
  bot.x += flee * 0.11 + (desired - bot.x) * 0.095;
  bot.x = Math.max(bot.r + 4, Math.min(W - bot.r - 4, bot.x));
}

function setPointerX(clientX){
  const rect = canvas.getBoundingClientRect();
  touchX = clientX - rect.left;
}

canvas.addEventListener('mousemove', function(e){ if(alive) setPointerX(e.clientX); });
canvas.addEventListener('touchmove', function(e){
  e.preventDefault();
  if(e.touches && e.touches[0] && alive) setPointerX(e.touches[0].clientX);
}, { passive: false });
canvas.addEventListener('touchstart', function(e){
  e.preventDefault();
  if(e.touches && e.touches[0]) setPointerX(e.touches[0].clientX);
  if(!alive) restart();
}, { passive: false });
canvas.addEventListener('mousedown', function(){ if(!alive) restart(); });
canvas.addEventListener('contextmenu', function(e){ e.preventDefault(); });

function loop(){
  requestAnimationFrame(loop);
  try{
  ctx.clearRect(0, 0, W, H);

  var sx = (Math.random() - 0.5) * screenShake * 2.2;
  var sy = (Math.random() - 0.5) * screenShake * 2.2;
  screenShake *= 0.88;
  if(screenShake < 0.4) screenShake = 0;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1a0533'); bg.addColorStop(1, '#0d1b4a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(sx, sy);

  stars.forEach(function(s){
    s.b += s.spd;
    if(s.layer === 0){
      s.y += s.vy * (1 + diff01() * 0.8);
      if(s.y > H + 4){ s.y = -4; s.x = Math.random() * W; }
    }
    ctx.globalAlpha = (s.layer === 0 ? 0.2 : 0.3) + Math.sin(s.b) * (s.layer === 0 ? 0.25 : 0.45);
    ctx.fillStyle = s.layer === 0 ? '#c4d4ff' : '#fff';
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.globalAlpha = 1;

  if(alive && !raceOver && !gamePaused){
    frame++;
    var pt = doubleTimer > 0 ? 2 : 1;
    score += pt;
    shieldTimer = Math.max(0, shieldTimer - 1);
    if(!shieldTimer) shield = false;
    slowTimer = Math.max(0, slowTimer - 1);
    doubleTimer = Math.max(0, doubleTimer - 1);
    magnetTimer = Math.max(0, magnetTimer - 1);
    if(lastGrazeFrame > 0 && frame - lastGrazeFrame > 55){
      combo = 0;
      lastGrazeFrame = 0;
    }
    spawnCooldown -= 1;
    if(spawnCooldown <= 0){
      spawnHazard();
      spawnCooldown = nextSpawnDelayFrames();
    }
    if(waveTimer > 0){
      waveTimer -= 1;
      if(waveTimer <= 0){
        waveMode = 'normal';
        waveTimer = 0;
      }
    }
    if(waveAnnounceTimer > 0) waveAnnounceTimer -= 1;
    if(waveAnnounceSubTimer > 0) waveAnnounceSubTimer -= 1;
    nextWaveRoll -= 1;
    if(nextWaveRoll <= 0){
      rollWave();
      nextWaveRoll = 380 + Math.floor(Math.random() * 220);
    }
    if(phaseTagTimer > 0) phaseTagTimer -= 1;
    if(phaseTagTimer <= 0 && frame > 120 && frame % 540 === 0){
      var tips = [
        '\u0411\u0440\u043e\u0441\u043a\u0438 \u0432\u043f\u043b\u043e\u0442\u043d\u0443\u044e \u2014 \u043a\u043e\u043c\u0431\u043e \u0438 \u043e\u0447\u043a\u0438',
        '\u0412\u043e\u043b\u043d\u044b: \u043d\u0430\u043b\u0451\u0442, \u043e\u0431\u0441\u0430\u0434\u0430, \u043c\u0435\u0442\u0435\u043e\u0437\u0430\u0432\u0440\u0438\u0445',
        '\u041c\u0438\u043d\u043d\u043e\u0435 \u043f\u043e\u043b\u0435 \u2014 \u0441\u0435\u0442\u043a\u0430 \u043e\u0441\u043a\u043e\u043b\u043a\u043e\u0432 \u0441\u0432\u0435\u0440\u0445\u0443',
        '\u041d\u0438\u0436\u0435 \u2014 AI, \u043a\u0442\u043e \u043f\u0435\u0440\u0432\u044b\u0439 \u043d\u0430\u0431\u0435\u0440\u0451\u0442 \u043e\u0447\u043a\u0438',
        '\u041a\u043e\u043c\u0435\u0442\u0430 \u043c\u0435\u0434\u043b\u0435\u043d\u043d\u0430\u044f, \u043d\u043e \u0436\u0438\u0440\u043d\u0430\u044f'
      ];
      phaseTag = tips[Math.floor(Math.random() * tips.length)];
      phaseTagTimer = 150;
    }
    player.x += (touchX - player.x) * 0.2;
    player.x = Math.max(player.r, Math.min(W - player.r, player.x));
    if(bot && bot.alive){
      updateBotAI();
      botScore += pt * 0.92;
    }
  }

  for(let i = meteors.length - 1; i >= 0; i--){
    const m = meteors[i];
    if(magnetTimer > 0 && m.pickup){
      var pdx = player.x - m.x, pdy = player.y - m.y;
      var pd = Math.sqrt(pdx * pdx + pdy * pdy);
      if(pd > 10){
        m.x += (pdx / pd) * 3.2;
        m.y += (pdy / pd) * 2.6;
      }
    }
    if(m.kind === 'hunter' && alive && !m.pickup){
      var steer = (player.x - m.x) * 0.022;
      m.vx += steer;
      m.vx = Math.max(-2.8, Math.min(2.8, m.vx));
    }
    if(waveMode === 'wind'){
      m.vx += windX * 0.062;
    }
    m.y += m.vy; m.x += m.vx; m.rot += m.rotV;
    if(m.kind === 'comet'){
      m.tail = (m.tail || 0) + 1;
      if((m.tail % 3) === 0) particles.push({ x: m.x, y: m.y + m.r, vx: (Math.random() - 0.5) * 1.2, vy: 1.2 + Math.random() * 1.5, r: 2 + Math.random() * 3, alpha: 0.75, color: 'rgba(255,183,77,0.9)', decay: 0.04 });
    }
    if(m.y > H + 80 || m.x < -120 || m.x > W + 120){ meteors.splice(i, 1); continue; }

    if(alive){
      const dx = m.x - player.x, dy = m.y - player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      var hitPad = m.kind === 'shard' || m.kind === 'bolt' ? 2 : (m.kind === 'comet' ? 4 : 6);
      if(m.pickup) hitPad = 0;
      var hitR = m.r + player.r - hitPad;
      var pt = doubleTimer > 0 ? 2 : 1;

      if(!m.pickup && !m.grazeDone && dist >= hitR && dist < hitR + 22){
        var bonus = (5 + Math.min(25, combo * 3)) * pt;
        score += bonus;
        combo += 1;
        lastGrazeFrame = frame;
        if(combo > sessionMaxCombo) sessionMaxCombo = combo;
        addFloatText(m.x, m.y - m.r - 8, '+' + bonus + (combo > 1 ? ' x' + combo : ''), '#7cf5c8');
        m.grazeDone = true;
        hapticLight();
      }

      if(dist < hitR){
        if(m.pickup){
          if(m.kind === 'shield'){
            shield = true; shieldTimer = 320;
            addPfx(m.x, m.y, '#00e5ff', 18);
            meteors.splice(i, 1);
            hapticMedium();
            continue;
          }
          if(m.kind === 'slow'){
            slowTimer = Math.max(slowTimer, 380);
            addPfx(m.x, m.y, '#7dd3fc', 14);
            meteors.splice(i, 1);
            hapticLight();
            continue;
          }
          if(m.kind === 'double'){
            doubleTimer = Math.max(doubleTimer, 420);
            addPfx(m.x, m.y, '#ffd54f', 16);
            meteors.splice(i, 1);
            hapticMedium();
            continue;
          }
          if(m.kind === 'magnet'){
            magnetTimer = Math.max(magnetTimer, 480);
            addPfx(m.x, m.y, '#e879f9', 20);
            meteors.splice(i, 1);
            hapticMedium();
            addFloatText(m.x, m.y - 20, '\u041c\u0410\u0413\u041d\u0418\u0422!', '#f0abfc', 60);
            continue;
          }
        } else if(shield){
          shield = false; shieldTimer = 0;
          addPfx(m.x, m.y, '#00e5ff', 15);
          meteors.splice(i, 1);
          hapticLight();
          continue;
        } else {
          alive = false;
          combo = 0;
          const roundScore = Math.floor(score / 10);
          if(roundScore > bestScore){
            bestScore = roundScore;
            persistBest();
          }
          addPfx(player.x, player.y, '#ff2d55', 30);
          screenShake = 22;
          hapticHeavy();
          raceOver = true;
          if(bot && bot.alive){
            raceResult = Math.floor(score / 10) >= Math.floor(botScore / 10) ? 'duel_win' : 'duel_loss';
          } else {
            raceResult = 'player_dead';
          }
        }
      }
    }

    if(bot && bot.alive && !m.pickup){
      var bdx = m.x - bot.x, bdy = m.y - bot.y;
      var bdist = Math.sqrt(bdx * bdx + bdy * bdy);
      var bPad = m.kind === 'shard' || m.kind === 'bolt' ? 2 : (m.kind === 'comet' ? 4 : 6);
      var bHitR = m.r + bot.r - bPad;
      if(bdist < bHitR){
        bot.alive = false;
        addPfx(bot.x, bot.y, '#a78bfa', 28);
        addFloatText(bot.x, bot.y - 28, 'AI \u2192 BOOM', '#c4b5fd', 65);
        screenShake = Math.max(screenShake, 12);
        hapticMedium();
      }
    }

    ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(m.rot);
    if(m.pickup){
      if(m.kind === 'shield'){
        ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 14;
        ctx.fillStyle = '#00e5ff';
      } else if(m.kind === 'slow'){
        ctx.shadowColor = '#38bdf8'; ctx.shadowBlur = 12;
        ctx.fillStyle = '#7dd3fc';
      } else if(m.kind === 'magnet'){
        ctx.shadowColor = '#e879f9'; ctx.shadowBlur = 16;
        ctx.fillStyle = '#e879f9';
      } else {
        ctx.shadowColor = '#ffd54f'; ctx.shadowBlur = 14;
        ctx.fillStyle = '#ffd54f';
      }
      ctx.beginPath(); ctx.arc(0, 0, m.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#0d1b4a'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var sym = m.kind === 'shield' ? '\u{1F6E1}' : (m.kind === 'slow' ? '\u2744' : (m.kind === 'magnet' ? '\u{1F9F2}' : '\u2B50'));
      ctx.fillText(sym, 0, 1);
    } else if(m.kind === 'bolt'){
      ctx.shadowColor = '#fff59d'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#fffde7';
      ctx.beginPath();
      ctx.moveTo(0, -m.r * 1.2);
      ctx.lineTo(m.r * 0.5, 0);
      ctx.lineTo(0, m.r * 1.1);
      ctx.lineTo(-m.r * 0.5, 0);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
    } else if(m.kind === 'comet'){
      ctx.shadowColor = '#ffb74d'; ctx.shadowBlur = 18;
      const cg = ctx.createRadialGradient(0, 0, 1, 0, 0, m.r);
      cg.addColorStop(0, '#fff8e1'); cg.addColorStop(0.45, '#ff9800'); cg.addColorStop(1, '#bf360c');
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(0, 0, m.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      const grd = ctx.createRadialGradient(0, 0, 2, 0, 0, m.r);
      if(m.kind === 'shard'){
        grd.addColorStop(0, '#e1bee7'); grd.addColorStop(0.55, '#ab47bc'); grd.addColorStop(1, '#311b92');
      } else {
        grd.addColorStop(0, '#ff9800'); grd.addColorStop(0.5, '#f44336'); grd.addColorStop(1, '#4a1010');
      }
      if(m.kind === 'shard' && m.mineSeed){
        ctx.strokeStyle = 'rgba(244,114,182,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(0, 0, m.r + 2, 0, Math.PI * 2); ctx.stroke();
      }
      var spikes = m.kind === 'shard' ? 6 : 8;
      ctx.beginPath();
      for(let k = 0; k < spikes; k++){
        const a = (k / spikes) * Math.PI * 2;
        const rr = m.r * (0.7 + 0.3 * Math.sin(k * 2.3 + m.rot));
        if(k === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  for(let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.alpha -= p.decay;
    if(p.alpha <= 0){ particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  if(alive || particles.length || (bot && bot.alive)){
    ctx.save(); ctx.translate(player.x, player.y);

    const trail = ctx.createRadialGradient(0, 26, 0, 0, 26, 18);
    trail.addColorStop(0, 'rgba(96,165,250,0.8)'); trail.addColorStop(1, 'rgba(96,165,250,0)');
    ctx.fillStyle = trail;
    fillEllipse(0, 26, 7, 15 + Math.sin(frame * 0.25) * 4, 0);

    if(shield){
      ctx.strokeStyle = 'rgba(0,229,255,' + (0.5 + Math.sin(frame * 0.12) * 0.3) + ')';
      ctx.lineWidth = 2.5; ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.arc(0, 0, player.r + 11, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    if(magnetTimer > 0){
      ctx.strokeStyle = 'rgba(232,121,249,' + (0.35 + Math.sin(frame * 0.2) * 0.25) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, player.r + 18, 0, Math.PI * 2); ctx.stroke();
    }

    const sg = ctx.createLinearGradient(0, -player.r, 0, player.r);
    sg.addColorStop(0, '#e0e0ff'); sg.addColorStop(1, '#7c3aed');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(0, -player.r);
    ctx.lineTo(-player.r * 0.6, player.r * 0.5);
    ctx.lineTo(0, player.r * 0.2);
    ctx.lineTo(player.r * 0.6, player.r * 0.5);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = '#00e5ff'; ctx.globalAlpha = 0.75;
    fillEllipse(0, -player.r * 0.2, 5, 7, 0);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  if(bot && bot.alive){
    ctx.save(); ctx.translate(bot.x, bot.y);
    const bt = ctx.createRadialGradient(0, 18, 0, 0, 18, 14);
    bt.addColorStop(0, 'rgba(167,139,250,0.75)'); bt.addColorStop(1, 'rgba(167,139,250,0)');
    ctx.fillStyle = bt;
    fillEllipse(0, 18, 5, 11, 0);
    const bg2 = ctx.createLinearGradient(0, -bot.r, 0, bot.r);
    bg2.addColorStop(0, '#f5f3ff'); bg2.addColorStop(1, '#6d28d9');
    ctx.fillStyle = bg2;
    ctx.beginPath();
    ctx.moveTo(0, -bot.r);
    ctx.lineTo(-bot.r * 0.55, bot.r * 0.48);
    ctx.lineTo(0, bot.r * 0.15);
    ctx.lineTo(bot.r * 0.55, bot.r * 0.48);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#c4b5fd'; ctx.globalAlpha = 0.9;
    fillEllipse(0, -bot.r * 0.15, 4, 6, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('AI', 0, 3);
    ctx.restore();
  }

  for(let fi = floatTexts.length - 1; fi >= 0; fi--){
    var ft = floatTexts[fi];
    ft.life -= 1;
    ft.y += ft.vy;
    if(ft.life <= 0){ floatTexts.splice(fi, 1); continue; }
    var a = ft.life / ft.maxLife;
    ctx.globalAlpha = Math.min(1, a * 1.2);
    ctx.fillStyle = ft.color;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ft.text, ft.x, ft.y);
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  fillRoundRect(W / 2 - 65, 12, 130, 36, 18);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('\u2B50 ' + Math.floor(score / 10), W / 2, 34);
  if(bot){
    ctx.fillStyle = 'rgba(167,139,250,0.85)'; ctx.font = 'bold 13px sans-serif';
    ctx.fillText('AI ' + Math.floor(botScore / 10), W / 2, 50);
  }
  ctx.fillStyle = 'rgba(255,215,120,0.9)'; ctx.font = 'bold 11px sans-serif';
  ctx.fillText('\u{1F3C6} ' + bestScore, W / 2, 64);

  var lb = 12;
  if(shield){
    var shH = (shieldTimer > 0 && shieldTimer < 90) ? 46 : 32;
    ctx.fillStyle = 'rgba(0,229,255,0.2)';
    fillRoundRect(10, lb, 95, shH, 16);
    ctx.fillStyle = '#00e5ff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('\u{1F6E1} \u0417\u0410\u0429\u0418\u0422\u0410', 18, lb + 20);
    if(shieldTimer > 0 && shieldTimer < 90){
      ctx.fillStyle = 'rgba(255,180,100,0.95)'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText('\u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c ~' + Math.ceil(shieldTimer / 60) + ' \u0441\u0435\u043a', 18, lb + 38);
    }
    lb += shH + 6;
  }

  if(slowTimer > 0){
    ctx.fillStyle = 'rgba(56,189,248,0.2)';
    fillRoundRect(10, lb, 108, 30, 15);
    ctx.fillStyle = '#7dd3fc'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('\u2744 \u0417\u0410\u041c\u0415\u0414\u041b.', 18, lb + 20);
    lb += 38;
  }

  if(doubleTimer > 0){
    ctx.fillStyle = 'rgba(255,213,79,0.2)';
    fillRoundRect(10, lb, 118, 30, 15);
    ctx.fillStyle = '#ffd54f'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('\u2B50 x2 \u041e\u0427\u041a\u0418', 18, lb + 20);
    lb += 38;
  }

  if(magnetTimer > 0){
    ctx.fillStyle = 'rgba(232,121,249,0.22)';
    fillRoundRect(10, lb, 124, 30, 15);
    ctx.fillStyle = '#e879f9'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('\u{1F9F2} \u041c\u0410\u0413\u041d\u0418\u0422', 18, lb + 20);
  }

  if(combo > 1 && alive){
    ctx.fillStyle = 'rgba(124,245,200,0.25)';
    fillRoundRect(W / 2 - 52, H - 56, 104, 28, 14);
    ctx.fillStyle = '#7cf5c8'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('COMBO x' + combo, W / 2, H - 36);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'right';
  ctx.fillText('LVL ' + (1 + Math.floor(diff01() * 24)), W - 12, 34);

  if(waveMode !== 'normal' && waveStartTimer > 0 && waveTimer > 0){
    var wr = waveTimer / waveStartTimer;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    fillRoundRect(W - 92, 58, 82, 8, 4);
    ctx.fillStyle = 'rgba(96,165,250,0.95)';
    ctx.beginPath();
    ctx.rect(W - 90, 60, 78 * wr, 4);
    ctx.fill();
  }

  if(waveAnnounceTimer > 0 && waveAnnounce){
    ctx.fillStyle = 'rgba(255,61,113,0.35)';
    fillRoundRect(W / 2 - 158, H * 0.2, 316, 40, 20);
    ctx.fillStyle = '#ffb3c6'; ctx.font = 'bold 17px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(waveAnnounce, W / 2, H * 0.2 + 26);
  }
  if(waveAnnounceSubTimer > 0 && waveAnnounceSub){
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    fillRoundRect(W / 2 - 165, H * 0.2 + 46, 330, 26, 13);
    ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(waveAnnounceSub, W / 2, H * 0.2 + 64);
  }

  if(phaseTagTimer > 0 && phaseTag){
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    fillRoundRect(W / 2 - 150, H * 0.12, 300, 28, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(phaseTag, W / 2, H * 0.12 + 19);
  }

  if(gamePaused && alive){
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('\u041f\u0410\u0423\u0417\u0410', W / 2, H / 2 - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = '14px sans-serif';
    ctx.fillText('\u0412\u0435\u0440\u043d\u0438\u0441\u044c \u0432 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435', W / 2, H / 2 + 18);
  }

  if(frame < 110 && alive){
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('\u0414\u0432\u0438\u0433\u0430\u0439 \u043c\u044b\u0448\u043a\u043e\u0439 / \u043f\u0430\u043b\u044c\u0446\u0435\u043c', W / 2, H - 52);
    ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.font = '12px sans-serif';
    ctx.fillText('\u0412\u0432\u0435\u0440\u0445\u0443 \u2014 \u0442\u044b, \u0432\u043d\u0438\u0437\u0443 \u2014 AI. \u041a\u0442\u043e \u043d\u0430\u0431\u0435\u0440\u0451\u0442 \u0431\u043e\u043b\u044c\u0448\u0435 \u043e\u0447\u043a\u043e\u0432?', W / 2, H - 30);
    ctx.fillStyle = 'rgba(255,200,220,0.45)'; ctx.font = '11px sans-serif';
    ctx.fillText('\u041c\u0438\u043d\u043d\u043e\u0435 \u043f\u043e\u043b\u0435 \u2014 \u0440\u043e\u0437\u043e\u0432\u0430\u044f \u0441\u0435\u0442\u043a\u0430 \u043e\u0441\u043a\u043e\u043b\u043a\u043e\u0432', W / 2, H - 12);
  }

  if(!alive){
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect(0, 0, W, H);
    var ps = Math.floor(score / 10);
    var bs = Math.floor(botScore / 10);
    var duelLine = '';
    if(raceResult === 'duel_win') duelLine = '\u0413\u043e\u043d\u043a\u0430: \u0442\u044b \u0432\u044b\u0438\u0433\u0440\u0430\u043b (' + ps + ' \u2014 ' + bs + ')';
    else if(raceResult === 'duel_loss') duelLine = '\u0413\u043e\u043d\u043a\u0430: AI \u0432\u043f\u0435\u0440\u0435\u0434\u0438 (' + ps + ' \u2014 ' + bs + ')';
    else duelLine = '\u0413\u043e\u043d\u043a\u0430: ' + ps + ' \u2014 ' + bs;
    ctx.fillStyle = '#ff2d55'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('\u{1F4A5} CRASH!', W / 2, H / 2 - 88);
    ctx.fillStyle = '#a78bfa'; ctx.font = 'bold 17px sans-serif';
    ctx.fillText(duelLine, W / 2, H / 2 - 48);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 26px sans-serif';
    ctx.fillText('\u0421\u0447\u0451\u0442: ' + ps, W / 2, H / 2 - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '16px sans-serif';
    ctx.fillText('\u0420\u0435\u043a\u043e\u0440\u0434: ' + bestScore, W / 2, H / 2 + 22);
    if(sessionMaxCombo > 1){
      ctx.fillStyle = '#7cf5c8'; ctx.font = 'bold 15px sans-serif';
      ctx.fillText('\u041c\u0430\u043a\u0441 combo: x' + sessionMaxCombo, W / 2, H / 2 + 52);
    }
    ctx.fillStyle = '#ffd600'; ctx.font = 'bold 18px sans-serif';
    ctx.fillText('\u041a\u043b\u0438\u043a / \u0442\u0430\u043f \u2014 \u0441\u043d\u043e\u0432\u0430', W / 2, H / 2 + 86);
  }
  }catch(err){
    if(typeof console !== 'undefined' && console.error) console.error(err);
  }
}

function bootTelegram(){
  if(!tg) return;
  tg.ready();
  tg.expand();
  if(tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  const p = tg.themeParams || {};
  if(p.bg_color) document.querySelector('meta[name="theme-color"]').setAttribute('content', p.bg_color);
  if(typeof tg.setHeaderColor === 'function'){
    try{ tg.setHeaderColor('secondary_bg_color'); }catch(e){}
  }
  tg.onEvent('viewportChanged', function(){
    resize();
    initStars();
  });
}

document.addEventListener('visibilitychange', function(){
  gamePaused = document.hidden;
});
window.addEventListener('pagehide', function(){
  gamePaused = true;
});

resize();
player = { x: W / 2, y: H * 0.76, r: 20 };
bot = { x: W * 0.5, y: H * 0.86, r: 16, alive: true };
meteors = []; particles = []; floatTexts = [];
score = 0; alive = true; frame = 0;
botScore = 0;
raceOver = false;
raceResult = '';
baseSpeed = 2.05;
slowTimer = 0; doubleTimer = 0; magnetTimer = 0;
touchX = W / 2; shield = false; shieldTimer = 0;
spawnCooldown = 28;
phaseTag = ''; phaseTagTimer = 0;
waveMode = 'normal'; waveTimer = 0;
waveAnnounce = ''; waveAnnounceTimer = 0;
waveAnnounceSub = ''; waveAnnounceSubTimer = 0;
nextWaveRoll = 400 + Math.floor(Math.random() * 120);
waveStartTimer = 0;
combo = 0; sessionMaxCombo = 0; lastGrazeFrame = 0;
screenShake = 0; windX = 0;
initStars();
bootTelegram();

window.addEventListener('resize', function(){
  resize();
  initStars();
});
window.addEventListener('orientationchange', function(){
  setTimeout(function(){ resize(); initStars(); }, 200);
});

loop();
