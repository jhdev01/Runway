// runway-spotify-levels — tiny macOS helper for Runway.
//
// Listens to ONE app's audio output (the Spotify app by default) with
// ScreenCaptureKit and prints only loudness readings, never the audio:
//
//   R                              capture started
//   L <wallMs> <durMs> <peak>      one line per audio buffer (~10–20 ms):
//                                  wall-clock start (ms since 1970),
//                                  length in ms, peak level 0…1
//   E <code> <message>             couldn't start / stopped; then exits
//
// The sound itself is discarded as soon as its peak is measured. Runway
// turns these readings into a waveform picture for the song editor.
// Exits when stdin closes (Runway quit or stopped it).

import Foundation
import ScreenCaptureKit
import CoreMedia

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ s: String) { print(s); fflush(stdout) }

let bundleId = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.spotify.client"

// Quit when Runway closes our stdin.
Thread.detachNewThread {
  while let _ = readLine(strippingNewline: true) {}
  exit(0)
}

final class LevelTap: NSObject, SCStreamOutput, SCStreamDelegate {
  var stream: SCStream?
  let queue = DispatchQueue(label: "runway.levels")

  func start() async {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
      guard let display = content.displays.first else { emit("E nodisplay No display found."); exit(2) }
      guard let app = content.applications.first(where: { $0.bundleIdentifier == bundleId }) else {
        emit("E noapp The app isn't running."); exit(3)
      }
      let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
      let cfg = SCStreamConfiguration()
      cfg.capturesAudio = true
      cfg.excludesCurrentProcessAudio = true
      cfg.sampleRate = 48000
      cfg.channelCount = 2
      // Video can't be switched off entirely; keep it as small and slow as possible.
      cfg.width = 2
      cfg.height = 2
      cfg.minimumFrameInterval = CMTime(value: 10, timescale: 1)
      cfg.showsCursor = false
      let s = SCStream(filter: filter, configuration: cfg, delegate: self)
      try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
      try await s.startCapture()
      stream = s
      emit("R")
    } catch {
      let ns = error as NSError
      let code = (ns.domain.contains("ScreenCaptureKit") && ns.code == -3801) ? "perm" : "fail"
      emit("E \(code) \(ns.domain) \(ns.code): \(ns.localizedDescription)")
      exit(1)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let ns = error as NSError
    emit("E stopped \(ns.domain) \(ns.code): \(ns.localizedDescription)")
    exit(4)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, sb.isValid else { return }
    let frames = CMSampleBufferGetNumSamples(sb)
    guard frames > 0 else { return }
    var rate = 48000.0
    if let fmt = CMSampleBufferGetFormatDescription(sb),
       let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee,
       asbd.mSampleRate > 0 {
      rate = asbd.mSampleRate
    }
    // Presentation time is on the host clock; convert to wall-clock ms.
    let pts = CMSampleBufferGetPresentationTimeStamp(sb)
    let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
    let ageSec = pts.isValid ? CMTimeGetSeconds(CMTimeSubtract(hostNow, pts)) : 0
    let wallMs = (Date().timeIntervalSince1970 - max(0, ageSec)) * 1000
    let durMs = Double(frames) / rate * 1000

    var peak: Float = 0
    do {
      try sb.withAudioBufferList { abl, _ in
        for buf in abl {
          guard let data = buf.mData else { continue }
          let n = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
          let p = data.bindMemory(to: Float.self, capacity: n)
          for i in 0..<n {
            let v = abs(p[i])
            if v > peak { peak = v }
          }
        }
      }
    } catch {
      return
    }
    emit(String(format: "L %.0f %.1f %.4f", wallMs, durMs, min(peak, 4)))
  }
}

let tap = LevelTap()
Task { await tap.start() }
dispatchMain()
