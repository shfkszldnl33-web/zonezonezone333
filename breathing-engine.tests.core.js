/*
 * Shared test bodies for breathing-engine.js, written with no Node-only or browser-only APIs
 * so the exact same test logic can run two ways:
 *   - tests/breathing-engine.test.js   -> `node tests/breathing-engine.test.js`
 *   - tests/run-tests.html             -> open in any browser
 * See the header comment in breathing-engine.js for what these tests do and don't prove.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BreathingEngineTests = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function assertOk(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
  function assertEqual(a, b, msg) { if (a !== b) throw new Error((msg || 'expected equal') + ' (got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b) + ')'); }
  function assertNotEqual(a, b, msg) { if (a === b) throw new Error((msg || 'expected not equal') + ' (both were ' + JSON.stringify(a) + ')'); }

  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function generateFrames(opts) {
    const rng = makeRng(opts.seed || 1);
    const frameIntervalMs = opts.frameIntervalMs || 33;
    const cyclePeriodMs = 60000 / opts.breathsPerMin;
    const frames = [];
    let t = 0;
    const artifacts = opts.artifacts || [];
    while (t < opts.durationMs) {
      const phase = (t % cyclePeriodMs) / cyclePeriodMs;
      const inPulse = phase < 0.3;
      const pulseShape = inPulse ? Math.sin((phase / 0.3) * Math.PI) : 0;
      let rms = opts.ambientRms + pulseShape * opts.breathAmplitude + (rng() - 0.5) * opts.ambientRms * 0.3;
      let zcr = opts.baseZcr != null ? opts.baseZcr : 0.1 + rng() * 0.05;
      let clippingRatio = 0;
      let motionMagnitude = opts.baseMotion != null ? opts.baseMotion : 0.1 + rng() * 0.1;

      artifacts.forEach(function (a) {
        if (t >= a.atMs && t < a.atMs + (a.durationMs || frameIntervalMs)) {
          if (a.type === 'footstep') { rms = opts.ambientRms + (a.amplitude || opts.breathAmplitude * 3); motionMagnitude = a.motion != null ? a.motion : 5; zcr = 0.1; }
          if (a.type === 'wind') { rms = opts.ambientRms + (a.amplitude || opts.breathAmplitude * 1.5); zcr = 0.6; motionMagnitude = opts.baseMotion || 0.1; }
          if (a.type === 'cable') { rms = opts.ambientRms + (a.amplitude || opts.breathAmplitude * 2); zcr = 0.5; motionMagnitude = a.motion != null ? a.motion : 3; }
          if (a.type === 'clipping') { rms = 1.0; clippingRatio = 0.5; }
        }
      });

      frames.push({ rms: Math.max(0, rms), zcr: zcr, clippingRatio: clippingRatio, motionMagnitude: motionMagnitude, timestampMs: t });
      t += frameIntervalMs;
    }
    return frames;
  }

  function runAll(BreathingEngine, log) {
    log = log || function () {};
    let passed = 0;
    let failed = 0;
    const failures = [];

    function test(name, fn) {
      try {
        fn();
        passed++;
        log('ok - ' + name);
      } catch (err) {
        failed++;
        failures.push({ name: name, error: err });
        log('FAIL - ' + name + ' :: ' + (err && err.message ? err.message : err));
      }
    }

    function runCalibrationAndDetector(deviceId, calibFrames, mainFrames) {
      const calibrator = BreathingEngine.createCalibrator(deviceId);
      calibFrames.forEach(function (f) { calibrator.addFrame(f); });
      const calibrationProfile = calibrator.finalize();
      const detector = new BreathingEngine.BreathingDetector(deviceId, calibrationProfile);
      const results = mainFrames.map(function (f) { return detector.pushFrame(f); });
      const lastTs = mainFrames.length ? mainFrames[mainFrames.length - 1].timestampMs : 0;
      const quality = detector.getQuality(lastTs);
      return { calibrationProfile: calibrationProfile, detector: detector, results: results, quality: quality };
    }

    log('Device profiles');
    test('all four device types exist with distinct engineering defaults', function () {
      ['wired', 'wireless', 'headset', 'phone'].forEach(function (id) {
        const p = BreathingEngine.getDeviceProfile(id);
        assertEqual(p.id, id);
        assertOk(typeof p.assumedMouthDistanceCm === 'number');
      });
      const distances = ['wired', 'wireless', 'headset', 'phone'].map(function (id) { return BreathingEngine.getDeviceProfile(id).assumedMouthDistanceCm; });
      assertEqual(new Set(distances).size, 4, 'each device profile should have its own distance seed');
    });

    log('1) 줄 이어폰(wired)을 가까이 사용 - 크고 또렷한 신호');
    test('wired-close: breathing rate converges near the true rate', function () {
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.15, durationMs: 5000, seed: 1 });
      const main = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.15, durationMs: 20000, seed: 2 });
      const r = runCalibrationAndDetector('wired', calib, main);
      assertOk(r.quality.breathsPerMin != null, 'should detect a rate');
      assertOk(Math.abs(r.quality.breathsPerMin - 14) < 4, 'rate should be roughly 14/min, got ' + r.quality.breathsPerMin);
    });

    log('1b) 회귀 테스트: 정상적인 안정 호흡이 영구히 "신호 불안정"에 갇히면 안 됨');
    test('wired-close, calm regular breathing: reaches GOOD status, not stuck at UNSTABLE', function () {
      // Reproduces a real bug report: deriveStatus() used to check interval-regularity (CV)
      // BEFORE checking whether there was enough data to judge it, so a session could get
      // permanently stuck reporting 신호 불안정 even with completely normal breathing, simply
      // because early on there weren't yet enough confirmed breaths for the CV estimate to be
      // meaningful. 30 seconds of calm 14/min breathing should clearly reach GOOD at some point.
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.15, durationMs: 5000, seed: 101 });
      const main = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.15, durationMs: 30000, seed: 102 });
      const calibrator = BreathingEngine.createCalibrator('wired');
      calib.forEach((f) => calibrator.addFrame(f));
      const detector = new BreathingEngine.BreathingDetector('wired', calibrator.finalize());
      let sawGood = false;
      let sawStuckUnstable = 0;
      main.forEach((f) => {
        detector.pushFrame(f);
        const q = detector.getQuality(f.timestampMs);
        if (q.status === BreathingEngine.STATUS.GOOD) sawGood = true;
        if (q.status === BreathingEngine.STATUS.UNSTABLE && q.confirmedEventCount < 3) sawStuckUnstable++;
      });
      assertEqual(sawStuckUnstable, 0, 'must never report UNSTABLE before there is enough data to judge regularity (should be MEASURING instead)');
      assertOk(sawGood, 'calm regular breathing over 30s should reach GOOD status at some point');
    });

    log('2) 줄 이어폰을 멀리 사용 - 약한 신호');
    test('wired-far: weak signal still normalizes and detects some breaths', function () {
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.02, durationMs: 5000, seed: 3 });
      const main = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.02, durationMs: 20000, seed: 4 });
      const r = runCalibrationAndDetector('wired', calib, main);
      assertOk(r.calibrationProfile.normalizationGain > 1, 'weak signal should get gained up by normalization');
      assertOk(r.quality.confirmedEventCount >= 3, 'should still confirm some breaths after normalization');
    });

    log('3) 무선 이어폰(wireless) 사용');
    test('wireless: uses the wireless profile and detects a plausible rate', function () {
      const calib = generateFrames({ breathsPerMin: 16, ambientRms: 0.006, breathAmplitude: 0.03, durationMs: 5000, seed: 5 });
      const main = generateFrames({ breathsPerMin: 16, ambientRms: 0.006, breathAmplitude: 0.03, durationMs: 20000, seed: 6 });
      const r = runCalibrationAndDetector('wireless', calib, main);
      assertOk(r.quality.breathsPerMin != null && Math.abs(r.quality.breathsPerMin - 16) < 4);
    });

    log('4) 헤드셋(headset) 사용');
    test('headset: uses the headset profile and detects a plausible rate', function () {
      const calib = generateFrames({ breathsPerMin: 18, ambientRms: 0.015, breathAmplitude: 0.2, durationMs: 5000, seed: 7 });
      const main = generateFrames({ breathsPerMin: 18, ambientRms: 0.015, breathAmplitude: 0.2, durationMs: 20000, seed: 8 });
      const r = runCalibrationAndDetector('headset', calib, main);
      assertOk(r.quality.breathsPerMin != null && Math.abs(r.quality.breathsPerMin - 18) < 4);
    });

    log('5) 러닝 중 마이크 위치 변화');
    test('running mic-position drift: does not crash and keeps producing a rate estimate', function () {
      const calib = generateFrames({ breathsPerMin: 22, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 5000, seed: 9 });
      const part1 = generateFrames({ breathsPerMin: 22, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 10000, seed: 10 });
      const part2 = generateFrames({ breathsPerMin: 22, ambientRms: 0.01, breathAmplitude: 0.02, durationMs: 10000, seed: 11 }).map(function (f) {
        return Object.assign({}, f, { timestampMs: f.timestampMs + 10000 });
      });
      const r = runCalibrationAndDetector('wired', calib, part1.concat(part2));
      assertOk(typeof r.quality.score === 'number');
      assertOk(Object.keys(BreathingEngine.STATUS).map(function (k) { return BreathingEngine.STATUS[k]; }).indexOf(r.quality.status) !== -1);
    });

    log('6) 발소리 증가');
    test('footsteps: classified as footstep artifact and do not inflate the breathing rate', function () {
      const calib = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 5000, seed: 12 });
      const footstepArtifacts = [];
      for (let t = 0; t < 20000; t += 400) footstepArtifacts.push({ type: 'footstep', atMs: t, durationMs: 60, motion: 6 });
      const main = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 20000, seed: 13, artifacts: footstepArtifacts });
      const r = runCalibrationAndDetector('wired', calib, main);
      const footstepCount = main.filter(function (f) { return f.motionMagnitude >= 5; }).length;
      assertOk(footstepCount > 0, 'test setup sanity check');
      if (r.quality.breathsPerMin != null) {
        assertOk(Math.abs(r.quality.breathsPerMin - 15) < 6, 'footstep cadence should not hijack the reading, got ' + r.quality.breathsPerMin);
      }
    });

    log('7) 바람 소리 증가');
    test('wind: classified as an artifact and degrades status away from GOOD', function () {
      const calib = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.06, durationMs: 5000, seed: 14 });
      const windArtifacts = [{ type: 'wind', atMs: 3000, durationMs: 14000, amplitude: 0.05 }];
      const main = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.06, durationMs: 20000, seed: 15, artifacts: windArtifacts });
      const r = runCalibrationAndDetector('wired', calib, main);
      assertNotEqual(r.quality.status, BreathingEngine.STATUS.GOOD, 'sustained wind should prevent a confident GOOD status');
    });

    log('8) 케이블 흔들림');
    test('cable movement: classified as artifact, not confirmed as a breath', function () {
      const frame = { rms: 0.05, zcr: 0.5, clippingRatio: 0, motionMagnitude: 4, timestampMs: 1000 };
      const artifact = BreathingEngine.classifyArtifact(frame, { previousRms: 0.01, noiseFloor: 0.01, motionSpikeThreshold: 1.5, recentZcrPeakRatePerSec: 0, ambientRatio: 1 });
      assertEqual(artifact, 'cable');
    });

    log('9) 호흡 없이 주변 소리만 있는 경우');
    test('ambient noise only, no breathing: Zone stays hidden (even past full threshold relaxation)', function () {
      // 45s comfortably spans THRESHOLD_RELAX_FULL_MS (30s) so this also proves relaxation
      // doesn't eventually mistake ambient jitter for breathing once fully relaxed.
      const calib = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0, durationMs: 5000, seed: 16 });
      const main = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0, durationMs: 45000, seed: 17 });
      const r = runCalibrationAndDetector('wired', calib, main);
      assertOk(!r.quality.canDisplayZone, 'no real breathing signal should never unlock Zone display');
    });

    log('1c) 회귀 테스트: 초기 임계값이 실제 호흡보다 살짝 높게 잡혀도, 시간이 지나면 결국 잡혀야 함');
    test('weak-but-real breathing below the initial threshold is eventually confirmed via relaxation', function () {
      // Reproduces a real bug report ("bpm이 안 나와"): peakThresholdMultiplier is an unvalidated
      // engineering guess, not something measured for this specific person/hardware. If a real
      // breather's actual signal sits just under that guess, the OLD static-threshold code would
      // never confirm a single breath, no matter how long the session ran - "--" forever. This
      // amplitude gives a breath peak ~1.5x the ambient floor - comfortably below the initial
      // 1.6x static threshold (would never fire under the old code), but should still be caught
      // once THRESHOLD_RELAX_START_MS/FULL_MS bring the effective multiplier down toward
      // MIN_PEAK_THRESHOLD_MULTIPLIER (1.25x).
      const calib = generateFrames({ breathsPerMin: 15, ambientRms: 0.02, breathAmplitude: 0.01, durationMs: 5000, seed: 201 });
      const main = generateFrames({ breathsPerMin: 15, ambientRms: 0.02, breathAmplitude: 0.01, durationMs: 40000, seed: 202 });
      const calibrator = BreathingEngine.createCalibrator('wired');
      calib.forEach((f) => calibrator.addFrame(f));
      const detector = new BreathingEngine.BreathingDetector('wired', calibrator.finalize());
      let firstBpmAtMs = null;
      main.forEach((f) => {
        const res = detector.pushFrame(f);
        if (firstBpmAtMs == null && res.breathsPerMin != null) firstBpmAtMs = f.timestampMs;
      });
      assertOk(firstBpmAtMs != null, 'a real (if weak) breathing signal must eventually produce a breaths/min number, not stay "--" forever');
    });

    log('10) 신호가 5초 이상 끊기는 경우');
    test('signal dropout >5s is detected and marks status UNAVAILABLE right after resuming', function () {
      const calib = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 5000, seed: 18 });
      const before = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 10000, seed: 19 });
      const after = generateFrames({ breathsPerMin: 15, ambientRms: 0.01, breathAmplitude: 0.08, durationMs: 3000, seed: 20 }).map(function (f) {
        return Object.assign({}, f, { timestampMs: f.timestampMs + 10000 + 6000 });
      });
      const calibrator = BreathingEngine.createCalibrator('wired');
      calib.forEach(function (f) { calibrator.addFrame(f); });
      const detector = new BreathingEngine.BreathingDetector('wired', calibrator.finalize());
      before.forEach(function (f) { detector.pushFrame(f); });
      detector.pushFrame(after[0]);
      const quality = detector.getQuality(after[0].timestampMs);
      assertEqual(quality.status, BreathingEngine.STATUS.UNAVAILABLE, 'a >5s gap should force UNAVAILABLE right after it is noticed');
    });

    log('Zone gating');
    test('canDisplayZone is false unless status is GOOD with enough confirmed events', function () {
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.MEASURING, 10), false);
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.GOOD, 1), false);
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.GOOD, 3), true);
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.INITIALIZING, 5), false);
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.CALIBRATING, 5), false);
      assertEqual(BreathingEngine.canDisplayZone(BreathingEngine.STATUS.UNAVAILABLE, 5), false);
    });

    log('Signal quality & Calibration requirements');
    test('calibrator computes and stores all 5 required metrics', function () {
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.1, durationMs: 5000, seed: 42 });
      const c = BreathingEngine.createCalibrator('wired');
      calib.forEach(function (f) { c.addFrame(f); });
      const profile = c.finalize();
      assertOk(typeof profile.ambientNoiseRms === 'number' && profile.ambientNoiseRms > 0, 'ambientNoiseRms');
      assertOk(typeof profile.ambientNoiseEnergy === 'number' && profile.ambientNoiseEnergy > 0, 'ambientNoiseEnergy');
      assertOk(typeof profile.meanBreathAmplitude === 'number' && profile.meanBreathAmplitude > 0, 'meanBreathAmplitude');
      assertOk(typeof profile.signalStdDev === 'number', 'signalStdDev');
      assertOk(typeof profile.maxInputRms === 'number' && profile.maxInputRms > 0, 'maxInputRms');
      assertOk(typeof profile.hasClipping === 'boolean', 'hasClipping');
    });

    test('pushFrame rejects invalid values (null, undefined, NaN, Infinity, <=0) safely', function () {
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.1, durationMs: 5000, seed: 43 });
      const c = BreathingEngine.createCalibrator('wired');
      calib.forEach(function (f) { c.addFrame(f); });
      const detector = new BreathingEngine.BreathingDetector('wired', c.finalize());

      const rNull = detector.pushFrame(null);
      assertEqual(rNull.confirmedBreath, false);
      assertEqual(rNull.artifact, 'invalid_data');

      const rNan = detector.pushFrame({ rms: NaN, zcr: 0.1, clippingRatio: 0, motionMagnitude: 0, timestampMs: 100 });
      assertEqual(rNan.confirmedBreath, false);
      assertEqual(rNan.artifact, 'invalid_data');

      const rInf = detector.pushFrame({ rms: Infinity, zcr: 0.1, clippingRatio: 0, motionMagnitude: 0, timestampMs: 200 });
      assertEqual(rInf.confirmedBreath, false);
      assertEqual(rInf.artifact, 'invalid_data');

      const rNeg = detector.pushFrame({ rms: -0.05, zcr: 0.1, clippingRatio: 0, motionMagnitude: 0, timestampMs: 300 });
      assertEqual(rNeg.confirmedBreath, false);
      assertEqual(rNeg.artifact, 'invalid_data');

      const q = detector.getQuality(400);
      assertOk(Number.isFinite(q.score), 'quality score must remain finite after invalid frames');
      assertOk(Number.isFinite(q.recentValidDataRatio), 'recentValidDataRatio should be finite');
    });

    test('STALE_EVENT_MS (9s) timeout marks status UNAVAILABLE and clears Zone', function () {
      const calib = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.1, durationMs: 5000, seed: 44 });
      const main = generateFrames({ breathsPerMin: 14, ambientRms: 0.01, breathAmplitude: 0.1, durationMs: 15000, seed: 45 });
      const c = BreathingEngine.createCalibrator('wired');
      calib.forEach(function (f) { c.addFrame(f); });
      const detector = new BreathingEngine.BreathingDetector('wired', c.finalize());
      main.forEach(function (f) { detector.pushFrame(f); });
      const lastMainTs = main[main.length - 1].timestampMs;
      // Advance by 10 seconds with no frames / no breaths
      const staleQuality = detector.getQuality(lastMainTs + 10000);
      assertEqual(staleQuality.status, BreathingEngine.STATUS.UNAVAILABLE, 'should be UNAVAILABLE after 9s of no breaths');
      assertEqual(staleQuality.canDisplayZone, false, 'canDisplayZone must be false when stale');
    });

    log('Validation-mode statistics');
    test('computeAgreementStats matches hand-computed MAE/RMSE/bias/LoA on a known set', function () {
      const records = [
        { predictedBpm: 16, referenceBpm: 15 },
        { predictedBpm: 20, referenceBpm: 18 },
        { predictedBpm: 12, referenceBpm: 14 },
        { predictedBpm: 25, referenceBpm: 22 },
      ];
      const stats = BreathingEngine.computeAgreementStats(records);
      assertEqual(stats.n, 4);
      assertOk(Math.abs(stats.mae - 2) < 1e-9);
      assertOk(Math.abs(stats.bias - 1) < 1e-9);
      assertOk(stats.rmse >= stats.mae, 'RMSE should never be smaller than MAE');
      assertOk(stats.loaLower < stats.bias && stats.bias < stats.loaUpper);
    });

    test('computeValidationReport groups by activity/device/quality independently', function () {
      const records = [
        { predictedBpm: 16, referenceBpm: 15, activity: 'running', deviceType: 'wired', quality: 'GOOD' },
        { predictedBpm: 20, referenceBpm: 18, activity: 'walking', deviceType: 'wireless', quality: 'MEASURING' },
        { predictedBpm: 12, referenceBpm: 14, activity: 'resting', deviceType: 'wired', quality: 'GOOD' },
      ];
      const report = BreathingEngine.computeValidationReport(records);
      assertEqual(report.overall.n, 3);
      assertEqual(report.byActivity.running.n, 1);
      assertEqual(report.byDevice.wired.n, 2);
      assertEqual(report.byQuality.GOOD.n, 2);
    });

    log('\n' + passed + ' passed, ' + failed + ' failed');
    return { passed: passed, failed: failed, failures: failures };
  }

  return { runAll: runAll, generateFrames: generateFrames };
});
