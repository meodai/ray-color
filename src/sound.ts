// SFX manager, ported from OKPalette's SoundManager: preloaded WebAudio
// buffers, autoplay-policy unlock on first interaction, pitch/volume options.

export class SoundManager {
  private ctx: AudioContext;
  private buffers: Record<string, AudioBuffer> = {};
  private soundUrls: Record<string, string> = {
    success: '/sfx/Casual_6_7.m4a',
    toggle: '/sfx/ClickAndSlide.m4a',
    tick: '/sfx/HandleDragTick.m4a',
    tack: '/sfx/ClickyButton4.m4a',
  };
  private lastTickTime = 0;
  private globalVolume = 0.15;
  private unlocked = false;

  constructor() {
    this.ctx = new AudioContext();
    this.init();
  }

  private async init() {
    await Promise.all(Object.entries(this.soundUrls).map(async ([name, url]) => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        this.buffers[name] = await this.ctx.decodeAudioData(arrayBuffer);
      } catch (e) {
        console.warn(`Failed to load sound "${name}" from ${url}:`, e);
      }
    }));
  }

  private resume() {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(e => console.warn('AudioContext resume failed:', e));
    }
  }

  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.resume();
  }

  private playBuffer(name: string, options: { pitch?: number; volume?: number } = {}) {
    if (!this.unlocked) return;
    this.resume();
    const buffer = this.buffers[name];
    if (!buffer) return;
    try {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      if (options.pitch !== undefined) source.playbackRate.value = options.pitch;
      const gainNode = this.ctx.createGain();
      gainNode.gain.value = this.globalVolume * (options.volume ?? 1);
      source.connect(gainNode);
      gainNode.connect(this.ctx.destination);
      source.start(0);
    } catch {
      // ignore
    }
  }

  playSuccess() {
    this.playBuffer('success', { pitch: 0.95 + Math.random() * 0.1 });
  }

  playToggle(isOpening = true) {
    // Play at slightly lower pitch when closing
    this.playBuffer('toggle', { pitch: isOpening ? 1.0 : 0.85, volume: 0.6 });
  }

  playTick() {
    const now = Date.now();
    if (now - this.lastTickTime < 50) return;
    this.lastTickTime = now;
    this.playBuffer('tick');
  }

  playTack() {
    this.playBuffer('tack', { pitch: 0.5 + Math.random() * 0.5, volume: 0.6 });
  }
}
