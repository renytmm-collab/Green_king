// Synthesized sound effects via the Web Audio API. No audio asset files are
// used so the local build stays free of third-party media. All sounds are
// generated from oscillators / noise buffers, which keeps the bundle tiny and
// avoids any rights concerns from the original game's audio.

const Audio = (() => {
  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem('green_king_muted') === '1';
  } catch {}

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq = 440, type = 'square', dur = 0.1, vol = 0.2, slideTo = null } = {}) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.15, vol = 0.2 } = {}) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime;
    const length = Math.max(1, Math.floor(c.sampleRate * dur));
    const buffer = c.createBuffer(1, length, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }
    const src = c.createBufferSource();
    src.buffer = buffer;
    const gain = c.createGain();
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(gain).connect(c.destination);
    src.start(t0);
  }

  const sounds = {
    build: () => tone({ freq: 240, slideTo: 460, type: 'square', dur: 0.09, vol: 0.16 }),
    clear: () => noise({ dur: 0.16, vol: 0.16 }),
    route: () => tone({ freq: 320, slideTo: 720, type: 'sine', dur: 0.16, vol: 0.15 }),
    spawn: () => tone({ freq: 150, type: 'sine', dur: 0.07, vol: 0.06 }),
    tower_fire: () => tone({ freq: 900, type: 'square', dur: 0.05, vol: 0.09 }),
    explosion: () => {
      noise({ dur: 0.22, vol: 0.2 });
      tone({ freq: 200, slideTo: 60, type: 'sawtooth', dur: 0.22, vol: 0.14 });
    },
    building_destroyed: () => {
      noise({ dur: 0.3, vol: 0.22 });
      tone({ freq: 160, slideTo: 50, type: 'sawtooth', dur: 0.3, vol: 0.16 });
    },
    castle_destroyed: () => {
      noise({ dur: 0.6, vol: 0.28 });
      tone({ freq: 120, slideTo: 40, type: 'sawtooth', dur: 0.6, vol: 0.22 });
    },
    upgrade: () => tone({ freq: 520, slideTo: 880, type: 'triangle', dur: 0.16, vol: 0.16 }),
    coin: () => {
      tone({ freq: 988, type: 'triangle', dur: 0.08, vol: 0.16 });
      setTimeout(() => tone({ freq: 1319, type: 'triangle', dur: 0.12, vol: 0.16 }), 70);
    },
    win: () => {
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'triangle', dur: 0.18, vol: 0.18 }), i * 120));
    },
    lose: () => {
      [392, 330, 262].forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'triangle', dur: 0.22, vol: 0.18 }), i * 140));
    }
  };

  function play(name) {
    if (muted) return;
    const fn = sounds[name];
    if (fn) fn();
  }

  function setMuted(value) {
    muted = value;
    try { localStorage.setItem('green_king_muted', value ? '1' : '0'); } catch {}
  }

  function toggleMute() {
    setMuted(!muted);
    return muted;
  }

  function isMuted() {
    return muted;
  }

  function resume() {
    ensure();
  }

  return { play, setMuted, toggleMute, isMuted, resume };
})();

export default Audio;
