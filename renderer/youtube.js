// Wraps the YouTube IFrame API so it looks like an HTMLVideoElement to app.js:
// currentTime, duration, paused, playbackRate, play(), pause(), plus the same
// play/pause/timeupdate/loadedmetadata/seeking events.
class YouTubeMedia extends EventTarget {
  static apiReady = null;

  static loadApi() {
    if (!YouTubeMedia.apiReady) {
      YouTubeMedia.apiReady = new Promise((resolve) => {
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(s);
      });
    }
    return YouTubeMedia.apiReady;
  }

  // Accepts watch, share, shorts and embed links, or a bare 11-character id.
  static parseId(input) {
    const s = input.trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const url = new URL(s);
      if (url.hostname === 'youtu.be') return url.pathname.slice(1, 12) || null;
      if (url.hostname.endsWith('youtube.com')) {
        const v = url.searchParams.get('v');
        if (v) return v;
        const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/);
        if (m) return m[1];
      }
    } catch {}
    return null;
  }

  constructor(container, videoId) {
    super();
    this.videoId = videoId;
    this.paused = true;
    this.duration = NaN;
    this.ready = YouTubeMedia.loadApi().then(() => new Promise((resolve) => {
      this.yt = new YT.Player(container, {
        videoId,
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            this.duration = this.yt.getDuration();
            this.dispatchEvent(new Event('loadedmetadata'));
            resolve();
          },
          onStateChange: (e) => this.onState(e.data),
        },
      });
    }));
    // The IFrame API has no timeupdate event, so poll like a <video> would fire it.
    this.timer = setInterval(() => { if (this.yt?.getCurrentTime) this.dispatchEvent(new Event('timeupdate')); }, 100);
  }

  onState(state) {
    const wasPaused = this.paused;
    this.paused = state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING;
    if (!this.duration) this.duration = this.yt.getDuration();
    if (wasPaused !== this.paused) this.dispatchEvent(new Event(this.paused ? 'pause' : 'play'));
  }

  get currentTime() { return this.yt?.getCurrentTime?.() ?? 0; }
  set currentTime(t) {
    this.dispatchEvent(new Event('seeking'));
    this.yt?.seekTo(Math.max(0, Math.min(t, this.duration || t)), true);
    this.dispatchEvent(new Event('timeupdate'));
  }

  // YouTube only offers 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75 and 2.
  set playbackRate(r) { this.yt?.setPlaybackRate(r); }
  get playbackRate() { return this.yt?.getPlaybackRate?.() ?? 1; }

  play() { this.yt?.playVideo(); return Promise.resolve(); }
  pause() { this.yt?.pauseVideo(); }

  destroy() {
    clearInterval(this.timer);
    this.yt?.destroy();
  }
}
