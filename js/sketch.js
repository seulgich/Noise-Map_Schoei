const isMac = /Mac/i.test(navigator.platform);
//  Acknowledgement: This code includes assistance from an AI (gemini and antigravity).

// NYC Noise — Raw Points + Borough Initials (Polygon-Accurate) + Click Zoom
// Vivid per-type colors, Other=▽, Legend+Time at top-left
// Drag the ⏱ time badge to scrub hour; H: history on/off; D: density sizing; O/P: density cell size
// Auto Fit: F (hour), Shift+F (all)  •  On-load auto-fit once
// Status overlay on loading/fetch-fail/empty
// Pure white background; markers without halo; initials pure white

let DAYS = 30;
let PLAY = true;
let SPEED = 3.0;
let currentHour = 20;
let nyFont;
let iconPlay, iconPause, iconZoomIn, iconZoomOut, iconReset;
let mic, fft, liveActiveType = '', liveAudioLevel = 0, organicTime = 0;
let bass = 0, mid = 0, treble = 0, energy = 0;
let lines = [];

let flowScale = 22;
let flowCols, flowRows;
let flowField = [];
let particles = [];
let flowZOff = 0;  // flow field 시간축

// Sound
let soundOn = false;
let audioInitialized = false;
let micReactionOn = true;
let SHOW_SOUND_UI = true;
let oscillators = {};
let masterGain;
const SOUND_FADE_TIME = 0.0; // seconds

const SOUND_PARAMS = {
  Residential: { freq: 440.0, type: 'sine' },
  Commercial: { freq: 330.0, type: 'sawtooth' },
  Street: { freq: 220.0, type: 'square' },
  Vehicle: { freq: 110.0, type: 'triangle' },
  Park: { freq: 550.0, type: 'sine' },
  Other: { freq: 150.0, type: 'sine' }
};


const TYPES = ['Residential', 'Commercial', 'Street', 'Vehicle', 'Park', 'Other'];
let enabled = Object.fromEntries(TYPES.map(k => [k, true]));

// Vivid palette
const COLORS = {
  Residential: [65, 240, 35],   // green
  Commercial: [170, 60, 255],   // purple
  Street: [0, 180, 255],   // blue
  Vehicle: [255, 60, 80],    // red
  Park: [160, 110, 60],  // brown
  Other: [180, 180, 180]   // grey fallback
};

// Margins & UI
const M = { l: 8, r: 8, t: 8, b: 8 };
const UI = { left: 16, top: 16, gap: 10 };

let rows = [];                // {t:Date, lat, lon, type, init}
let pointByHourType = null;   // [24][type] -> array of points {lat,lon,init}
let bbox = null;
let projector = null;
let statusMsg = 'Loading…';
let hoveredBorough = '';

// View (zoom/pan)
let viewScale = 1.0;
let viewOffset = { x: 0, y: 0 };
let SHOW_LEGEND = true;
let SHOW_HISTORY = false;      // H key

// Density sizing
let DENSITY_SIZE = true;      // D key
let D_CELL_BASE = 28;         // px screen-space; O/P to adjust
let D_MAX_SCALE = 1.8;
let D_CAP = 12;

// Time badge drag state
let draggingTime = false;

// Fit flags
let DID_AUTO_FIT_ONCE = false;
const FIT_PAD = 8;
const MAX_DOTS = 1000; // Max dots for live sound visualization

// Performance optimization: Layer caching
let cachedLayers = {}; // Store pre-rendered graphics for each hour
let preCalculatedDisplacements = null; // Pre-calculated noise values

function preload() {
  iconPlay = loadImage('icons/play.svg');
  iconPause = loadImage('icons/pause.svg');
  iconZoomIn = loadImage('icons/zoomin.svg');
  iconZoomOut = loadImage('icons/zoomout.svg');
  iconReset = loadImage('icons/reset.svg');
}

function setup() {
  pixelDensity(window.devicePixelRatio || 2);
  createCanvas(windowWidth, windowHeight);
  if (isMac) {
    textFont("-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif");
  }
  frameRate(60);

  // Initialize Sound (Original data-driven sound is disabled for Live Mode)
  masterGain = new p5.Gain();
  masterGain.connect();
  masterGain.amp(0); // Start silent

  for (const type of TYPES) {
    const osc = new p5.Oscillator(SOUND_PARAMS[type].type);
    osc.freq(SOUND_PARAMS[type].freq);
    osc.amp(0);
    osc.start();
    osc.connect(masterGain);
    oscillators[type] = osc;
  }

  Promise.all([loadData(), loadBoroughs(BORO_URL)]).then(() => {
    buildBoroughIndex();
    statusMsg = (statusMsg ? statusMsg + ' • ' : '') + (boroIndex ? 'boroughs OK' : 'boroughs missing');
    indexPoints();   // initials assigned by polygons (no heuristic)
  }).catch(e => {
    console.error(e);
    statusMsg = 'Fetch failed';
    redraw();
  });
  // --- Flow Field Disabled ---
  /*
  flowCols = floor(width / flowScale);
  flowRows = floor(height / flowScale);
  flowField = new Array(flowCols * flowRows).fill(0);

  // 파티클들 생성 (간결하게 - 개수 줄임)
  for (let i = 0; i < 200; i++) {
    particles.push(new FlowParticle());
  }
  */
}

function getBoroughAt(x, y) {
  if (!boroIndex || !projector) return '';

  // Reverse the view transformation
  const mx = (x - viewOffset.x) / viewScale;
  const my = (y - viewOffset.y) / viewScale;

  // Inverse projection
  const lon = map(mx, M.l, M.l + (width - M.l - M.r), bbox.minLon, bbox.maxLon);
  const lat = map(my, M.t, M.t + (height - M.t - M.b), bbox.maxLat, bbox.minLat);

  for (const b of boroIndex) {

    // Optimization disabled for debugging to ensure no false negatives
    // if (lon < b.bbox.minLon || lon > b.bbox.maxLon || lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;

    for (const poly of b.polys) {
      const outer = poly[0];
      if (!pointInRing(lon, lat, outer)) continue;
      let inHole = false;
      for (let k = 1; k < poly.length; k++) {
        if (pointInRing(lon, lat, poly[k])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) {
        return b.name;
      }
    }
  }
  return '';
}

function classifyAudio6() {
  if (!fft) return 'Other';

  // --- 1. 기본 특징 추출 ---
  let spectrum = fft.analyze();
  let centroid = fft.getCentroid();

  // RMS
  let rms = 0;
  for (let v of spectrum) rms += v * v;
  rms = Math.sqrt(rms / spectrum.length);

  // ZCR
  let zcrCount = 0;
  for (let i = 1; i < spectrum.length; i++) {
    if ((spectrum[i] > 0) !== (spectrum[i - 1] > 0)) zcrCount++;
  }
  let zcr = zcrCount / spectrum.length;

  // Spectral flux
  let flux = 0;
  if (!window.prevSpectrum) window.prevSpectrum = spectrum.slice();
  for (let i = 0; i < spectrum.length; i++) {
    flux += Math.abs(spectrum[i] - window.prevSpectrum[i]);
  }
  window.prevSpectrum = spectrum.slice();

  // Normalize
  let loud = map(rms, 0, 2000, 0, 1, true);
  let bright = map(centroid, 0, 8000, 0, 1, true);
  let change = map(flux, 0, 8000, 0, 1, true);
  let crisp = map(zcr, 0, 0.2, 0, 1, true);

  if (loud > 0.7 && bright < 0.3 && change < 0.3) return 'Vehicle';
  if (loud > 0.5 && change > 0.5) return 'Street';
  if (bright > 0.6 && crisp > 0.6) return 'Residential';
  if (bright > 0.4 && crisp > 0.5 && change > 0.3) return 'Commercial';
  if (loud < 0.3 && bright < 0.3 && change < 0.3) return 'Park';

  return 'Other';
}



function draw() {
  // --- Live Audio Analysis (MOVED TO TOP) ---
  if (mic && fft && mic.enabled && micReactionOn) { // Check if mic, fft are ready and reaction is enabled
    fft.analyze();
    liveAudioLevel = mic.getLevel();
    bass = fft.getEnergy("bass");
    mid = fft.getEnergy("mid");
    treble = fft.getEnergy("treble");
  } else {
    // If audio not ready or reaction disabled, set defaults to avoid errors
    liveAudioLevel = 0;
    bass = 0; mid = 0; treble = 0;
  }

  // Adjust bass sensitivity to balance classification
  const adjustedBass = bass * 0.8; // Reduce bass influence slightly

  liveActiveType = classifyAudio6();

  // --- End Analysis ---

  // --- Static Black Background ---
  background(0);

  cursor(ARROW);

  // Calculate map transparency based on live audio level
  // User Requested: 투명도 변화 제거 (Fixed Opacity)
  let mapAlpha = 220; // Fixed high opacity

  // Calculate Line Distortion based on Volume
  // 0.3 threshold for sensitivity (lowered sensitivity). Scale massively for visual impact.
  const distortionAmount = map(liveAudioLevel, 0, 0.3, 0, 100); // React to louder sounds, distort up to 100px

  textStyle(NORMAL);
  // --- MAP AND UI DRAWING (Original Logic) ---

  // Status overlay if empty / loading / failed
  if (!pointByHourType || rows.length === 0) {
    noStroke();
    fill(220);
    textAlign(CENTER, CENTER);
    if (statusMsg) {
      textSize(16);
      text(statusMsg.toUpperCase(), width / 2, height / 2);
    } else {
      textSize(16);
      text("LOADING", width / 2, height / 2);
    }
    return; // Exit if still loading
  }

  const W = width - M.l - M.r;
  const H = height - M.t - M.b;

  projector = buildProjector(M.l, M.t, W, H);

  if (PLAY && !draggingTime) {
    const dt = deltaTime / 1000;
    currentHour = (currentHour + SPEED * dt) % 24;
  }
  const currentHourIndex = floor(currentHour); // Integer part of the current hour
  const currentHourFloor = floor(currentHour);
  const currentHourCeil = (currentHourFloor + 1) % 24; // Next hour, wrapping around
  const blendFactor = currentHour % 1; // Fractional part, 0 to 1

  if (soundOn) { updateSound(currentHourIndex); }

  // First-time auto fit (all data) — only if we have data
  if (!DID_AUTO_FIT_ONCE && rows.length > 0) {
    fitViewToAll();
    DID_AUTO_FIT_ONCE = true;
  }

  // Borough hover detection moved to mouseMoved() for performance

  // Transform
  push();
  translate(viewOffset.x, viewOffset.y);
  scale(viewScale);



  // 🔹 Intertwined drawing: alternate between vertical and horizontal lines
  // Draw 50% of vertical lines
  drawLiveLines(mapAlpha * (1 - blendFactor) * 0.5, currentHourFloor, distortionAmount);
  drawLiveLines(mapAlpha * blendFactor * 0.5, currentHourCeil, distortionAmount);

  // History layers (optional)
  if (SHOW_HISTORY) {
    drawHourLayer(hPrev2, mapAlpha * 0.5, distortionAmount);
    drawHourLayer(hPrev1, mapAlpha * 0.75, distortionAmount);
  }

  // Draw horizontal lines
  drawHourLayer(currentHourFloor, mapAlpha * (1 - blendFactor), distortionAmount);
  drawHourLayer(currentHourCeil, mapAlpha * blendFactor, distortionAmount);

  // Draw remaining 5% of vertical lines (on top, barely visible overlay)
  drawLiveLines(mapAlpha * (1 - blendFactor) * 0.05, currentHourFloor, distortionAmount);
  drawLiveLines(mapAlpha * blendFactor * 0.05, currentHourCeil, distortionAmount);


  pop(); // End of view transformations


  // --- UI Elements (drawn on top of map) ---

  // Top-left UI
  if (SHOW_LEGEND) {
    textSize(15);
    fill(255);
    noStroke();

    // 왼쪽 상단 제목 (Hover 기능 추가)
    const titleText = "NYC Noise Map — October 2025";
    const titleX = UI.left;
    const titleY = UI.top - 6;
    const titleW = textWidth(titleText);
    const titleH = 15; // Font size
    const isHoveringTitle = mouseX >= titleX && mouseX <= titleX + titleW && mouseY >= titleY && mouseY <= titleY + titleH;

    if (isHoveringTitle) {
      cursor('pointer');
      fill(120); // Dim color on hover
    } else {
      fill(255); // Normal color
    }
    textAlign(LEFT, TOP);
    text(titleText, titleX, titleY);

    // 원래 색상으로 복원 (시간 표시에 영향 없도록)
    fill(255);

    // 오른쪽 상단 시간
    textAlign(RIGHT, TOP);
    const hour12 = currentHourIndex % 12 === 0 ? 12 : currentHourIndex % 12;
    const suffix = currentHourIndex < 12 ? 'AM' : 'PM';
    text(`${hour12} ${suffix}`, width - 16, UI.top - 6);

    if (SHOW_LEGEND) {
      drawLegend(UI.left, UI.top + 30 + UI.gap);
    }
  }

  // Draw hovered borough name
  if (hoveredBorough) {
    const x = mouseX + 20; // Increased offset
    const y = mouseY + 20;
    textSize(14); // Slightly larger text
    const tw = textWidth(hoveredBorough);
    const th = 14;
    const padding = 8;

    // Background box
    fill(0, 0, 0, 200); // Darker, more opaque background
    stroke(255, 255, 255, 100); // Subtle border
    strokeWeight(1);
    rect(x - padding, y - padding - th / 2, tw + padding * 2, th + padding * 2, 6);

    textAlign(LEFT, CENTER);
    text(hoveredBorough, x, y + 2); // Vertically centered adjustment
  }



  if (SHOW_LEGEND) { // Only draw controls if legend is shown
    drawControls();
  }

  // Sound status indicator (U key to toggle visibility)
  if (SHOW_SOUND_UI) {
    textAlign(LEFT, BOTTOM);
    textSize(12);
    fill(soundOn ? 'green' : 'red');
    text(`Sound: ${soundOn ? 'ON' : 'OFF'} (M to Play/Pause) | Mic Reaction: ${micReactionOn ? 'ON' : 'OFF'} (N to Toggle)`, UI.left, height - 16);
  }

  // --- WAVY LINE VISUALIZATION (New Logic, drawn on top) ---
  // This part should not call background(0)
  // liveAudioLevel, fft.analyze(), treble are already done at the top

  // 새로운 라인 생성 (소리 이벤트)
  /*
  if (liveAudioLevel > 0.05) {
    lines.push({
      amp: map(liveAudioLevel, 0, 1, 5, 150),
      high: treble,
      age: 0
    });
  }
 
  // 라인 그리기
  for (let ln of lines) {
    stroke(255, map(ln.age, 0, 100, 200, 0)); // White lines, fading out
    noFill();
    beginShape();
    for (let x = 0; x < width; x += 5) {
      let y = height/2
        + noise(x * 0.01, organicTime + ln.high * 0.005) * ln.amp;
      vertex(x, y);
    }
    endShape();
 
    ln.age++;
  }
 
  // 오래된 라인 제거
  lines = lines.filter(ln => ln.age < 100);
 
  organicTime += 0.01; // Use existing variable
*/
}

function drawControls() {
  const btnSize = 22;
  const gap = 6;
  const x0 = width - (16 + btnSize * 0.4); // 오른쪽 여백
  const y0 = height - (16 + btnSize * 0.4); // Consistent bottom margin

  const buttons = [
    { name: 'playpause', action: togglePlay },
    { name: 'reset', action: resetViewClick },
    { name: 'zoomout', action: zoomOut },
    { name: 'zoomin', action: zoomIn }
  ];

  push();
  noStroke();

  for (let i = 0; i < buttons.length; i++) {
    const bx = x0 - i * (btnSize + gap);
    const by = y0;
    const r = btnSize / 2;
    const isHover = dist(mouseX, mouseY, bx, by) < r;

    buttons[i].bounds = { x: bx, y: by, r: btnSize / 2 };

    // Draw icon - Forcing PNGs for cross-browser compatibility
    let img;
    if (buttons[i].name === 'playpause') img = PLAY ? iconPause : iconPlay;
    else if (buttons[i].name === 'reset') img = iconReset;
    else if (buttons[i].name === 'zoomout') img = iconZoomOut;
    else if (buttons[i].name === 'zoomin') img = iconZoomIn;

    if (img) {
      if (isHover) {
        cursor('pointer');
        tint(255, 180); // Semi-transparent on hover
      } else {
        tint(255, 255); // Opaque otherwise
      }
      imageMode(CENTER);
      image(img, bx, by, btnSize, btnSize);
      noTint();
    }
  }

  pop();
  window.__controlButtons = buttons;
}

/* ================= DRAW LAYERS ================= */

/* ================= DRAW LAYERS ================= */

function drawHourLayer(h, alpha = 220, distortion = 0) {
  if (!pointByHourType) return;

  // mid(중역대) 에너지로 “흐물거림” 세기를 조절
  const disintegrationAmount = 0;  // Disable wobbling effect

  // Calculate total complaints for the current hour to determine uniform stroke weight
  let totalComplaintsThisHour = 0;
  for (const ty of TYPES) {
    const pts = pointByHourType[h][ty];
    if (pts) {
      totalComplaintsThisHour += pts.length;
    }
  }

  // Map total complaints to stroke weight (scaled down for thinner lines)
  const dataDrivenStrokeWeight = constrain(map(totalComplaintsThisHour / 50, 0, 10, 0.1, 0.8), 0.1, 0.8); // Max 500 complaints / 50 = 10 for mapping
  const finalStrokeWeight = dataDrivenStrokeWeight / viewScale; // Adjust for zoom

  // Calculate viewport bounds in world coordinates to draw lines across the screen
  const leftX = (0 - viewOffset.x) / viewScale;
  const rightX = (width - viewOffset.x) / viewScale;

  for (const ty of TYPES) {
    if (!enabled[ty]) continue;
    const pts = pointByHourType[h][ty];
    if (!pts || pts.length === 0) continue;

    const col = COLORS[ty];

    noFill();
    strokeWeight(finalStrokeWeight); // Apply uniform stroke weight

    for (const p of pts) { // Iterate through each point
      const { x, y } = projector(p.lon, p.lat);

      // Simple organic displacement without expensive noise/sin calls
      const displacedY = y;

      stroke(col[0], col[1], col[2], alpha * 0.8);

      // Fragment into pixels when extremely loud (lowered sensitivity)
      if (liveAudioLevel > 0.5) { // Extreme volume threshold
        const dotSpacing = 5 / viewScale;
        strokeWeight(finalStrokeWeight * 2);
        for (let px = leftX; px <= rightX; px += dotSpacing) {
          point(px, displacedY);
        }
      } else {
        line(leftX, displacedY, rightX, displacedY);
      }
    }
  }
}

function updateSound(h) {
  if (!pointByHourType) return;

  for (const ty of TYPES) {
    if (!enabled[ty]) {
      if (oscillators[ty]) oscillators[ty].amp(0, 0.1);
      continue;
    }
    const pts = pointByHourType[h][ty];
    const count = pts ? pts.length : 0;

    // Map count to amplitude (0-50 complaints -> 0.0-0.4 amp)
    let targetAmp = map(count, 0, 50, 0, 0.4, true);

    if (oscillators[ty]) {
      oscillators[ty].amp(targetAmp, 0.1);
    }
  }
}

function setSound(state) {
  soundOn = state;
  const ctx = getAudioContext();
  
  if (soundOn) {
    if (ctx.state !== 'running') ctx.resume();
    masterGain.amp(0.5, SOUND_FADE_TIME); // Fade in
  } else {
    // 사운드를 끌 때, 마스터 볼륨과 모든 개별 오실레이터의 볼륨을 0으로 설정하고 컨텍스트를 일시정지
    masterGain.amp(0, SOUND_FADE_TIME);
    for (const type in oscillators) {
      if (oscillators[type]) oscillators[type].amp(0, SOUND_FADE_TIME);
    }
    if (ctx.state === 'running') ctx.suspend();
  }
}

function toggleSound() {
  setSound(!soundOn);
}


/* ================= DRAW LAYERS ================= */



function drawHourLayerSVG(g, projector, h, alpha = 220) {
  if (!pointByHourType) return;

  for (const ty of TYPES) {
    if (!enabled[ty]) continue;
    const pts = pointByHourType[h][ty];
    if (!pts || pts.length === 0) continue;

    const col = COLORS[ty];
    const projected = pts.map(p => projector(p.lon, p.lat));

    const gridRes = 100;
    const cellW = g.width / gridRes;
    const cellH = g.height / gridRes;
    const heights = Array.from({ length: gridRes }, () => Array(gridRes).fill(0));

    for (const p of projected) {
      const gx = Math.floor(p.x / cellW);
      const gy = Math.floor(p.y / cellH);
      if (gx >= 0 && gy >= 0 && gx < gridRes && gy < gridRes) {
        heights[gx][gy]++;
      }
    }

    const maxH = Math.max(...heights.flat());
    const contourLevels = [1, 3, 6, 10, 15, 25].filter(l => l < maxH);

    g.noFill();
    g.stroke(col[0], col[1], col[2], alpha * 0.8);
    g.strokeWeight(1.0);

    for (let level of contourLevels) {
      g.beginShape();
      for (let gx = 0; gx < gridRes; gx++) {
        for (let gy = 0; gy < gridRes; gy++) {
          const val = heights[gx][gy];
          if (val >= level - 0.5 && val <= level + 0.5) {
            const x = gx * cellW;
            const y = gy * cellH;
            g.vertex(x, y);
          }
        }
      }
      g.endShape();
    }
  }
}


/* ================= FIT TO CANVAS ================= */
function projectedBoundsAll() {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, found = false;
  for (let h = 0; h < 24; h++) {
    for (const ty of TYPES) {
      if (!enabled[ty]) continue;
      const pts = pointByHourType?.[h]?.[ty]; if (!pts) continue;
      for (const p of pts) {
        const { x, y } = projector(p.lon, p.lat);
        if (!isFinite(x) || !isFinite(y)) continue;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        found = true;
      }
    }
  }
  if (!found) return null;
  return { minx, miny, maxx, maxy };
}
function projectedBoundsHour(h) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, found = false;
  for (const ty of TYPES) {
    if (!enabled[ty]) continue;
    const pts = pointByHourType?.[h]?.[ty]; if (!pts) continue;
    for (const p of pts) {
      const { x, y } = projector(p.lon, p.lat);
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      found = true;
    }
  }
  if (!found) {
    const cx = M.l + (width - M.l - M.r) / 2;
    const cy = M.t + (height - M.t - M.b) / 2;
    return { minx: cx - 10, miny: cy - 10, maxx: cx + 10, maxy: cy + 10 };
  }
  return { minx, miny, maxx, maxy };
}
function fitViewToRect(minx, miny, maxx, maxy, padPx = FIT_PAD) {
  const sw = maxx - minx, sh = maxy - miny;
  const availW = width - padPx * 2;
  const availH = height - padPx * 2;
  const sX = availW / max(1, sw);
  const sY = availH / max(1, sh);
  const s = min(sX, sY);
  viewScale = s;
  viewOffset.x = padPx - s * minx;
  viewOffset.y = padPx - s * miny;
}
function fitViewToAll() {
  const b = projectedBoundsAll();
  if (!b) { viewScale = 1; viewOffset = { x: 0, y: 0 }; return; }
  fitViewToRect(b.minx, b.miny, b.maxx, b.maxy, FIT_PAD);
}
function fitViewToHour(h) {
  const b = projectedBoundsHour(h);
  fitViewToRect(b.minx, b.miny, b.maxx, b.maxy, FIT_PAD);
  redraw();
}

/* ================= LEFT-TOP UI ================= */
function timeBadgeBounds(hour) {
  textSize(12);
  const label = `⏱ ${hour.toString().padStart(2, '0')}:00`;
  const tw = textWidth(label);
  const x = UI.left, y = UI.top;
  return { x: x - 8, y: y - 8, w: tw + 24, h: 28 };
}
function drawTimeBadge(x, y, hour, active = false) {
  const label = `${hour.toString().padStart(2, '0')}:00`;
  const trackW = 80;
  const trackH = 1;

  noStroke();
  fill(225);
  textAlign(LEFT, CENTER);
  textSize(12);
  text(label, x, y - 10);

  const x0 = x;
  const x1 = x + trackW;
  const yTrack = y + 6;

  stroke(225);
  strokeWeight(trackH * 0.7);
  line(x0, yTrack, x1, yTrack);

  const hx = map(hour + 0.5, 0, 24, x0, x1);
  noStroke();
  fill(active ? 255 : 200);
  circle(hx, yTrack, 6);
}
function drawLegend(x0 = 16, y0 = 16) {
  const rowH = 22;
  const cardW = 140;

  for (let i = 0; i < TYPES.length; i++) {
    const ty = TYPES[i];
    const y = y0 + i * rowH;
    const col = COLORS[ty];
    const isEnabled = enabled[ty];
    const isHover = mouseX > x0 - 12 && mouseX < x0 + cardW &&
      mouseY > y - rowH / 2 && mouseY < y + rowH / 2;

    let textFill;
    if (isHover) {
      cursor('pointer');
      textFill = color(120); // Dim color on hover
    } else {
      textFill = isEnabled ? color(225) : color(160);
    }

    const iconFill = isEnabled ? color(col[0], col[1], col[2]) : color(200);

    noStroke();
    fill(iconFill);
    circle(x0 + 6, y, 8);

    noStroke();
    fill(textFill);
    textSize(15);
    textAlign(LEFT, CENTER);
    textStyle(NORMAL); // Ensure text is always normal style
    text(ty, x0 + 20, y);
  }
}


/* ================= DATA ================= */
async function loadData() {
  try {
    const data = await new Promise((resolve, reject) => {
      loadTable('data/filtered_october.csv', 'csv', 'header', resolve, reject);
    });
    const cLat = data.columns.find(c => c.toLowerCase().includes('latitude')) || 'Latitude';
    const cLon = data.columns.find(c => c.toLowerCase().includes('longitude')) || 'Longitude';
    const cDate = data.columns.find(c => c.toLowerCase().includes('created_date') || c.toLowerCase().includes('created date')) || 'Created Date';
    const cType = data.columns.find(c => c.toLowerCase().includes('complaint_type') || c.toLowerCase().includes('complaint type')) || 'Complaint Type';
    const cDesc = data.columns.find(c => c.toLowerCase().includes('descriptor')) || 'Descriptor';

    rows = [];
    for (const r of data.getRows()) {
      const lat = parseFloat(r.getString(cLat)), lon = parseFloat(r.getString(cLon));
      if (!isFinite(lat) || !isFinite(lon)) continue;
      
      const typeStr = r.getString(cType);
      const descStr = r.getString(cDesc);
      rows.push({ t: new Date(r.getString(cDate)), lat, lon, type: classify({ complaint_type: typeStr, descriptor: descStr }), init: '' });
    }
    statusMsg = `Loaded ${rows.length} records`;
    if (rows.length === 0) statusMsg += ' (no rows found in the CSV file)';
  } catch (e) {
    console.error(e);
    statusMsg = 'Error loading or parsing the CSV file';
    rows = [];
  }
}
function indexPoints() {
  // initials by polygon ONLY (no heuristic fallback)
  for (const p of rows) {
    p.init = (boroIndex ? boroughInitialByPolygon(p.lon, p.lat) : '');
  }
  pointByHourType = Array.from({ length: 24 }, () => Object.fromEntries(TYPES.map(k => [k, []])));
  for (const p of rows) {
    const h = p.t.getHours();
    pointByHourType[h][p.type].push({ lat: p.lat, lon: p.lon, init: p.init });
  }
}

/* ================= BOROUGH POLYGONS (accurate) ================= */
const BORO_URL = 'https://data.cityofnewyork.us/resource/gthc-hcne.geojson';
let boroIndex = null; // [{initial, polys, bbox}]

async function loadBoroughs(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('boroughs ' + r.status);
  const gj = await r.json();
  window.__BORO_GJ = gj;
} function buildBoroughIndex() {
  const gj = window.__BORO_GJ; if (!gj) { boroIndex = null; return; }
  const initMap = { 'Manhattan': 'M', 'Brooklyn': 'B', 'Queens': 'Q', 'Bronx': 'X', 'Staten Island': 'S' };
  let allBoroughsBBox = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
  boroIndex = gj.features.map(f => {
    const name = f.properties.boro_name || f.properties.name || '';
    const geom = f.geometry;
    const polys = (geom.type === 'Polygon') ? [geom.coordinates] : geom.coordinates; // MultiPolygon 지원
    const bb = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
    for (const poly of polys) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < bb.minLon) bb.minLon = lon;
          if (lon > bb.maxLon) bb.maxLon = lon;
          if (lat < bb.minLat) bb.minLat = lat;
          if (lat > bb.maxLat) bb.maxLat = lat;
        }
      }
    }
    allBoroughsBBox.minLon = min(allBoroughsBBox.minLon, bb.minLon);
    allBoroughsBBox.maxLon = max(allBoroughsBBox.maxLon, bb.maxLon);
    allBoroughsBBox.minLat = min(allBoroughsBBox.minLat, bb.minLat);
    allBoroughsBBox.maxLat = max(allBoroughsBBox.maxLat, bb.maxLat);
    return { initial: initMap[name] || name?.[0] || '', name: name, polys, bbox: bb };
  });
  // Add padding to the overall bounding box
  const frac = 0.01, dLat = (allBoroughsBBox.maxLat - allBoroughsBBox.minLat) * frac, dLon = (allBoroughsBBox.maxLon - allBoroughsBBox.minLon) * frac;
  bbox = { minLat: allBoroughsBBox.minLat - dLat, maxLat: allBoroughsBBox.maxLat + dLat, minLon: allBoroughsBBox.minLon - dLon, maxLon: allBoroughsBBox.maxLon + dLon };
}
function boroughInitialByPolygon(lon, lat) {
  if (!boroIndex) return '';
  for (const b of boroIndex) {
    if (lon < b.bbox.minLon || lon > b.bbox.maxLon || lat < b.bbox.minLat || lat > b.bbox.maxLat) continue;
    for (const poly of b.polys) {
      const outer = poly[0];
      if (!pointInRing(lon, lat, outer)) continue;
      // holes: if inside a hole, it's outside
      let inHole = false;
      for (let k = 1; k < poly.length; k++) {
        if (pointInRing(lon, lat, poly[k])) { inHole = true; break; }
      }
      if (!inHole) return b.initial;
    }
  }
  return '';
}
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];

    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/* ================= PROJECTION & BBOX ================= */
function buildProjector(L, T, W, H) {
  const xmap = (lon) => map(lon, bbox.minLon, bbox.maxLon, L, L + W);
  const ymap = (lat) => map(lat, bbox.maxLat, bbox.minLat, T, T + H);
  return (lon, lat) => ({ x: xmap(lon), y: ymap(lat) });
}
// compact bbox (1% padding)
function computeBBoxFromRows(rows) {
  let b = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
  for (const p of rows) {
    b.minLon = min(b.minLon, p.lon); b.maxLon = max(b.maxLon, p.lon);
    b.minLat = min(b.minLat, p.lat); b.maxLat = max(b.maxLat, p.lat);
  }
  const frac = 0.01, dLat = (b.maxLat - b.minLat) * frac, dLon = (b.maxLon - b.minLon) * frac;
  return { minLat: b.minLat - dLat, maxLat: b.maxLat + dLat, minLon: b.minLon - dLon, maxLon: b.maxLon + dLon };
}

/* ================= SHAPES ================= */
function drawMarkerShape(type, size) {
  switch (type) {
    case 'Street':
      circle(0, 0, size);
      break;

    case 'Residential':
      rectMode(CENTER);
      rect(0, 0, size, size);
      break;

    case 'Construction':
      triangle(0, -size * 0.60, -size * 0.55, size * 0.45, size * 0.55, size * 0.45);
      break;

    case 'Vehicle':
      quad(0, -size * 0.70, -size * 0.55, 0, 0, size * 0.70, size * 0.55, 0);
      break;

    case 'Commercial':
      polygon(0, 0, size * 0.58, 6);
      break;

    case 'Park':
      // 호출부에서 fill()은 이미 설정됨. 여기선 도형만 그립니다.
      beginShape();
      for (let a = 0; a < TWO_PI; a += PI / 6) {
        // 크기 과다 문제를 줄인 버전 (비례감 맞춤)
        const r = size * (0.50 + 0.12 * sin(a * 3));
        vertex(r * cos(a), r * sin(a));
      }
      endShape(CLOSE);
      break;

    case 'Other':
      triangle(-size * 0.55, -size * 0.45, size * 0.55, -size * 0.45, 0, size * 0.60);
      break;

    default:
      circle(0, 0, size * 0.8);
      break;
  }
}
function polygon(cx, cy, r, n) { beginShape(); for (let i = 0; i < n; i++) { const a = -HALF_PI + i * TWO_PI / n; vertex(cx + r * cos(a), cy + r * sin(a)); } endShape(CLOSE); }

/* ============== HELPERS ============== */
function classify(rec) {
  const ct = (rec.complaint_type || '').toLowerCase();
  const desc = (rec.descriptor || '').toLowerCase();

  if (ct.includes('park') || desc.includes('park')) return 'Park';
  if (ct.includes('residential')) return 'Residential';
  if (ct.includes('commercial')) return 'Commercial';
  if (ct.includes('street') || ct.includes('sidewalk')) return 'Street';
  if (ct.includes('vehicle') || desc.includes('horn') || desc.includes('honking')) return 'Vehicle';

  return 'Other';
}
function isoDaysAgo(n = 14) {
  const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0);
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00.000`;
}
// Stable jitter in screen coords
function tinyJitter(x, y, ty, mag = 2) {
  const h = hash32(`${ty}|${(x / 10).toFixed(2)}|${(y / 10).toFixed(2)}`);
  const a = (h % 6283) / 1000.0;
  const r = ((h >>> 13) % 1000) / 1000 * mag;
  return [r * cos(a), r * sin(a)];
}
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ================= INPUT & ZOOM ================= */

let panning = false;
let panStart = { x: 0, y: 0 };
let clickStart = { x: 0, y: 0 };
let startedOnUI = false;

function isInsideGraphArea(mx, my) {
  const topSafe = 80;       // 상단 제목/시간/범례 영역 제외
  const bottomSafe = 20;    // 하단 여백
  const leftSafe = 180;     // 왼쪽 레전드 영역 제외
  const rightSafe = 20;     // 오른쪽 여백
  return (
    mx > leftSafe &&
    mx < width - rightSafe &&
    my > topSafe &&
    my < height - bottomSafe
  );
}

function mousePressed() {
  // --- UI CLICKS FIRST ---

  // 1. Title Click
  const titleText = "NYC Noise Map — October 2025";
  const titleX = UI.left;
  const titleY = UI.top - 6;
  textSize(14);
  const titleW = textWidth(titleText);
  const titleH = 14;
  if (mouseX >= titleX && mouseX <= titleX + titleW && mouseY >= titleY && mouseY <= titleY + titleH) {
    for (const t of TYPES) { enabled[t] = true; }
    if (!PLAY) { togglePlay(); }
    fitViewToAll();
    redraw();
    return;
  }

  // 2. Legend Click
  const x0_legend = UI.left;
  const y0_legend = UI.top + 30 + UI.gap; // Corrected Y-offset
  const rowH = 22;
  const cardW = 140;
  for (let i = 0; i < TYPES.length; i++) {
    const ty = TYPES[i];
    const itemY = y0_legend + i * rowH;
    if (mouseX > x0_legend - 12 && mouseX < x0_legend + cardW && mouseY > itemY - rowH / 2 && mouseY < itemY + rowH / 2) {
      const isSolo = enabled[ty] && Object.values(enabled).filter(v => v).length === 1;
      if (isSolo) {
        for (const t of TYPES) { enabled[t] = true; }
      } else {
        for (const t of TYPES) { enabled[t] = (t === ty); }
      }
      redraw();
      return;
    }
  }

  // 3. Time Badge Click
  const { x, y, w, h } = timeBadgeBounds(floor(currentHour));
  if (mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h) {
    draggingTime = true;
    PLAY = false;
    if (soundOn) { setSound(false); }
    scrubHourWithMouse();
    redraw();
    return;
  }

  // 4. Control Buttons Click
  const btnSize = 22;
  const gap = 6;
  const x0_btn = width - (16 + btnSize * 0.4);
  const y0_btn = height - (16 + btnSize * 0.4);
  const buttons = [
    { name: 'playpause', action: togglePlay },
    { name: 'reset', action: resetViewClick },
    { name: 'zoomout', action: zoomOut },
    { name: 'zoomin', action: zoomIn }
  ];
  for (let i = 0; i < buttons.length; i++) {
    const bx = x0_btn - i * (btnSize + gap);
    const by = y0_btn;
    const r = btnSize / 2;
    if (dist(mouseX, mouseY, bx, by) < r) {
      buttons[i].action();
      redraw();
      return;
    }
  }

  // --- GRAPH INTERACTIONS SECOND ---

  // 오디오 첫 초기화
  if (!audioInitialized) {
    initializeAudio();
  }

  // 그래프 영역 바깥이면 확대/이동 차단
  if (!isInsideGraphArea(mouseX, mouseY)) return;

  // 그래프 내부에서만 확대/이동 시작
  clickStart = { x: mouseX, y: mouseY };
  panning = true;
  panStart.x = mouseX - viewOffset.x;
  panStart.y = mouseY - viewOffset.y;
}

function mouseDragged() {
  if (draggingTime) {
    scrubHourWithMouse();
    redraw();
    return;
  }

  if (!isInsideGraphArea(mouseX, mouseY)) return; // 그래프 밖이면 무시

  const dx = mouseX - clickStart.x;
  const dy = mouseY - clickStart.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist > 4 && panning) {
    viewOffset.x = mouseX - panStart.x;
    viewOffset.y = mouseY - panStart.y;
    redraw();
  }
}


function mouseReleased() {
  // 시간 드래그 종료
  if (draggingTime) {
    draggingTime = false;
    return;
  }

  // 그래프 영역 밖 클릭 무시
  if (!isInsideGraphArea(mouseX, mouseY)) return;

  const dx = mouseX - clickStart.x;
  const dy = mouseY - clickStart.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  // 그래프 내부 클릭 시 확대 (패닝이 아닐 경우)
  if (d < 4) {
    const Z = keyIsDown(SHIFT) ? 1 / 1.6 : 1.6;
    zoomAt(mouseX, mouseY, Z);
    redraw();
  }

  panning = false;
}

function keyPressed() {
  if (key === 'm' || key === 'M') {
    togglePlay();
    return;
  }
  if (key === 'n' || key === 'N') {
    micReactionOn = !micReactionOn;
    console.log(`Mic Reaction toggled: ${micReactionOn}`);
    redraw();
    return;
  }
  if (key === 'u' || key === 'U') {
    SHOW_SOUND_UI = !SHOW_SOUND_UI;
    redraw();
    return;
  }
  if (key === 'S' || key === 's') {
    saveCurrentFrame();
    return;
  }
  // E for Export (PNG)
  if (key === 'E' && !keyIsDown(SHIFT) && !(keyIsDown(CONTROL) || keyIsDown(COMMAND))) {
    saveCurrentFrame();
    return;
  }

  // Cmd/Ctrl+E for Peak/Low Noise Export
  if ((key === 'E') && (keyIsDown(CONTROL) || keyIsDown(COMMAND))) {
    const { hi, lo } = mostLeastHour();
    renderToSVG(`noise_peak_${String(hi).padStart(2, '0')}.svg`, hi, false, false);
    renderToSVG(`noise_low_${String(lo).padStart(2, '0')}.svg`, lo, false, false);
    return;
  }

  // 🟢 11238 지역 확대 (Z 키)
  if (key === 'Z' || key === 'z') {
    fitViewToZip11238();
    return;
  }

  // Other keys
  if (key === ' ') { togglePlay(); return; }
  if (key === '0') { resetView(); redraw(); return; }
  if (key === 'L' || key === 'l') { SHOW_LEGEND = !SHOW_LEGEND; redraw(); return; }
  if (key === 'H' || key === 'h') { SHOW_HISTORY = !SHOW_HISTORY; redraw(); return; }
  if (key === 'D' || key === 'd') { DENSITY_SIZE = !DENSITY_SIZE; redraw(); return; }
  if (key === 'O') { D_CELL_BASE = max(10, D_CELL_BASE - 4); redraw(); return; }
  if (key === 'P') { D_CELL_BASE = min(80, D_CELL_BASE + 4); redraw(); return; }
  if (keyCode === LEFT_ARROW) { currentHour = (floor(currentHour) + 23) % 24; PLAY = false; setSound(false); redraw(); return; }
  if (keyCode === RIGHT_ARROW) { currentHour = (floor(currentHour) + 1) % 24; PLAY = false; setSound(false); redraw(); return; }
  if (key === 'F') {
    if (keyIsDown(SHIFT)) fitViewToAll();
    else fitViewToHour(floor(currentHour));
    return;
  }

  if (key === '+' || key === '=') {
    zoomAt(width / 2, height / 2, 1.2);  // 중앙 기준 확대
    redraw();
    return;
  }
  if (key === '-' || key === '_') {
    zoomAt(width / 2, height / 2, 1 / 1.2); // 중앙 기준 축소
    redraw();
    return;
  }
  if (key === 'T' || key === 't') {
    const hour = floor(currentHour);
    renderToSVG(`noise_laser_${hour}.svg`, hour);
    console.log(`✅ Laser-cut SVG saved for hour ${hour}`);
    return;
  }
}


function zoomAt(mx, my, z) {
  viewOffset.x = viewOffset.x * z + (1 - z) * mx;
  viewOffset.y = viewOffset.y * z + (1 - z) * my;
  viewScale *= z;
}
function resetView() {
  viewScale = 1.0;
  viewOffset = { x: 0, y: 0 };
}
function scrubHourWithMouse() {
  const { x, y, w, h } = timeBadgeBounds(floor(currentHour));
  const padL = 8, padR = 8;
  const x0 = x + padL, x1 = x + w - padR;
  const t = constrain((mouseX - x0) / max(1, (x1 - x0)), 0, 1);
  currentHour = floor(t * 24) % 24;
}

/* ======== SVG EXPORT UTILS ======== */
// 화면용 draw()를 그대로 재사용해 "1회 렌더" SVG 출력
function renderToSVG(filename, hour, perType = false, cutMode = false) {
  const W = width, H = height;

  // SVG 캔버스 만들고 한 번만 그리기
  const prevLooping = isLooping();
  noLoop();

  // 1) SVG 모드 캔버스 생성
  const svg = createGraphics(W, H, SVG);

  // 2) SVG로 그릴 함수
  svg.push();
  // svg.background(); // Removed to prevent potential SVG export issues and create a transparent background

  // 시점 고정
  const oldHour = currentHour;
  currentHour = hour;

  // 동일한 투영/뷰 변환
  const Wv = W - (M.l + M.r);
  const Hv = H - (M.t + M.b);
  const proj = (lon, lat) => ({
    x: map(lon, bbox.minLon, bbox.maxLon, M.l, M.l + Wv),
    y: map(lat, bbox.maxLat, bbox.minLat, M.t, M.t + Hv)
  });

  svg.translate(viewOffset.x, viewOffset.y);
  svg.scale(viewScale);

  // Now, use the new SVG drawing function
  if (SHOW_HISTORY) {
    drawHourLayerSVG(svg, proj, (hour + 22) % 24, 120);
    drawHourLayerSVG(svg, proj, (hour + 23) % 24, 180);
  }
  drawHourLayerSVG(svg, proj, hour, 255);

  svg.pop();

  // 파일 저장
  svg.save(filename);

  // 상태 복구
  currentHour = oldHour;
  if (prevLooping) loop();
}
// 보조: 정다각형
function poly(g, cx, cy, r, n) { g.beginShape(); for (let i = 0; i < n; i++) { const a = -HALF_PI + i * TWO_PI / n; g.vertex(cx + r * cos(a), cy + r * sin(a)); } g.endShape(CLOSE); }

function mostLeastHour() {
  const totals = Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    for (const ty of TYPES) { totals[h] += (pointByHourType?.[h]?.[ty]?.length || 0); }
  }
  let hi = 0, lo = 0, hv = -1, lv = Infinity;
  for (let h = 0; h < 24; h++) { const v = totals[h]; if (v > hv) { hv = v; hi = h } if (v < lv) { lv = v; lo = h } }
  return { hi, hv, lo, lv };
}

function saveCurrentFrame() {
  const filename = `noise_${String(floor(currentHour)).padStart(2, '0')}.png`;
  saveCanvas(filename, 'png');
}
function fitViewToZip11238() {
  // Brooklyn 11238 근처 경계
  const minLon = -73.97, maxLon = -73.95;
  const minLat = 40.67, maxLat = 40.69;

  const L = M.l, T = M.t;
  const W = width - M.l - M.r;
  const H = height - M.t - M.b;
  const proj = (lon, lat) => ({
    x: map(lon, bbox.minLon, bbox.maxLon, L, L + W),
    y: map(lat, bbox.maxLat, bbox.minLat, T, T + H)
  });

  // 박스의 4점 투영
  const a = proj(minLon, minLat);
  const b = proj(maxLon, maxLat);

  // 줌 영역으로 맞추기
  fitViewToRect(a.x, a.y, b.x, b.y, FIT_PAD);
  redraw();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);

  const W = width - M.l - M.r;
  const H = height - M.t - M.b;

  if (rows && rows.length > 0) {
    bbox = computeBBoxFromRows(rows);
    projector = buildProjector(M.l, M.t, W, H);
  }

  fitViewToHour(floor(currentHour)); // 또는 fitViewToAll();
  redraw();
}

function togglePlay() {
  PLAY = !PLAY;

  // 오디오가 있을 경우 재생 상태에 맞춰 사운드 강제 동기화
  if (audioInitialized) {
    setSound(PLAY);
  } else if (PLAY) {
    // 아직 초기화 전인데 재생을 누른 경우 초기화 시도
    initializeAudio();
  }
}

function zoomIn() {
  zoomAt(width / 2, height / 2, 1.2);
}

function zoomOut() {
  zoomAt(width / 2, height / 2, 1 / 1.2);
}

function initializeAudio() {
  if (audioInitialized) return;
  
  userStartAudio();
  mic = new p5.AudioIn();
  mic.start();
  // Disconnect the mic from the speakers so we don't hear feedback
  mic.disconnect();
  
  fft = new p5.FFT(0.2, 256);
  // Explicitly set FFT to only listen to the mic (ignores oscillators)
  fft.setInput(mic);
  
  audioInitialized = true;
  
  // 초기화 시점에 재생 중이면 사운드도 켬
  if (PLAY) {
    setSound(true);
  } else {
    setSound(false);
  }
}

function resetViewClick() {
  resetView();
  // 사용자의 요청: 초기화(reset) 버튼을 클릭 시 뷰를 리셋함과 동시에 사운드를 끔(mute) 처리
  setSound(false);
  redraw();
}

class FlowParticle {
  constructor() {
    this.reset(true);
    this.speedMul = random(0.6, 1.3);
  }

  reset(randomPos = false) {
    const topSafe = 80;
    const bottomSafe = 20;
    const leftSafe = 180;
    const rightSafe = 20;

    if (randomPos) {
      this.pos = createVector(
        random(leftSafe, width - rightSafe),
        random(topSafe, height - bottomSafe)
      );
    } else {
      this.pos.x = constrain(this.pos.x, leftSafe, width - rightSafe);
      this.pos.y = constrain(this.pos.y, topSafe, height - bottomSafe);
    }
    this.prev = this.pos.copy();
  }

  follow() {
    const xIndex = floor(this.pos.x / flowScale);
    const yIndex = floor(this.pos.y / flowScale);

    if (xIndex < 0 || xIndex >= flowCols || yIndex < 0 || yIndex >= flowRows) {
      this.reset(true);
      return;
    }

    const index = xIndex + yIndex * flowCols;
    const angle = flowField[index];

    const v = p5.Vector.fromAngle(angle);
    const baseSpeed = 1.0;
    const audioBoost = 1.0 + liveAudioLevel * 6.0;
    v.mult(baseSpeed * this.speedMul * audioBoost);

    this.pos.add(v);
  }

  update() {
    this.prev.set(this.pos);
    this.follow();

    const topSafe = 80;
    const bottomSafe = 20;
    const leftSafe = 180;
    const rightSafe = 20;

    if (
      this.pos.x < leftSafe ||
      this.pos.x > width - rightSafe ||
      this.pos.y < topSafe ||
      this.pos.y > height - bottomSafe
    ) {
      this.reset(true);
    }
  }

  show(mapAlpha) {
    // 🔹 주파수 대역별 영향력 (0~1 범위로 정규화)
    const bassInfluence = map(bass, 0, 255, 0, 1);
    const midInfluence = map(mid, 0, 255, 0, 1);
    const trebleInfluence = map(treble, 0, 255, 0, 1);

    // 🔹 노이즈 유형별 색상 (기존 COLORS 사용)
    // Vehicle (저음/Bass) → 빨강
    // Street (중음/Mid) → 파랑  
    // Residential (고음/Treble) → 초록
    let baseColor = COLORS[liveActiveType] || [255, 255, 255]; // 기본 흰색

    // 🔹 주파수에 따른 색상 변조 (약간의 혼합 효과)
    // 베이스 색상을 기준으로 주파수별로 미묘하게 변화
    const bassShift = [0, 255, 255];    // Cyan 방향
    const midShift = [255, 255, 0];     // Yellow 방향
    const trebleShift = [255, 0, 255];  // Magenta 방향

    // 베이스 색상에 주파수별 변조 추가 (미묘하게)
    const shiftAmount = 0.3; // 변조 강도 (0~1)
    const r = baseColor[0] + (bassShift[0] - baseColor[0]) * bassInfluence * shiftAmount
      + (midShift[0] - baseColor[0]) * midInfluence * shiftAmount * 0.5
      + (trebleShift[0] - baseColor[0]) * trebleInfluence * shiftAmount * 0.5;
    const g = baseColor[1] + (bassShift[1] - baseColor[1]) * bassInfluence * shiftAmount
      + (midShift[1] - baseColor[1]) * midInfluence * shiftAmount * 0.5
      + (trebleShift[1] - baseColor[1]) * trebleInfluence * shiftAmount * 0.5;
    const b = baseColor[2] + (bassShift[2] - baseColor[2]) * bassInfluence * shiftAmount
      + (midShift[2] - baseColor[2]) * midInfluence * shiftAmount * 0.5
      + (trebleShift[2] - baseColor[2]) * trebleInfluence * shiftAmount * 0.5;

    // 🔹 주파수별 굵기 계산 (면처럼 두껍게)
    // Bass: 매우 두껍게 (최대 50px) - 면처럼 보임
    const bassWidth = bassInfluence * bassInfluence * 50; // 제곱으로 더 극적인 변화

    // Mid: 중간 두께 (최대 25px)
    const midWidth = midInfluence * midInfluence * 25;

    // Treble: 얇고 날카롭게 (최대 8px)
    const trebleWidth = trebleInfluence * 8;

    // 전체 오디오 레벨에 따른 기본 두께
    const baseWidth = map(liveAudioLevel, 0, 0.5, 0.3, 6);

    // 최종 두께: 기본 + 주파수별 (가장 강한 주파수가 두께를 결정)
    const w = baseWidth + max(bassWidth, midWidth, trebleWidth);

    // 투명도: 간결하게 - 더 투명하게 조정
    const thicknessAlpha = map(w, 0, 50, 1, 0.6); // 두꺼울수록 더 투명
    const baseAlpha = map(liveAudioLevel, 0, 0.5, 5, 100); // 최대 투명도 낮춤
    const finalAlpha = constrain(baseAlpha * thicknessAlpha * map(mapAlpha, 50, 255, 0.2, 1), 3, 120);

    // 🎨 유형별 색상 적용 (주파수 변조 포함)
    stroke(r, g, b, finalAlpha);
    strokeWeight(w);

    // 🔹 세로 선 그리기 (항상 전체 화면 높이) - 간결하게 한 줄만
    line(this.pos.x, 0, this.pos.x, height);
  }
}

function updateFlowField() {
  if (!flowField.length) return;

  // 🔹 주파수 대역별로 다른 영향을 줌
  const bassEffect = map(bass, 0, 255, 0, 0.5);
  const midEffect = map(mid, 0, 255, 0, 0.3);
  const trebleEffect = map(treble, 0, 255, 0, 0.4);

  // 전체 오디오 강도에 따라 noise scale 조절
  const noiseScale = 0.08 + liveAudioLevel * 0.15;

  let yOff = 0;
  for (let y = 0; y < flowRows; y++) {
    let xOff = 0;
    for (let x = 0; x < flowCols; x++) {
      const index = x + y * flowCols;

      // 오디오에 따라 noise 파라미터 변화
      const n = noise(
        xOff + bassEffect,
        yOff + midEffect,
        flowZOff + trebleEffect
      );

      // 각도 범위를 오디오 레벨에 따라 확장
      const angleMultiplier = 2.0 + liveAudioLevel * 4.0;
      const angle = n * TWO_PI * angleMultiplier;

      flowField[index] = angle;
      xOff += noiseScale;
    }
    yOff += noiseScale;
  }

  // 🔹 움직임을 줄임 - 천천히 변화
  flowZOff += 0.002 + liveAudioLevel * 0.05;
}

function drawFlowField(mapAlpha) {
  const newCols = floor(width / flowScale);
  const newRows = floor(height / flowScale);

  if (newCols !== flowCols || newRows !== flowRows) {
    flowCols = newCols;
    flowRows = newRows;
    flowField = new Array(flowCols * flowRows).fill(0);
    particles = [];
    for (let i = 0; i < 200; i++) { // 간결하게 - 개수 줄임
      particles.push(new FlowParticle());
    }
  }

  // updateFlowField();

  /*
  for (let p of particles) {
    p.update();
    p.show(mapAlpha);
  }
  */
}

function drawDebugOverlay() {
  // Always draw debug info at bottom left
  push();
  resetMatrix(); // Draw in screen coordinates

  const x = 10;
  const y = height - 100; // Position above bottom UI

  fill(0, 0, 0, 200);
  noStroke();
  rect(x, y, 300, 110, 5); // Background box

  fill(255, 100, 100); // Red text for visibility
  textSize(12);
  textAlign(LEFT, TOP);

  let debugText = `DEBUG MODE:\n`;
  debugText += `Borough Data: ${boroIndex ? `Loaded (${boroIndex.length})` : 'MISSING'}\n`;
  debugText += `Projector: ${projector ? 'OK' : 'MISSING'}\n`;
  debugText += `Mouse: ${mouseX.toFixed(0)}, ${mouseY.toFixed(0)}\n`;

  if (projector && bbox) {
    const mx = (mouseX - viewOffset.x) / viewScale;
    const my = (mouseY - viewOffset.y) / viewScale;
    const lon = map(mx, M.l, M.l + (width - M.l - M.r), bbox.minLon, bbox.maxLon);
    const lat = map(my, M.t, M.t + (height - M.t - M.b), bbox.maxLat, bbox.minLat);
    debugText += `Lat/Lon: ${lat.toFixed(4)}, ${lon.toFixed(4)}\n`;
    debugText += `Global BBox: [${bbox.minLon.toFixed(2)}, ${bbox.maxLon.toFixed(2)}] x [${bbox.minLat.toFixed(2)}, ${bbox.maxLat.toFixed(2)}]\n`;

    // Sample check for Manhattan
    const man = boroIndex ? boroIndex.find(b => b.name === 'Manhattan') : null;
    if (man) {
      debugText += `Manhattan BBox: [${man.bbox.minLon.toFixed(2)}, ${man.bbox.maxLon.toFixed(2)}]... \n`;
    }
  }

  debugText += `Hovered: ${hoveredBorough || 'None'}\n`;

  text(debugText, x + 10, y + 10);
  pop();
}

// Performance optimization: Only check borough on mouse movement
function mouseMoved() {
  hoveredBorough = getBoroughAt(mouseX, mouseY);
}
