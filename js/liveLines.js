// 🔹 실제 데이터 포인트 기반 세로 선 그리기 (가로 선과 동일한 형태)
function drawLiveLines(mapAlpha, h, distortion = 0) {
    if (!pointByHourType || !projector) {
        return;
    }

    // --- Live Audio Analysis (for color, movement, and thickness) ---
    const bassInfluence = map(bass, 0, 255, 0, 1);
    const midInfluence = map(mid, 0, 255, 0, 1);
    const trebleInfluence = map(treble, 0, 255, 0, 1);
    const liveAudioInfluence = map(liveAudioLevel, 0, 0.4, 0, 1, true);

    // --- Data Volume Analysis (for movement and thickness) ---
    let totalComplaintsThisHour = 0;
    for (const ty of TYPES) {
        const pts = pointByHourType[h][ty];
        if (pts) {
            totalComplaintsThisHour += pts.length;
        }
    }
    const dataAudioInfluence = map(totalComplaintsThisHour, 0, 150, 0, 1, true);

    // --- Create a vivid 'Live Color' and an audio-driven alpha ---
    const bassShift = [0, 255, 255];    // Cyan
    const midShift = [255, 255, 0];     // Yellow
    const trebleShift = [255, 0, 255];  // Magenta

    // Get the vivid color hue from the normalized frequency distribution
    let totalInfluence = bassInfluence + midInfluence + trebleInfluence;
    if (totalInfluence < 1e-6) totalInfluence = 1e-6;

    const normBass = bassInfluence / totalInfluence;
    const normMid = midInfluence / totalInfluence;
    const normTreble = trebleInfluence / totalInfluence;

    const r_live = bassShift[0] * normBass + midShift[0] * normMid + trebleShift[0] * normTreble;
    const g_live = bassShift[1] * normBass + midShift[1] * normMid + trebleShift[1] * normTreble;
    const b_live = bassShift[2] * normBass + midShift[2] * normMid + trebleShift[2] * normTreble;

    // Control line alpha with the overall audio level, scaled by the incoming mapAlpha (relative to base 220)
    const baseAlpha = map(liveAudioInfluence, 0, 1, 50, 255);
    const lineAlpha = baseAlpha * (mapAlpha / 220);

    // --- Movement (Disintegration) ---
    // Only shake when loud (earthquake effect)
    const shakeThreshold = 0.3; // Activate above this volume (lowered sensitivity)
    const disintegrationAmount = liveAudioLevel > shakeThreshold
        ? (liveAudioLevel - shakeThreshold) * 100.0  // Intense shaking when loud
        : 0; // No movement when quiet

    // --- Thickness (Stroke Weight) ---
    // Match horizontal line thickness exactly (no live audio influence on thickness)
    const dataDrivenStrokeWeight = constrain(map(totalComplaintsThisHour / 50, 0, 10, 0.1, 0.8), 0.1, 0.8);
    const finalStrokeWeight = dataDrivenStrokeWeight / viewScale;

    for (const ty of TYPES) {
        if (!enabled[ty]) continue;
        const pts = pointByHourType[h][ty];
        if (!pts || pts.length === 0) continue;

        // Get base color from data
        const dataBaseColor = COLORS[ty] || [180, 180, 180];

        // Interpolate between base color and live color
        const r_final = lerp(dataBaseColor[0], r_live, liveAudioInfluence);
        const g_final = lerp(dataBaseColor[1], g_live, liveAudioInfluence);
        const b_final = lerp(dataBaseColor[2], b_live, liveAudioInfluence);

        noFill();
        strokeWeight(finalStrokeWeight);

        for (const p of pts) {
            const { x, y } = projector(p.lon, p.lat);

            // Apply movement
            const n = noise(x * 0.01, y * 0.01, organicTime * 0.5);
            const angle = n * TWO_PI;
            const mag = disintegrationAmount;
            const displacedX = x + cos(angle) * mag;

            // Draw simple line in transformed coordinate space (like horizontal lines)
            // Calculate viewport bounds in world coordinates
            const topY = (0 - viewOffset.y) / viewScale;
            const bottomY = (height - viewOffset.y) / viewScale;

            stroke(r_final, g_final, b_final, lineAlpha);
            // Fragment into pixels when extremely loud (lowered sensitivity)
            if (liveAudioLevel > 0.5) { // Extreme volume threshold
                const dotSpacing = 5 / viewScale; // Make dot spacing consistent on screen
                strokeWeight(finalStrokeWeight * 2);
                for (let py = topY; py <= bottomY; py += dotSpacing) {
                    point(displacedX, py);
                }
            } else {
                line(displacedX, topY, displacedX, bottomY);
            }
        }
    }
}
