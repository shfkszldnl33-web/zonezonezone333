/*
 * breathing-engine.js — device-aware, quality-gated breathing-rate estimation.
 *
 * This module is intentionally framework-free and has NO dependency on the DOM, Web Audio,
 * or any browser API, so it can run unmodified in the browser (loaded as <script src=...>,
 * exposes window.BreathingEngine) and in plain Node for tests/breathing-engine.test.js
 * (module.exports).
 *
 * WHAT THIS DOES NOT DO (read before trusting any number that comes out of it):
 *   - It never measures the physical distance between a microphone and a mouth. A phone
 *     cannot do that from audio alone: the OS/hardware automatic gain control (AGC) and each
 *     person's own breathing loudness both change the recorded volume by amounts this code
 *     has no way to separate from "the mic moved farther away". See README.md for the full
 *     explanation of this limitation.
 *   - Every numeric constant below (distances, thresholds, weights) is an INITIAL ENGINEERING
 *     SETTING chosen to be directionally reasonable, not a value taken from or validated
 *     against a clinical/acoustic study. Anywhere this matters, the comment says so explicitly.
 *     None of these should be described to a user as "medically validated" - they are
 *     starting points that need real usage data (see the validation module at the bottom)
 *     before anyone should trust their precision.
 *   - It never converts microphone loudness directly into a breathing rate or a Zone. The
 *     breathing rate is always computed from the TIME between detected breath events; loudness
 *     (after per-device/per-user normalization) is only used to (a) decide whether a given
 *     instant crosses the detection threshold and (b) score how trustworthy the current
 *     reading is. See computeBreathsPerMinute() / BreathingDetector.pushFrame() below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BreathingEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================================================================== */
  /* 1. Device profiles                                                    */
  /* ==================================================================== */
  // 줄 이어폰(wired) / 무선 이어폰(wireless) / 헤드셋(headset) / 휴대폰 마이크(phone).
  //
  // assumedMouthDistanceCm exists only as a documentation hint for why the other numbers in
  // each profile differ (closer mic => can tolerate a higher detection floor & threshold
  // multiplier before picking up unrelated noise; farther mic => needs a lower floor so weak
  // breath sounds are not just an amplitude that hides in ambient noise forever).
  //
  // 이 값들은 초기 공학적 설정값(engineering starting values)이며, 의학적으로 검증되거나
  // 실측된 거리가 아닙니다. 5초 보정(Calibrator) 단계가 실제 사용자의 신호로 이 값들을
  // 즉시 덮어써서 세션별로 맞춰갑니다 - 아래 값은 그 보정이 시작할 때 쓰는 seed일 뿐입니다.
  var DEVICE_PROFILES = {
    wired: {
      id: 'wired',
      label: '줄 이어폰',
      assumedMouthDistanceCm: 15, // 초기 공학적 설정값, 검증 필요
      minDetectableRms: 0.008,
      floorRiseRate: 0.02,
      floorFallRate: 0.35,
      peakThresholdMultiplier: 1.6,
      targetNormalizedRms: 0.05,
    },
    wireless: {
      id: 'wireless',
      label: '무선 이어폰',
      assumedMouthDistanceCm: 25, // 초기 공학적 설정값, 검증 필요
      minDetectableRms: 0.004,
      floorRiseRate: 0.015,
      floorFallRate: 0.3,
      peakThresholdMultiplier: 1.45,
      targetNormalizedRms: 0.05,
    },
    headset: {
      id: 'headset',
      label: '헤드셋',
      assumedMouthDistanceCm: 8, // 초기 공학적 설정값, 검증 필요
      minDetectableRms: 0.012,
      floorRiseRate: 0.025,
      floorFallRate: 0.4,
      peakThresholdMultiplier: 1.7,
      targetNormalizedRms: 0.05,
    },
    phone: {
      id: 'phone',
      label: '휴대폰 마이크',
      assumedMouthDistanceCm: 35, // 초기 공학적 설정값, 검증 필요
      minDetectableRms: 0.003,
      floorRiseRate: 0.01,
      floorFallRate: 0.25,
      peakThresholdMultiplier: 1.4,
      targetNormalizedRms: 0.05,
    },
  };

  var DEFAULT_DEVICE_ID = 'phone';
  var CALIBRATION_DURATION_MS = 5000;
  var BREATH_REFRACTORY_MS = 1200; // minimum gap between two confirmed breaths
  var MAX_BREATH_HISTORY = 4; // timestamps kept for the LIVE displayed breaths/min (3 gaps) -
  // deliberately short so a real rate change shows up quickly (see the responsiveness/noise
  // tradeoff discussion this replaces, in the pre-rewrite version of index.html's tick()).
  var DROPOUT_GAP_MS = 5000; // no frames for this long => treat as a signal dropout
  var STALE_EVENT_MS = 9000; // no confirmed breath for 9s => data no longer fresh, switch to UNAVAILABLE
  var LONG_INTERVAL_HISTORY = 8; // gaps kept for the regularity (CV) estimate used by quality scoring
  var MIN_INTERVALS_FOR_REGULARITY = 4; // don't judge "irregular" from a 1-2 sample estimate -
  // natural breath-to-breath timing varies +-15-20% on its own, and a coefficient-of-variation
  // computed from only 1-2 gaps is dominated by sampling noise, not signal quality. Below this
  // many samples, intervalCv is treated as "not yet assessable" (see BreathingDetector.getQuality).

  // Adaptive threshold relaxation (see BreathingDetector.pushFrame). Without this, the detection
  // threshold is a FIXED multiple of the noise floor forever - if that fixed multiple happens to
  // sit just above what a real person's actual breathing produces on their actual hardware (a
  // realistic risk: peakThresholdMultiplier is an initial engineering guess, not something
  // measured per-device), no amount of waiting ever produces a number; the display is stuck at
  // "--" indefinitely with no way to recover. Standard peak-detection practice for exactly this
  // failure mode is to progressively lower the threshold the longer nothing has been confirmed,
  // so a plausible reason to relax (real signal, just underestimated headroom) eventually gets
  // through, while a still-generous floor (MIN_PEAK_THRESHOLD_MULTIPLIER) keeps pure ambient
  // noise from being mistaken for breathing even after full relaxation.
  var THRESHOLD_RELAX_START_MS = 10000; // no confirmed breath for this long -> start relaxing
  var THRESHOLD_RELAX_FULL_MS = 30000; // by this long with no confirmed breath -> fully relaxed
  var MIN_PEAK_THRESHOLD_MULTIPLIER = 1.25; // floor for the relaxed multiplier, unvalidated -
  // still requires a real, if modest, rise above the tracked noise floor even at full relaxation.

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }
  function stdDev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    return Math.sqrt(mean(arr.map(function (v) { return (v - m) * (v - m); })));
  }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function getDeviceProfile(deviceId) {
    return DEVICE_PROFILES[deviceId] || DEVICE_PROFILES[DEFAULT_DEVICE_ID];
  }

  /* ==================================================================== */
  /* 2. Frame-level artifact classification                                */
  /* ==================================================================== */
  // A "frame" is one analyser read (~every animation frame). The caller (browser code) is
  // expected to supply already band-filtered audio (see index.html's Web Audio biquad chain)
  // and pre-computed rms/zeroCrossingRate/clippingRatio for that frame - this module does not
  // touch raw audio buffers itself so it stays testable without Web Audio.
  //
  // NONE of the thresholds below come from a paper - they are heuristic proxies for artifact
  // shapes (a footstep is a short broadband thump, wind is sustained broadband hiss, speech is
  // fast structured modulation, cable/clothing rub correlates with motion) and are explicitly
  // "초기 구현값이며 실제 사용자 데이터로 검증해야 하는 값" - see README.md.
  function classifyArtifact(frame, ctx) {
    var deltaRms = frame.rms - ctx.previousRms;
    var motion = typeof frame.motionMagnitude === 'number' ? frame.motionMagnitude : null;

    if (frame.clippingRatio > 0.05) return 'clipping';

    // Footstep / impact thump: a sudden large jump in loudness that also lines up with a
    // motion spike (if motion data is available), or a very large jump with a low, non-tonal
    // shape (low zero-crossing rate) when motion data isn't available.
    var motionSpiking = motion != null && motion > ctx.motionSpikeThreshold;

    // Cable/clothing rub: elevated noisy (high zero-crossing) signal that co-occurs with
    // motion but isn't a single sharp impact.
    if (motionSpiking && frame.zcr > 0.3) return 'cable';

    // Footstep / impact thump: a sudden large jump in loudness that also lines up with a
    // motion spike (if motion data is available), or a very large jump with a low, non-tonal
    // shape (low zero-crossing rate) when motion data isn't available.
    if (motionSpiking && (deltaRms > ctx.noiseFloor * 2 || frame.rms > ctx.noiseFloor * 2.5 || frame.zcr < 0.2)) {
      return 'footstep';
    }
    if (deltaRms > ctx.noiseFloor * 4 && (motionSpiking || frame.zcr < 0.15)) {
      return motionSpiking ? 'footstep' : 'cable';
    }

    // Wind: sustained (not a single-frame transient) broadband hiss - high zero-crossing rate,
    // elevated loudness, but not a sudden spike and not accompanied by motion.
    if (frame.zcr > 0.45 && frame.rms > ctx.noiseFloor * 2 && !motionSpiking && Math.abs(deltaRms) < ctx.noiseFloor * 1.5) {
      return 'wind';
    }

    // Speech: fast repeated high-zero-crossing bursts, faster than a plausible breath rate.
    if (frame.zcr > 0.35 && ctx.recentZcrPeakRatePerSec > 3) return 'speech';

    if (frame.rms > ctx.noiseFloor * 3 && ctx.ambientRatio > 3) return 'ambient_noise';

    return null;
  }

  /* ==================================================================== */
  /* 3. Calibration (first 5 seconds of a session)                         */
  /* ==================================================================== */
  function createCalibrator(deviceId) {
    var profile = getDeviceProfile(deviceId);
    var frames = [];
    var candidateAmplitudes = [];
    var candidateIntervalsMs = [];
    var lastCandidateTs = null;
    var runningFloor = null;

    return {
      deviceId: profile.id,
      durationMs: CALIBRATION_DURATION_MS,

      // frame: { rms, zcr, clippingRatio, motionMagnitude, timestampMs }
      addFrame: function (frame) {
        frames.push(frame);
        if (runningFloor == null) runningFloor = frame.rms;
        runningFloor += (frame.rms < runningFloor ? 0.3 : 0.05) * (frame.rms - runningFloor);
        var threshold = Math.max(runningFloor * profile.peakThresholdMultiplier, profile.minDetectableRms);
        if (frame.rms > threshold && (lastCandidateTs == null || frame.timestampMs - lastCandidateTs > BREATH_REFRACTORY_MS)) {
          if (lastCandidateTs != null) candidateIntervalsMs.push(frame.timestampMs - lastCandidateTs);
          candidateAmplitudes.push(frame.rms);
          lastCandidateTs = frame.timestampMs;
        }
      },

      isComplete: function (elapsedMs) { return elapsedMs >= CALIBRATION_DURATION_MS; },

      // Produces the CalibrationProfile everything downstream (BreathingDetector) is built on.
      finalize: function () {
        var rmsValues = frames.map(function (f) { return f.rms; });
        var clippingValues = frames.map(function (f) { return f.clippingRatio || 0; });
        var sortedRms = rmsValues.slice().sort(function (a, b) { return a - b; });
        // Ambient noise = quietest 20% of the calibration window (the gaps between breaths),
        // not a plain average, since the average is pulled up by the breaths themselves.
        var quietSlice = sortedRms.slice(0, Math.max(1, Math.floor(sortedRms.length * 0.2)));
        var ambientNoiseRms = mean(quietSlice) || profile.minDetectableRms;
        var meanSignalAmplitude = mean(rmsValues) || profile.minDetectableRms;
        var signalStdDev = stdDev(rmsValues);
        var snrLinear = meanSignalAmplitude / Math.max(ambientNoiseRms, 1e-6);
        var snrDb = 20 * Math.log10(Math.max(snrLinear, 1e-6));
        var clippingRatio = mean(clippingValues);
        var eventAmplitudeMean = candidateAmplitudes.length ? mean(candidateAmplitudes) : meanSignalAmplitude;
        var eventIntervalMeanMs = candidateIntervalsMs.length ? mean(candidateIntervalsMs) : null;

        // Normalization gain: brings THIS device+user combination's typical breath loudness up
        // (or down) to a common target level, so the shared detection-threshold/quality logic
        // downstream never has to know whether it's looking at a loud close-mic signal or a
        // faint far-mic one. This is the mechanism that satisfies "거리 때문에 Zone이 달라지지
        // 않게" - amplitude is normalized away before it ever reaches threshold/quality code,
        // and breathing RATE itself is computed purely from event timing (see
        // BreathingDetector.pushFrame), never from this normalized amplitude.
        var normalizationGain = profile.targetNormalizedRms / Math.max(eventAmplitudeMean, profile.minDetectableRms);

        var ambientNoiseEnergy = ambientNoiseRms * ambientNoiseRms;
        var maxInputRms = rmsValues.length ? Math.max.apply(null, rmsValues) : meanSignalAmplitude;
        var hasClipping = clippingValues.some(function (c) { return c > 0.02; });

        return {
          deviceId: profile.id,
          ambientNoiseRms: ambientNoiseRms,
          ambientNoiseEnergy: ambientNoiseEnergy, // 주변 소음 RMS 및 에너지
          meanSignalAmplitude: meanSignalAmplitude,
          meanBreathAmplitude: eventAmplitudeMean, // 평균 호흡 신호 크기
          signalStdDev: signalStdDev, // 신호의 표준편차
          maxInputRms: maxInputRms, // 최대 입력값
          hasClipping: hasClipping, // clipping 여부
          clippingRatio: clippingRatio,
          snrDb: snrDb,
          eventAmplitudeMean: eventAmplitudeMean,
          eventIntervalMeanMs: eventIntervalMeanMs,
          candidateEventCount: candidateAmplitudes.length,
          normalizationGain: normalizationGain,
          frameCount: frames.length,
          calibratedAt: frames.length ? frames[frames.length - 1].timestampMs : null,
        };
      },
    };
  }

  /* ==================================================================== */
  /* 4. Signal-quality scoring                                             */
  /* ==================================================================== */
  // Composite 0-100 score. Weights below are this app's own engineering judgement call about
  // relative importance, not a formula from any cited paper - see README.md "검증 필요" note.
  function computeQualityScore(inputs) {
    var snrScore = clamp(inputs.snrDb / 12, 0, 1) * 35;
    var validEventScore = clamp(inputs.validEventRatio, 0, 1) * 20;
    var regularityScore = (1 - clamp(inputs.intervalCv, 0, 1)) * 20;
    var freshnessScore = clamp(1 - inputs.msSinceLastEvent / STALE_EVENT_MS, 0, 1) * 10;
    var calibrationScore = inputs.isCalibrated ? 15 : 0;
    var clippingPenalty = clamp(inputs.clippingRatio, 0, 1) * 30;
    var motionPenalty = clamp(inputs.motionArtifactRatio, 0, 1) * 25;

    var raw = snrScore + validEventScore + regularityScore + freshnessScore + calibrationScore
      - clippingPenalty - motionPenalty;
    return clamp(Math.round(raw), 0, 100);
  }

  // Discrete status the UI actually shows. Order matters - first match wins.
  var STATUS = {
    INITIALIZING: 'INITIALIZING',
    CALIBRATING: 'CALIBRATING',
    MEASURING: 'MEASURING',
    GOOD: 'GOOD',
    UNSTABLE: 'UNSTABLE',
    NOISY: 'NOISY',
    CHECK_MIC_POSITION: 'CHECK_MIC_POSITION',
    UNAVAILABLE: 'UNAVAILABLE',
  };

  var STATUS_LABEL_KO = {
    INITIALIZING: '측정 준비 중',
    CALIBRATING: '보정 중',
    MEASURING: '측정 중',
    GOOD: '신호 양호',
    UNSTABLE: '신호 불안정',
    NOISY: '주변 소음이 큼',
    CHECK_MIC_POSITION: '마이크 위치 확인 필요',
    UNAVAILABLE: '신호 부족',
  };

  function deriveStatus(inputs) {
    if (!inputs.isCalibrated) return STATUS.CALIBRATING;
    if (inputs.hadRecentDropout || inputs.msSinceLastEvent > STALE_EVENT_MS) return STATUS.UNAVAILABLE;
    if (inputs.clippingRatio > 0.15) return STATUS.CHECK_MIC_POSITION;
    if (inputs.ambientRatio > 3) return STATUS.NOISY;
    if (inputs.confirmedEventCount < 3) return STATUS.MEASURING;
    if (inputs.motionArtifactRatio > 0.45 || inputs.intervalCv > 0.55 || inputs.snrDb < 2.5) return STATUS.UNSTABLE;
    if (inputs.qualityScore >= 55) return STATUS.GOOD;
    return STATUS.MEASURING;
  }

  // Zone/intensity must never be shown from a shaky reading or before enough data is collected.
  function canDisplayZone(status, confirmedEventCount, breathsPerMin, qualityScore) {
    if (status === STATUS.INITIALIZING || status === STATUS.CALIBRATING) return false;
    if (status === STATUS.UNAVAILABLE || status === STATUS.CHECK_MIC_POSITION || status === STATUS.NOISY) return false;
    if (!confirmedEventCount || confirmedEventCount < 2) return false;
    if (breathsPerMin !== undefined && breathsPerMin !== null) {
      if (!Number.isFinite(breathsPerMin) || breathsPerMin <= 0 || breathsPerMin < 8 || breathsPerMin > 65) return false;
    }
    if (status === STATUS.GOOD) return confirmedEventCount >= 2;
    if (status === STATUS.MEASURING && typeof qualityScore === 'number' && qualityScore >= 50) return confirmedEventCount >= 2;
    return false;
  }

  /* ==================================================================== */
  /* 5. Breathing-rate computation from event timestamps                   */
  /* ==================================================================== */
  function computeBreathsPerMinute(recentEventTimestamps) {
    if (recentEventTimestamps.length < 2) return null;
    var intervals = [];
    for (var i = 1; i < recentEventTimestamps.length; i++) {
      intervals.push(recentEventTimestamps[i] - recentEventTimestamps[i - 1]);
    }
    var avgIntervalMs = mean(intervals);
    if (avgIntervalMs <= 0) return null;
    return 60000 / avgIntervalMs;
  }

  /* ==================================================================== */
  /* 6. BreathingDetector - the per-session stateful pipeline               */
  /* ==================================================================== */
  // Processing order matches the spec this module implements:
  //   preprocessing (caller: DC removal via Web Audio) -> band filter (caller: biquad chain)
  //   -> smoothing/envelope (this.noiseFloor EMA + the rms itself, computed by caller from the
  //   filtered buffer) -> event detection (pushFrame below) -> inter-event interval
  //   -> breathing-rate estimate (computeBreathsPerMinute).
  function BreathingDetector(deviceId, calibrationProfile) {
    this.profile = getDeviceProfile(deviceId);
    this.calibration = calibrationProfile;
    // Bug this fixes: noiseFloor/previousRms used to be seeded from the RAW (un-normalized)
    // calibration RMS, but every value they get compared against afterward (pushFrame's
    // normalizedRms) is scaled by calibration.normalizationGain. Whenever that gain isn't ~1
    // (the common case), the floor started out several times too low or too high relative to
    // the actual normalized signal, skewing the threshold right at the start of a session -
    // exactly when a clean baseline matters most. Seed both in the same normalized space
    // everything else operates in.
    var seedFloor = calibrationProfile.ambientNoiseRms * calibrationProfile.normalizationGain;
    this.noiseFloor = seedFloor;
    this.previousRms = seedFloor;
    this.calibratedAmbientFloor = seedFloor; // Normalized baseline for ambient ratio comparison
    this.eventTimestamps = []; // short window (MAX_BREATH_HISTORY) for the live displayed rate
    this.longIntervals = []; // longer window (LONG_INTERVAL_HISTORY) for the regularity estimate
    this.confirmedAmplitudes = []; // normalized RMS at each confirmed breath, for live SNR
    this.lastEventTs = null;
    this.lastFrameTs = null;
    this.hadRecentDropout = false;
    this.zcrPeakTimestamps = []; // for speech-rate heuristic
    // m/s^2 above baseline; initial engineering value, unvalidated. Raised from an earlier 1.5
    // after real-world testing showed ordinary body movement while wearing/carrying the device
    // (not just footstrike impacts) routinely exceeded 1.5, which - combined with the blanket
    // motion gate this replaces below - blocked breath confirmation almost continuously any time
    // the person moved at all, including just walking. classifyArtifact() (not a flat threshold
    // on motionMagnitude alone) is now what actually decides whether a given frame looks like a
    // footstep/cable artifact; this threshold is only used for that classification and for the
    // motionArtifactRatio quality signal, not as a standalone breath-confirmation blocker.
    this.motionSpikeThreshold = 4;
    this.window = { total: 0, artifacts: 0, motionArtifacts: 0, clipping: [], invalid: 0 };
    this.detectorStartMs = null; // set on first real frame; anchors relaxation before any breath is confirmed
  }

  BreathingDetector.prototype._recentZcrPeakRatePerSec = function (nowMs) {
    this.zcrPeakTimestamps = this.zcrPeakTimestamps.filter(function (t) { return nowMs - t < 1000; });
    return this.zcrPeakTimestamps.length;
  };

  // frame: { rms, zcr, clippingRatio, motionMagnitude, timestampMs }
  // Returns a snapshot describing what happened with this frame (used by tests and by the UI).
  BreathingDetector.prototype.pushFrame = function (frame) {
    // [2. 신호 품질 우선] null, undefined, NaN, Infinity, 0 이하의 값은 무효 처리
    if (!frame || typeof frame.rms !== 'number' || !Number.isFinite(frame.rms) || frame.rms <= 0) {
      this.window.total++;
      this.window.invalid++;
      return {
        confirmedBreath: false,
        artifact: 'invalid_data',
        normalizedRms: 0,
        threshold: this.noiseFloor * this.profile.peakThresholdMultiplier,
        breathsPerMin: computeBreathsPerMinute(this.eventTimestamps),
      };
    }

    var now = frame.timestampMs;
    var dt = this.lastFrameTs == null ? 0 : now - this.lastFrameTs;
    if (dt > DROPOUT_GAP_MS) {
      this.hadRecentDropout = true;
      // Stale history is worse than no history - a >5s gap means whatever came before it says
      // nothing reliable about the rate/regularity of what's happening now.
      this.eventTimestamps = [];
      this.longIntervals = [];
      this.confirmedAmplitudes = [];
      this.lastEventTs = null;
    }
    this.lastFrameTs = now;

    var normalizedRms = frame.rms * this.calibration.normalizationGain;
    var normalizedFrame = {
      rms: normalizedRms,
      zcr: frame.zcr,
      clippingRatio: frame.clippingRatio || 0,
      motionMagnitude: frame.motionMagnitude,
      timestampMs: now,
    };

    if (frame.zcr > 0.35) this.zcrPeakTimestamps.push(now);

    // Compare normalized current noise floor to normalized calibrated noise floor
    var ambientRatio = this.noiseFloor / Math.max(this.calibratedAmbientFloor, 1e-6);
    var artifact = classifyArtifact(normalizedFrame, {
      previousRms: this.previousRms,
      noiseFloor: this.noiseFloor,
      motionSpikeThreshold: this.motionSpikeThreshold,
      recentZcrPeakRatePerSec: this._recentZcrPeakRatePerSec(now),
      ambientRatio: ambientRatio,
    });

    // Asymmetric floor: falls fast toward quiet, rises slowly through loud stretches, so a
    // genuinely faster breathing rate still pokes up above the floor instead of being chased.
    this.noiseFloor += (normalizedRms < this.noiseFloor ? this.profile.floorRiseRate * 15 : this.profile.floorRiseRate)
      * (normalizedRms - this.noiseFloor);

    if (this.detectorStartMs == null) this.detectorStartMs = now;
    var relaxReferenceTs = this.lastEventTs != null ? this.lastEventTs : this.detectorStartMs;
    var msSinceLastConfirmed = now - relaxReferenceTs;
    var relaxProgress = clamp((msSinceLastConfirmed - THRESHOLD_RELAX_START_MS) / (THRESHOLD_RELAX_FULL_MS - THRESHOLD_RELAX_START_MS), 0, 1);
    var effectiveMultiplier = this.profile.peakThresholdMultiplier - relaxProgress * (this.profile.peakThresholdMultiplier - MIN_PEAK_THRESHOLD_MULTIPLIER);
    var threshold = Math.max(this.noiseFloor * effectiveMultiplier, this.profile.targetNormalizedRms * 0.3 * (1 - relaxProgress * 0.6));

    this.window.total++;
    if (artifact) this.window.artifacts++;
    var motionSpiking = typeof frame.motionMagnitude === 'number' && frame.motionMagnitude > this.motionSpikeThreshold;
    if (motionSpiking) this.window.motionArtifacts++;
    this.window.clipping.push(normalizedFrame.clippingRatio);
    if (this.window.clipping.length > 300) this.window.clipping.shift();
    if (this.window.total > 600) { this.window.total = 300; this.window.artifacts = Math.round(this.window.artifacts / 2); this.window.motionArtifacts = Math.round(this.window.motionArtifacts / 2); }

    var confirmedBreath = false;
    // A breath is confirmed when it's not flagged as an artifact and crosses the (normalized,
    // device/user-corrected) threshold.
    //
    // Bug this fixes: this used to ALSO require `!motionSpiking` outright - any frame where
    // motion exceeded motionSpikeThreshold was refused confirmation, full stop, regardless of
    // what classifyArtifact() actually decided. Real accelerometer readings during ordinary
    // movement (walking, arm swing, even just holding the phone while breathing normally) sit
    // above small thresholds often enough that this blanket gate could suppress breath
    // confirmation almost continuously during exactly the activity levels (walking/running)
    // this feature exists for - not just at genuine footstep/impact moments. classifyArtifact()
    // already looks at motion TOGETHER WITH the audio shape (a sudden amplitude jump, or a
    // noisy high-zero-crossing signal) to decide footstep vs. cable vs. an ordinary breath that
    // happens to coincide with motion - that combined judgment is what should gate confirmation,
    // not motion alone. motionSpiking is still tracked (below) for the quality score's
    // motionArtifactRatio penalty.
    if (!artifact && normalizedRms > threshold
      && (this.lastEventTs == null || now - this.lastEventTs > BREATH_REFRACTORY_MS)) {
      confirmedBreath = true;
      if (this.lastEventTs != null) {
        this.longIntervals.push(now - this.lastEventTs);
        if (this.longIntervals.length > LONG_INTERVAL_HISTORY) this.longIntervals.shift();
      }
      this.lastEventTs = now;
      this.eventTimestamps.push(now);
      if (this.eventTimestamps.length > MAX_BREATH_HISTORY) this.eventTimestamps.shift();
      this.confirmedAmplitudes.push(normalizedRms);
      if (this.confirmedAmplitudes.length > LONG_INTERVAL_HISTORY) this.confirmedAmplitudes.shift();
    }

    this.previousRms = normalizedRms;

    return {
      confirmedBreath: confirmedBreath,
      artifact: artifact,
      normalizedRms: normalizedRms,
      threshold: threshold,
      breathsPerMin: computeBreathsPerMinute(this.eventTimestamps),
    };
  };

  BreathingDetector.prototype.getQuality = function (nowMs) {
    // Regularity (CV) is computed from the LONGER interval history, and only once there are
    // enough samples to make that estimate mean anything (see MIN_INTERVALS_FOR_REGULARITY) -
    // judging "irregular" from 1-2 gaps was the main cause of sessions getting stuck reporting
    // 신호 불안정 forever even with clean, normal breathing (see the comment in deriveStatus()).
    var intervalCv = 0;
    if (this.longIntervals.length >= MIN_INTERVALS_FOR_REGULARITY) {
      var longMean = mean(this.longIntervals);
      intervalCv = longMean > 0 ? stdDev(this.longIntervals) / longMean : 0;
    }
    var validEventRatio = this.window.total ? Math.max(0, 1 - ((this.window.artifacts + (this.window.invalid || 0)) / this.window.total)) : 0;
    var motionArtifactRatio = this.window.total ? this.window.motionArtifacts / this.window.total : 0;
    var clippingRatio = this.window.clipping.length ? mean(this.window.clipping) : 0;
    var ambientRatio = this.noiseFloor / Math.max(this.calibratedAmbientFloor, 1e-6);
    var lastEvent = this.eventTimestamps[this.eventTimestamps.length - 1];
    var msSinceLastEvent = lastEvent == null ? STALE_EVENT_MS : (nowMs - lastEvent);
    // SNR numerator: once we've actually confirmed a couple of real breaths, use THEIR own
    // measured amplitude rather than staying anchored to the one-shot 5-second calibration
    // guess forever - a 5-second window can easily contain zero or one full breath cycle
    // (resting adult breathing is ~12-20/min, i.e. one breath every 3-5s), so the calibration
    // estimate is a starting point, not something later live data should be unable to correct.
    var liveAmplitudeMean = this.confirmedAmplitudes.length >= 2
      ? mean(this.confirmedAmplitudes)
      : this.calibration.eventAmplitudeMean * this.calibration.normalizationGain;
    var snrDb = 20 * Math.log10(Math.max(this.noiseFloor > 0 ? liveAmplitudeMean / this.noiseFloor : 1, 1e-6));

    var qualityInputs = {
      snrDb: snrDb,
      validEventRatio: validEventRatio,
      intervalCv: intervalCv,
      msSinceLastEvent: msSinceLastEvent,
      isCalibrated: true,
      clippingRatio: clippingRatio,
      motionArtifactRatio: motionArtifactRatio,
    };
    var qualityScore = computeQualityScore(qualityInputs);
    var status = deriveStatus({
      isCalibrated: true,
      hadRecentDropout: this.hadRecentDropout,
      msSinceLastEvent: msSinceLastEvent,
      clippingRatio: clippingRatio,
      ambientRatio: ambientRatio,
      motionArtifactRatio: motionArtifactRatio,
      intervalCv: intervalCv,
      snrDb: snrDb,
      confirmedEventCount: this.eventTimestamps.length,
      qualityScore: qualityScore,
    });
    this.hadRecentDropout = false; // one-shot flag; caller sees UNAVAILABLE for this tick then it clears

    var breathsPerMin = computeBreathsPerMinute(this.eventTimestamps);
    return {
      score: qualityScore,
      status: status,
      statusLabel: STATUS_LABEL_KO[status],
      canDisplayZone: canDisplayZone(status, this.eventTimestamps.length, breathsPerMin, qualityScore),
      breathsPerMin: breathsPerMin,
      confirmedEventCount: this.eventTimestamps.length,
      recentValidDataRatio: validEventRatio,
      details: qualityInputs,
    };
  };

  /* ==================================================================== */
  /* 7. Validation-mode statistics                                         */
  /* ==================================================================== */
  // records: [{ predictedBpm, referenceBpm, quality, deviceType, activity }]
  // Bland-Altman style agreement stats. Nothing here is a validated clinical metric threshold -
  // it just computes the standard MAE/RMSE/bias/95% LoA definitions on whatever pairs are given.
  function computeAgreementStats(records) {
    var pairs = records.filter(function (r) { return typeof r.predictedBpm === 'number' && typeof r.referenceBpm === 'number'; });
    if (!pairs.length) return { n: 0, mae: null, rmse: null, bias: null, loaLower: null, loaUpper: null };
    var diffs = pairs.map(function (r) { return r.predictedBpm - r.referenceBpm; });
    var absErrors = diffs.map(Math.abs);
    var sqErrors = diffs.map(function (d) { return d * d; });
    var bias = mean(diffs);
    var diffSd = stdDev(diffs);
    return {
      n: pairs.length,
      mae: mean(absErrors),
      rmse: Math.sqrt(mean(sqErrors)),
      bias: bias,
      loaLower: bias - 1.96 * diffSd,
      loaUpper: bias + 1.96 * diffSd,
    };
  }

  function groupBy(records, keyFn) {
    var groups = {};
    records.forEach(function (r) {
      var key = keyFn(r);
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    });
    return groups;
  }

  // Produces the breakdown requirement #15 asks for: overall + by activity + by device type +
  // by signal-quality bucket.
  function computeValidationReport(records) {
    var byActivity = groupBy(records, function (r) { return r.activity || 'unknown'; });
    var byDevice = groupBy(records, function (r) { return r.deviceType || 'unknown'; });
    var byQuality = groupBy(records, function (r) { return r.quality || 'unknown'; });

    function mapStats(groups) {
      var out = {};
      Object.keys(groups).forEach(function (k) { out[k] = computeAgreementStats(groups[k]); });
      return out;
    }

    return {
      overall: computeAgreementStats(records),
      byActivity: mapStats(byActivity),
      byDevice: mapStats(byDevice),
      byQuality: mapStats(byQuality),
    };
  }

  return {
    DEVICE_PROFILES: DEVICE_PROFILES,
    DEFAULT_DEVICE_ID: DEFAULT_DEVICE_ID,
    CALIBRATION_DURATION_MS: CALIBRATION_DURATION_MS,
    STATUS: STATUS,
    STATUS_LABEL_KO: STATUS_LABEL_KO,
    getDeviceProfile: getDeviceProfile,
    createCalibrator: createCalibrator,
    classifyArtifact: classifyArtifact,
    computeQualityScore: computeQualityScore,
    deriveStatus: deriveStatus,
    canDisplayZone: canDisplayZone,
    computeBreathsPerMinute: computeBreathsPerMinute,
    BreathingDetector: BreathingDetector,
    computeAgreementStats: computeAgreementStats,
    computeValidationReport: computeValidationReport,
  };
});
