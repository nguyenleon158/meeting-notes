/* ============================================
   MeetNote AI — Audio Recorder
   ============================================ */

const Recorder = {
  mediaRecorder: null,
  audioChunks: [],
  audioStream: null,
  systemAudioStream: null,
  _mixedStream: null,
  _micSource: null,
  _systemSource: null,
  _mixDestination: null,
  analyserNode: null,
  audioContext: null,
  startTime: null,
  pausedDuration: 0,
  pauseStart: null,
  timerInterval: null,
  isRecording: false,
  isStarting: false,
  isPaused: false,
  hasSystemAudio: false,
  onTick: null,       // callback(seconds)
  onWaveform: null,   // callback(dataArray)
  onStop: null,       // callback(blob)
  onChunk: null,      // callback(blob) for realtime transcription
  onSystemAudioLost: null, // callback() when system audio share is stopped mid-recording
  _stopPromise: null,
  _resolveStop: null,

  /**
   * Check if getDisplayMedia with audio is supported in this browser.
   */
  supportsSystemAudio() {
    return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  },

  /**
   * Start recording.
   * @param {Object} [options]
   * @param {boolean} [options.captureSystemAudio=false] - Also capture system/tab audio via getDisplayMedia
   */
  async start(options = {}) {
    if (this.isRecording || this.isStarting) return false;
    this.isStarting = true;
    try {
      this.audioChunks = [];
      this.pausedDuration = 0;
      this.pauseStart = null;
      this._stopPromise = null;
      this._resolveStop = null;
      this.hasSystemAudio = false;

      // 1. Optionally get the system audio stream FIRST.
      // getDisplayMedia() requires fresh transient user activation. Calling it
      // after `await getUserMedia()` consumes/expires that activation, so Chrome
      // rejects it with InvalidStateError and system audio is silently lost.
      // Acquiring the screen share before touching the mic keeps the user
      // gesture valid. Mic capture below needs no activation, so its order is free.
      if (options.captureSystemAudio && this.supportsSystemAudio()) {
        try {
          this.systemAudioStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,   // Chrome requires video; we stop the track immediately
            audio: true,
            preferCurrentTab: false,
            selfBrowserSurface: 'exclude',
            systemAudio: 'include'
          });

          // Stop any video tracks (some browsers force a video track)
          this.systemAudioStream.getVideoTracks().forEach(track => track.stop());

          const audioTracks = this.systemAudioStream.getAudioTracks();
          if (audioTracks.length > 0) {
            this.hasSystemAudio = true;

            // Listen for user stopping the share mid-recording
            audioTracks[0].addEventListener('ended', () => {
              if (this.isRecording) {
                this.hasSystemAudio = false;
                this.systemAudioStream = null;
                if (this._systemSource) {
                  try { this._systemSource.disconnect(); } catch {}
                  this._systemSource = null;
                }
                if (this.onSystemAudioLost) this.onSystemAudioLost();
              }
            });
          } else {
            // No audio track obtained — continue with mic only
            this.systemAudioStream.getTracks().forEach(track => track.stop());
            this.systemAudioStream = null;
          }
        } catch (err) {
          // User cancelled the share dialog or browser doesn't support audio capture
          console.warn('System audio capture not available:', err.message);
          if (this.systemAudioStream) {
            this.systemAudioStream.getTracks().forEach(track => track.stop());
          }
          this.systemAudioStream = null;
        }
      }

      // 2. Get the microphone stream (no user activation required)
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });

      // 3. Set up AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this._micSource = this.audioContext.createMediaStreamSource(this.audioStream);

      // Analyser always watches the mic for waveform visualization
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this._micSource.connect(this.analyserNode);

      // 4. Determine the recording stream
      let recordingStream;
      if (this.hasSystemAudio && this.systemAudioStream) {
        // Mix mic + system audio into a single output stream
        this._mixDestination = this.audioContext.createMediaStreamDestination();
        this._micSource.connect(this._mixDestination);
        this._systemSource = this.audioContext.createMediaStreamSource(this.systemAudioStream);
        this._systemSource.connect(this._mixDestination);
        recordingStream = this._mixDestination.stream;
        this._mixedStream = recordingStream;
      } else {
        // Mic only — same as before
        recordingStream = this.audioStream;
        this._mixedStream = null;
      }

      // 5. Set up MediaRecorder on the recording stream
      const supportedMimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4'
      ].find(type => MediaRecorder.isTypeSupported(type));

      this.mediaRecorder = supportedMimeType
        ? new MediaRecorder(recordingStream, { mimeType: supportedMimeType })
        : new MediaRecorder(recordingStream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.audioChunks.push(e.data);
          if (this.onChunk) this.onChunk(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.audioChunks, {
          type: this.mediaRecorder?.mimeType || supportedMimeType || 'audio/webm'
        });
        if (this.onStop) this.onStop(blob);
        if (this._resolveStop) this._resolveStop(blob);
        this._resolveStop = null;
      };

      this.mediaRecorder.start(500); // Small chunks keep live transcription responsive
      this.startTime = Date.now();
      this.isRecording = true;
      this.isPaused = false;

      this._startTimer();
      this._startWaveform();

      return true;
    } catch (err) {
      console.error('Failed to start recording:', err);
      this._cleanupStreams();
      this.audioContext = null;
      this.mediaRecorder = null;
      this.isRecording = false;
      this.isPaused = false;
      this.hasSystemAudio = false;
      return false;
    } finally {
      this.isStarting = false;
    }
  },

  pause() {
    if (!this.isRecording || this.isPaused) return;
    this.mediaRecorder.pause();
    this.isPaused = true;
    this.pauseStart = Date.now();
    this._stopWaveform();
  },

  resume() {
    if (!this.isRecording || !this.isPaused) return;
    this.mediaRecorder.resume();
    this.isPaused = false;
    if (this.pauseStart) {
      this.pausedDuration += Date.now() - this.pauseStart;
      this.pauseStart = null;
    }
    this._startWaveform();
  },

  stop() {
    if (this._stopPromise) return this._stopPromise;
    if (!this.isRecording) return Promise.resolve(null);

    this._stopPromise = new Promise(resolve => {
      this._resolveStop = resolve;
    });

    if (this.isPaused && this.pauseStart) {
      this.pausedDuration += Date.now() - this.pauseStart;
    }

    this.isRecording = false;
    this.isPaused = false;
    this.hasSystemAudio = false;

    this._stopTimer();
    this._stopWaveform();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else if (this._resolveStop) {
      this._resolveStop(null);
      this._resolveStop = null;
    }

    this._cleanupStreams();

    if (this.audioContext) {
      this.audioContext.close();
    }

    return this._stopPromise;
  },

  /** Stop all media tracks and clean up audio graph nodes. */
  _cleanupStreams() {
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }
    if (this.systemAudioStream) {
      this.systemAudioStream.getTracks().forEach(track => track.stop());
      this.systemAudioStream = null;
    }
    if (this._micSource) {
      try { this._micSource.disconnect(); } catch {}
      this._micSource = null;
    }
    if (this._systemSource) {
      try { this._systemSource.disconnect(); } catch {}
      this._systemSource = null;
    }
    this._mixDestination = null;
    this._mixedStream = null;
  },

  getElapsedSeconds() {
    if (!this.startTime) return 0;
    const now = this.isPaused && this.pauseStart ? this.pauseStart : Date.now();
    return Math.floor((now - this.startTime - this.pausedDuration) / 1000);
  },

  getWaveformData() {
    if (!this.analyserNode) return new Uint8Array(0);
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  },

  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => {
      if (this.onTick) {
        this.onTick(this.getElapsedSeconds());
      }
    }, 200);
  },

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  },

  _waveformRAF: null,

  _startWaveform() {
    const tick = () => {
      if (!this.isRecording || this.isPaused) return;
      if (this.onWaveform) {
        this.onWaveform(this.getWaveformData());
      }
      this._waveformRAF = requestAnimationFrame(tick);
    };
    tick();
  },

  _stopWaveform() {
    if (this._waveformRAF) {
      cancelAnimationFrame(this._waveformRAF);
      this._waveformRAF = null;
    }
  },

  /**
   * Convert a legacy browser-stored audio blob to base64
   */
  async blobToBase64(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  },

  /**
   * Convert base64 back to audio blob
   */
  base64ToBlob(base64) {
    const parts = base64.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const decoded = atob(parts[1]);
    const array = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      array[i] = decoded.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
  }
};
