const TAU = Math.PI * 2;

export class StudioRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.plan = null;
    this.audio = null;
    this.manualTime = 0;
    this.animationFrame = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
    this.loop = this.loop.bind(this);
    this.animationFrame = requestAnimationFrame(this.loop);
  }

  setProduction(plan, audio) {
    this.plan = plan;
    this.audio = audio;
    this.manualTime = 0;
    const ratio = plan?.render?.aspectRatio || '16:9';
    this.canvas.dataset.ratio = ratio;
    this.resize();
  }

  setManualTime(value) { this.manualTime = Number(value) || 0; }
  currentTime() { return this.audio && !Number.isNaN(this.audio.currentTime) ? this.audio.currentTime : this.manualTime; }

  resize() {
    const ratio = this.plan?.render?.aspectRatio || this.canvas.dataset.ratio || '16:9';
    const [rw, rh] = ratio.split(':').map(Number);
    const logicalW = ratio === '9:16' ? 720 : ratio === '1:1' ? 900 : 1280;
    const logicalH = Math.round(logicalW * rh / rw);
    if (this.canvas.width !== logicalW || this.canvas.height !== logicalH) {
      this.canvas.width = logicalW;
      this.canvas.height = logicalH;
    }
  }

  loop() {
    if (this.plan) this.draw(this.currentTime());
    this.animationFrame = requestAnimationFrame(this.loop);
  }

  draw(time) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const shot = this.findShot(time);
    if (!shot) return this.drawSlate();
    const p = clamp((time - shot.start_sec) / Math.max(.01, shot.end_sec - shot.start_sec), 0, 1);
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    this.drawBackground(shot, p, time);
    this.applyCamera(shot.camera, p, w, h);
    this.drawSetDetails(shot, p, time);
    this.drawProps(shot, p, time);
    for (const actor of shot.actors || []) this.drawActor(actor, shot, p, time);
    this.drawEffects(shot, p, time);
    ctx.restore();
    this.drawOverlay(shot, p);
  }

  drawSlate() {
    const { ctx } = this;
    ctx.fillStyle = '#080a0f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  findShot(time) {
    const shots = this.plan?.shots || [];
    return shots.find((s) => time >= s.start_sec && time < s.end_sec) || (time >= (shots.at(-1)?.end_sec || Infinity) ? shots.at(-1) : shots[0]);
  }

  drawBackground(shot, p, time) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const palette = this.validPalette();
    const seed = hash(`${shot.setting}|${shot.background}`);
    const a = palette[seed % palette.length];
    const b = palette[(seed + 2) % palette.length];
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, mix(a, '#090b11', .72));
    grad.addColorStop(1, mix(b, '#050608', .84));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.globalAlpha = .12;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    const grid = Math.max(42, w / 18);
    for (let x = -grid + ((time * 4) % grid); x < w + grid; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.globalAlpha = 1;

    const key = `${shot.setting} ${shot.background}`.toLowerCase();
    if (/space|sky|night/.test(key)) this.drawStars(seed, time);
    if (/city|street|town/.test(key)) this.drawSkyline(seed);
    if (/room|studio|office|class/.test(key)) this.drawInterior(seed);
    if (/nature|forest|farm|field|village/.test(key)) this.drawLandscape(seed);
  }

  drawStars(seed, time) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 42; i++) {
      const x = pseudo(seed + i * 17) * w;
      const y = pseudo(seed + i * 41) * h * .68;
      const r = .7 + pseudo(seed + i * 7) * 1.8;
      ctx.globalAlpha = .3 + .5 * Math.abs(Math.sin(time * .7 + i));
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawSkyline(seed) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = 'rgba(5,7,10,.7)';
    let x = 0, i = 0;
    while (x < w) {
      const bw = 55 + pseudo(seed + i * 13) * 105;
      const bh = h * (.15 + pseudo(seed + i * 29) * .23);
      ctx.fillRect(x, h - bh, bw - 5, bh);
      x += bw; i++;
    }
  }

  drawInterior(seed) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = 'rgba(255,255,255,.035)';
    ctx.fillRect(w * .08, h * .12, w * .24, h * .24);
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.strokeRect(w * .08, h * .12, w * .24, h * .24);
    ctx.fillStyle = 'rgba(0,0,0,.18)';
    ctx.fillRect(0, h * .82, w, h * .18);
  }

  drawLandscape(seed) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = 'rgba(8,18,12,.45)';
    ctx.beginPath();
    ctx.moveTo(0, h * .7);
    for (let x = 0; x <= w; x += w / 7) ctx.lineTo(x, h * (.65 + pseudo(seed + x) * .12));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
  }

  applyCamera(camera, p, w, h) {
    const ctx = this.ctx;
    let scale = 1, tx = 0, ty = 0;
    if (camera === 'push-in' || camera === 'close' || camera === 'object-close') scale = 1 + p * .08;
    if (camera === 'pull-out') scale = 1.08 - p * .08;
    if (camera === 'pan-left') tx = -w * .035 * p;
    if (camera === 'pan-right') tx = w * .035 * p;
    if (camera === 'tracking') tx = Math.sin(p * Math.PI) * w * .025;
    ctx.translate(w / 2 + tx, h / 2 + ty);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
  }

  drawSetDetails(shot, p, time) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = 'rgba(255,255,255,.055)';
    ctx.beginPath(); ctx.arc(w * .86, h * .18, w * .08, 0, TAU); ctx.fill();
    ctx.globalAlpha = .6;
    ctx.fillStyle = this.validPalette()[1] || '#8df0b1';
    ctx.beginPath(); ctx.arc(w * .86, h * .18, w * (.025 + .004 * Math.sin(time)), 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
  }

  drawProps(shot, p, time) {
    const props = shot.props || [];
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    props.slice(0, 4).forEach((prop, i) => {
      const x = w * (.15 + i * .2), y = h * (.25 + (i % 2) * .1);
      const appear = ease(clamp(p * 3 - i * .12, 0, 1));
      ctx.save(); ctx.globalAlpha = .7 * appear; ctx.translate(x, y + (1 - appear) * 18);
      ctx.fillStyle = 'rgba(255,255,255,.07)'; roundRect(ctx, -44, -24, 88, 48, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.stroke();
      ctx.fillStyle = '#dfe3e9'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${Math.max(10, w * .011)}px system-ui`;
      ctx.fillText(shortLabel(prop, 12), 0, 0, 78); ctx.restore();
    });
  }

  drawActor(actor, shot, p, time) {
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const cast = (this.plan.cast || []).find((c) => c.id === actor.id) || { name: actor.id };
    const seed = hash(actor.id);
    let x = actor.x * w, y = actor.y * h;
    const scale = actor.scale * Math.min(w / 1280, h / 720) * 1.08;
    const phase = time * 6 + seed;
    let bob = Math.sin(phase) * 2;
    if (actor.action === 'walk' || actor.action === 'run') bob *= actor.action === 'run' ? 2.4 : 1.5;
    if (actor.action === 'enter') x -= (1 - ease(p)) * w * .22;
    if (actor.action === 'exit') x += ease(p) * w * .22;
    y += bob;

    const skin = skinTone(seed);
    const outfit = this.validPalette()[(seed + 1) % this.validPalette().length] || '#6f8cff';
    const outline = 'rgba(6,8,12,.72)';
    const headR = 34 * scale;
    const bodyH = 94 * scale;
    const shoulderY = y - bodyH * .74;
    const hipY = y - bodyH * .05;
    const centerX = x;

    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = outline; ctx.lineWidth = 16 * scale;
    const stride = (actor.action === 'walk' || actor.action === 'run') ? Math.sin(phase) * 17 * scale : 0;
    limb(ctx, centerX - 13 * scale, hipY, centerX - 18 * scale + stride, y - 34 * scale, centerX - 24 * scale - stride, y);
    limb(ctx, centerX + 13 * scale, hipY, centerX + 18 * scale - stride, y - 34 * scale, centerX + 24 * scale + stride, y);
    ctx.strokeStyle = '#202530'; ctx.lineWidth = 12 * scale;
    limb(ctx, centerX - 13 * scale, hipY, centerX - 18 * scale + stride, y - 34 * scale, centerX - 24 * scale - stride, y);
    limb(ctx, centerX + 13 * scale, hipY, centerX + 18 * scale - stride, y - 34 * scale, centerX + 24 * scale + stride, y);

    ctx.fillStyle = outfit;
    roundRect(ctx, centerX - 39 * scale, shoulderY, 78 * scale, bodyH * .78, 24 * scale); ctx.fill();
    ctx.strokeStyle = outline; ctx.lineWidth = 5 * scale; ctx.stroke();

    const arm = armPose(actor.action, phase, scale);
    drawArm(ctx, centerX - 35 * scale, shoulderY + 22 * scale, -1, arm.left, scale, skin, outline);
    drawArm(ctx, centerX + 35 * scale, shoulderY + 22 * scale, 1, arm.right, scale, skin, outline);

    ctx.fillStyle = skin; ctx.strokeStyle = outline; ctx.lineWidth = 5 * scale;
    ctx.beginPath(); ctx.arc(centerX, shoulderY - headR * .48, headR, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hairColor(seed);
    ctx.beginPath(); ctx.arc(centerX, shoulderY - headR * .67, headR * .92, Math.PI, TAU); ctx.lineTo(centerX + headR * .88, shoulderY - headR * .53); ctx.quadraticCurveTo(centerX, shoulderY - headR * 1.55, centerX - headR * .88, shoulderY - headR * .53); ctx.fill();

    this.drawFace(centerX, shoulderY - headR * .42, headR, actor, time, scale);

    ctx.fillStyle = 'rgba(0,0,0,.36)'; roundRect(ctx, centerX - 42 * scale, y + 9 * scale, 84 * scale, 19 * scale, 9 * scale); ctx.fill();
    ctx.fillStyle = '#eef1f4'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `${11 * scale}px system-ui`; ctx.fillText(shortLabel(cast.name || actor.id, 12), centerX, y + 18 * scale);
    ctx.restore();
  }

  drawFace(cx, cy, r, actor, time, scale) {
    const ctx = this.ctx;
    const blink = Math.sin(time * .83 + hash(actor.id) % 10) > .975;
    const eyeY = cy - r * .12;
    const eyeDX = r * .34;
    const look = actor.look_at === 'left' ? -1 : actor.look_at === 'right' ? 1 : 0;
    ctx.strokeStyle = '#16191f'; ctx.fillStyle = '#16191f'; ctx.lineWidth = 3 * scale;
    if (blink) {
      ctx.beginPath(); ctx.moveTo(cx - eyeDX - 5*scale, eyeY); ctx.lineTo(cx - eyeDX + 5*scale, eyeY); ctx.moveTo(cx + eyeDX - 5*scale, eyeY); ctx.lineTo(cx + eyeDX + 5*scale, eyeY); ctx.stroke();
    } else {
      for (const sx of [-1,1]) { ctx.beginPath(); ctx.arc(cx + sx * eyeDX + look * 2.5 * scale, eyeY, 3.8 * scale, 0, TAU); ctx.fill(); }
    }
    const expr = actor.expression;
    if (expr === 'surprised' || actor.action === 'surprised') {
      ctx.beginPath(); ctx.arc(cx, cy + r * .28, 7 * scale, 0, TAU); ctx.stroke();
      brow(ctx, cx, eyeY - 10*scale, scale, -1); brow(ctx, cx, eyeY - 10*scale, scale, 1);
    } else if (expr === 'happy' || expr === 'warm' || expr === 'excited' || actor.action === 'celebrate') {
      ctx.beginPath(); ctx.arc(cx, cy + r * .12, 14*scale, .18*Math.PI, .82*Math.PI); ctx.stroke();
    } else if (expr === 'concerned' || expr === 'serious') {
      ctx.beginPath(); ctx.moveTo(cx - 8*scale, cy + r*.32); ctx.quadraticCurveTo(cx, cy+r*.25, cx+8*scale, cy+r*.32); ctx.stroke();
    } else {
      const talking = this.audio && !this.audio.paused && !this.audio.ended;
      const open = talking ? (Math.sin(time * 15.5 + hash(actor.id)) + 1) / 2 : 0;
      ctx.beginPath(); ctx.ellipse(cx, cy + r * .27, 8*scale, (2.2 + open * 4)*scale, 0, 0, TAU); ctx.stroke();
    }
  }

  drawEffects(shot, p, time) {
    const effects = shot.visual_effects || [];
    if (!effects.length) return;
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const seed = hash(effects.join('|') + shot.id);
    for (let i = 0; i < Math.min(18, effects.length * 6); i++) {
      const angle = pseudo(seed + i * 17) * TAU + time * .2;
      const radius = w * (.06 + pseudo(seed + i * 41) * .2);
      const x = w * .5 + Math.cos(angle) * radius;
      const y = h * .42 + Math.sin(angle) * radius * .55;
      ctx.globalAlpha = .12 + .28 * Math.sin(p * Math.PI);
      ctx.fillStyle = this.validPalette()[i % this.validPalette().length];
      ctx.beginPath(); ctx.arc(x, y, 2 + pseudo(seed+i)*6, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawOverlay(shot, p) {
    const text = shot.on_screen_text?.trim();
    if (!text) return;
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const a = Math.min(1, p * 5, (1-p)*7);
    ctx.save(); ctx.globalAlpha = a;
    const fontSize = Math.max(22, Math.min(58, w * .042));
    ctx.font = `800 ${fontSize}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const maxWidth = w * .78;
    const lines = wrapText(ctx, text, maxWidth, 2);
    const boxW = Math.min(maxWidth + 40, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 48);
    const boxH = lines.length * fontSize * 1.08 + 26;
    ctx.fillStyle = 'rgba(7,9,12,.72)'; roundRect(ctx, w/2-boxW/2, h*.1, boxW, boxH, 18); ctx.fill();
    ctx.fillStyle = '#f7f8fa';
    lines.forEach((line, i) => ctx.fillText(line, w/2, h*.1 + 18 + fontSize*.55 + i*fontSize*1.05, maxWidth));
    ctx.restore();
  }

  validPalette() {
    const fallback = ['#8df0b1','#79a7ff','#ffd479','#ff8fa3','#b69cff'];
    const palette = this.plan?.visual_identity?.palette || [];
    const safe = palette.filter((x) => /^#[0-9a-f]{6}$/i.test(x));
    return safe.length >= 2 ? safe : fallback;
  }
}

function armPose(action, phase, scale) {
  const sway = Math.sin(phase*.7) * .12;
  const poses = {
    idle: { left: [-.25+sway,.95], right: [.25-sway,.95] },
    explain: { left: [-.95,-.1+sway], right: [.95,.1-sway] },
    point: { left: [-.3,.8], right: [1.35,-.35] },
    think: { left: [-.25,.9], right: [.45,-1.0] },
    surprised: { left: [-1.05,-.7], right: [1.05,-.7] },
    celebrate: { left: [-.75,-1.15], right: [.75,-1.15] },
    agree: { left: [-.35,.7], right: [.55,.15] },
    disagree: { left: [-.8,.05], right: [.8,.05] },
    inspect: { left: [-.45,.55], right: [.25,.35] },
    hold: { left: [-.35,.2], right: [.35,.2] },
    offer: { left: [-.25,.45], right: [.95,.1] },
    receive: { left: [-.75,.2], right: [.35,.35] },
    react: { left: [-.8,-.25], right: [.8,-.25] }
  };
  return poses[action] || poses.idle;
}
function drawArm(ctx, sx, sy, side, pose, scale, skin, outline) {
  const len = 44 * scale;
  const ex = sx + pose[0] * len, ey = sy + pose[1] * len;
  const hx = ex + pose[0] * len * .62, hy = ey + pose[1] * len * .62;
  ctx.strokeStyle = outline; ctx.lineWidth = 15*scale; limb(ctx, sx, sy, ex, ey, hx, hy);
  ctx.strokeStyle = skin; ctx.lineWidth = 10*scale; limb(ctx, sx, sy, ex, ey, hx, hy);
  ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(hx,hy,7*scale,0,TAU); ctx.fill();
}
function limb(ctx, x1,y1,x2,y2,x3,y3){ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.lineTo(x3,y3);ctx.stroke();}
function brow(ctx,cx,y,scale,side){ctx.beginPath();ctx.moveTo(cx+side*8*scale,y);ctx.lineTo(cx+side*19*scale,y-3*scale);ctx.stroke();}
function skinTone(seed){return ['#7f4d35','#a86f50','#c88967','#dda982','#8f5b43','#e0b48f'][seed%6];}
function hairColor(seed){return ['#121317','#201a18','#33241d','#141414'][seed%4];}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function ease(t){return 1-Math.pow(1-clamp(t,0,1),3);}
function hash(s){let h=2166136261;for(const c of String(s)){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function pseudo(n){const x=Math.sin(Number(n)*12.9898)*43758.5453;return x-Math.floor(x);}
function shortLabel(v,n){v=String(v||'');return v.length>n?v.slice(0,n-1)+'…':v;}
function mix(a,b,t){const pa=parseHex(a),pb=parseHex(b);if(!pa||!pb)return a;return `rgb(${Math.round(pa[0]*(1-t)+pb[0]*t)},${Math.round(pa[1]*(1-t)+pb[1]*t)},${Math.round(pa[2]*(1-t)+pb[2]*t)})`;}
function parseHex(x){if(!/^#[0-9a-f]{6}$/i.test(x||''))return null;return [parseInt(x.slice(1,3),16),parseInt(x.slice(3,5),16),parseInt(x.slice(5,7),16)];}
function roundRect(ctx,x,y,w,h,r){r=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
function wrapText(ctx,text,maxWidth,maxLines){const words=String(text).split(/\s+/);const lines=[];let line='';for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=word;if(lines.length===maxLines-1)break;}else line=test;}if(line&&lines.length<maxLines)lines.push(line);return lines;}
